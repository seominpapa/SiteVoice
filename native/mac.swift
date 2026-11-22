import AppKit
import ApplicationServices
import Carbon

private let maxTextBytes = 512 * 1024
private let maxClipboardBytes = 32 * 1024 * 1024
private let modifiers: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]

private typealias AttributeRead = (status: AXError, value: CFTypeRef?)

private func readAttribute(_ e: AXUIElement, _ name: String) -> AttributeRead {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(e, name as CFString, &value)
    return (status, status == .success ? value : nil)
}

private func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = readAttribute(e, name).value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func acceptsFocusedEditor(read: (String) -> AttributeRead, isValueWritable: () -> Bool) -> Bool {
    guard let role = read(kAXRoleAttribute).value as? String,
          [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
          read(kAXSubroleAttribute).value as? String != kAXSecureTextFieldSubrole,
          read("AXProtectedContent").value as? Bool != true else { return false }

    let enabled = read(kAXEnabledAttribute)
    // Native text views such as TextEdit may omit AXEnabled even while accepting input.
    // Missing support is safe to consider only with separate proof of editability and a caret.
    guard enabled.status == .attributeUnsupported ||
          (enabled.status == .success && enabled.value as? Bool == true),
          isValueWritable() || read("AXEditable").value as? Bool == true,
          let selection = read(kAXSelectedTextRangeAttribute).value,
          CFGetTypeID(selection) == AXValueGetTypeID() else { return false }

    var range = CFRange()
    return AXValueGetValue(unsafeBitCast(selection, to: AXValue.self), .cfRange, &range)
        && range.location >= 0 && range.length == 0
}

private struct Target {
    let pid: pid_t
    let app: AXUIElement
    let window: AXUIElement
    let focus: AXUIElement

    static func current() -> Target? {
        guard !IsSecureEventInputEnabled(),
              let front = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = front.processIdentifier
        guard pid != getppid(), pid != getpid() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(app, 0.12) == .success,
              let window = element(app, kAXFocusedWindowAttribute),
              let focus = element(app, kAXFocusedUIElementAttribute),
              AXUIElementSetMessagingTimeout(focus, 0.12) == .success else { return nil }
        guard acceptsFocusedEditor(read: { readAttribute(focus, $0) }, isValueWritable: {
            var settable = DarwinBoolean(false)
            return AXUIElementIsAttributeSettable(focus, kAXValueAttribute as CFString, &settable) == .success
                && settable.boolValue
        }) else { return nil }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return nil }
        return Target(pid: pid, app: app, window: window, focus: focus)
    }

    func stillFocused() -> Bool {
        guard let current = Target.current() else { return false }
        return current.pid == pid && CFEqual(window, current.window) && CFEqual(focus, current.focus)
    }
}

private struct Clipboard {
    let board: NSPasteboard
    let items: [NSPasteboardItem]
    let initial: Int

    init?(_ board: NSPasteboard) {
        self.board = board
        initial = board.changeCount
        var saved: [NSPasteboardItem] = []
        var total = 0
        guard let source = board.pasteboardItems, let types = board.types,
              !source.isEmpty || types.isEmpty else { return nil }
        for item in source {
            let snapshot = NSPasteboardItem()
            guard !item.types.isEmpty else { return nil }
            for type in item.types {
                let name = type.rawValue.lowercased()
                guard !name.contains("filepromise"), !name.contains("file-promise"),
                      let data = item.data(forType: type), data.count <= maxClipboardBytes - total,
                      snapshot.setData(data, forType: type) else { return nil }
                total += data.count
            }
            saved.append(snapshot)
        }
        guard board.changeCount == initial else { return nil }
        items = saved
    }

    func stage(_ text: String) -> (Bool, Int?) {
        let item = NSPasteboardItem()
        guard item.setString(text, forType: .string),
              item.setData(Data(), forType: .init("org.nspasteboard.TransientType")),
              item.setData(Data(), forType: .init("org.nspasteboard.ConcealedType")),
              board.changeCount == initial else { return (false, nil) }
        let own = board.prepareForNewContents(with: .currentHostOnly)
        return (board.writeObjects([item]), own)
    }

    func restore(_ own: Int) -> Bool {
        // shortcut: AppKit has no compare-and-swap for clipboard writes; check ownership just before clearing.
        guard board.changeCount == own else { return true }
        _ = board.prepareForNewContents(with: .currentHostOnly)
        return items.isEmpty || board.writeObjects(items)
    }
}

private struct Response: Encodable {
    let ok: Bool
    let reason: String?
    let warning: String?
    static let success = Response(ok: true, reason: nil, warning: nil)
    static func blocked(_ reason: String) -> Response { Response(ok: false, reason: reason, warning: nil) }
    func restored(_ success: Bool) -> Response {
        success ? self : Response(ok: ok, reason: reason, warning: "clipboard")
    }
}

private final class Bridge {
    private var target: Target?
    private var observer: AXObserver?
    private var timer: Timer?
    private var activation: NSObjectProtocol?

    private func reset() {
        target = nil
        timer?.invalidate()
        timer = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil
    }

    private func hasPermission() -> Bool { AXIsProcessTrusted() && CGPreflightPostEventAccess() }

    private func watch(_ snap: Target) -> Bool {
        var candidate: AXObserver?
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        guard AXObserverCreate(snap.pid, { _, _, _, ctx in
            if let ctx { Unmanaged<Bridge>.fromOpaque(ctx).takeUnretainedValue().invalidateTarget() }
        }, &candidate) == .success, let candidate else { return false }
        for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] {
            guard AXObserverAddNotification(candidate, snap.app, name as CFString, ctx) == .success else { return false }
        }
        observer = candidate
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(candidate), .commonModes)
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.processIdentifier != snap.pid { self?.invalidateTarget() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            if self?.target?.stillFocused() == false { self?.invalidateTarget() }
        }
        return true
    }

    private func invalidateTarget() { target = nil }

    private func snapshot() -> Response {
        reset()
        guard hasPermission() else { return .blocked("permission") }
        guard let candidate = Target.current() else { return .blocked("target") }
        guard watch(candidate), candidate.stillFocused() else {
            reset()
            return .blocked("target")
        }
        target = candidate
        return .success
    }

    private func paste(_ encoded: Substring) -> Response {
        defer { reset() }
        guard encoded.utf8.count <= ((maxTextBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: String(encoded)), data.count <= maxTextBytes,
              let text = String(data: data, encoding: .utf8), !text.isEmpty, !text.contains("\0") else {
            return .blocked("invalid")
        }
        guard let target else { return .blocked("changed") }
        guard hasPermission() else { return .blocked("permission") }
        guard target.stillFocused() else { return .blocked("changed") }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false) else {
            return .blocked("input")
        }
        let board = NSPasteboard.general
        if #available(macOS 15.4, *), board.accessBehavior == .alwaysDeny { return .blocked("clipboard") }
        guard let clipboard = Clipboard(board) else { return .blocked("clipboard") }
        let (result, own) = clipboard.stage(text)
        guard let own else { return .blocked("clipboard") }
        let reply = result ? dispatchPaste(target: target, board: board, own: own, down: down, up: up) : .blocked("clipboard")
        return reply.restored(clipboard.restore(own))
    }

    private func dispatchPaste(target: Target, board: NSPasteboard, own: Int, down: CGEvent, up: CGEvent) -> Response {
        guard target.stillFocused(), CGEventSource.flagsState(.combinedSessionState).intersection(modifiers).isEmpty,
              !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_ANSI_V)) else {
            return .blocked("changed")
        }
        guard board.changeCount == own else { return .blocked("clipboard") }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(target.pid)
        up.postToPid(target.pid)
        // shortcut: there is no paste acknowledgment; leave a brief window for the receiver to read.
        Thread.sleep(forTimeInterval: 0.45)
        return .success
    }

    func run(_ line: String) -> Response {
        if line == "PERMISSION" { return hasPermission() ? .success : .blocked("permission") }
        if line == "REQUEST_PERMISSION" {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            let trusted = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            return trusted && (CGPreflightPostEventAccess() || CGRequestPostEventAccess()) ? .success : .blocked("permission")
        }
        if line == "RESET" { reset(); return .success }
        if line == "SNAPSHOT" { return snapshot() }
        if line.hasPrefix("PASTE ") { return paste(line.dropFirst(6)) }
        return .blocked("invalid")
    }
}

private struct FnTap {
    private var started: CGEventTimestamp?
    private var held = false
    private let maxDuration: CGEventTimestamp = 450_000_000

    mutating func interrupt() { started = nil }

    mutating func reset(held: Bool) {
        self.held = held
        interrupt()
    }

    mutating func edge(down: Bool, time: CGEventTimestamp, alone: Bool, physical: Bool) -> Bool {
        guard physical else { interrupt(); return false }
        if down {
            started = !held && alone ? time : nil
            held = true
            return false
        }
        defer { reset(held: false) }
        guard alone, let started, time >= started else { return false }
        return time - started <= maxDuration
    }
}

private func shortcutOutput(_ status: String) {
    FileHandle.standardOutput.write(Data((status + "\n").utf8))
}

private final class ShortcutMonitor {
    private var gesture = FnTap()
    private var tap: CFMachPort?
    private let functionKey = CGKeyCode(kVK_Function)

    func start() -> String {
        guard CGPreflightListenEventAccess() else { return "PERMISSION" }
        let types: [CGEventType] = [.flagsChanged, .keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        let mediaMask = CGEventMask(1) << NSEvent.EventType.systemDefined.rawValue
        let mask = types.reduce(mediaMask) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                           eventsOfInterest: mask, callback: { _, type, event, context in
            if let context {
                Unmanaged<ShortcutMonitor>.fromOpaque(context).takeUnretainedValue().observe(type, event)
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { return "UNAVAILABLE" }
        tap = port
        reset()
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return "READY"
    }

    func reset() {
        gesture.reset(held: CGEventSource.flagsState(.hidSystemState).contains(.maskSecondaryFn))
    }

    func stop() {
        if let tap { CFMachPortInvalidate(tap) }
    }

    private func observe(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            reset()
            if !CGPreflightListenEventAccess() {
                shortcutOutput("PERMISSION")
                CFRunLoopStop(CFRunLoopGetMain())
            } else if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return
        }
        guard type == .flagsChanged,
              event.getIntegerValueField(.keyboardEventKeycode) == Int64(functionKey) else { gesture.interrupt(); return }
        // Quartz exposes the logical Fn/Globe key, and cannot identify a remapped physical key.
        let physical = event.getIntegerValueField(.eventSourceUnixProcessID) == 0
        let down = event.flags.contains(.maskSecondaryFn)
        let noModifiers = event.flags.intersection(modifiers).isEmpty
        let alone = physical && noModifiers && !IsSecureEventInputEnabled() && (!down || !(0..<128).contains {
            let key = CGKeyCode($0)
            return key != functionKey && key != CGKeyCode(kVK_CapsLock) && CGEventSource.keyState(.hidSystemState, key: key)
        })
        if gesture.edge(down: down, time: event.timestamp, alone: alone, physical: physical) { shortcutOutput("TRIGGER") }
    }
}

private func runShortcutMonitor() {
    let listener = ShortcutMonitor()
    let status = listener.start()
    shortcutOutput(status)
    guard status == "READY" else { return }
    let center = NSWorkspace.shared.notificationCenter
    let observers = [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification,
                     NSWorkspace.sessionDidBecomeActiveNotification, NSWorkspace.didWakeNotification].map { event in
        center.addObserver(forName: event, object: nil, queue: .main) { _ in listener.reset() }
    }
    defer {
        listener.stop()
        observers.forEach(center.removeObserver)
    }
    DispatchQueue.global().async {
        while readLine() != nil {}
        DispatchQueue.main.async { CFRunLoopStop(CFRunLoopGetMain()) }
    }
    CFRunLoopRun()
}

private func testShortcut() {
    var tap = FnTap()
    func edge(_ down: Bool, _ ms: UInt64, alone: Bool = true, physical: Bool = true) -> Bool {
        tap.edge(down: down, time: ms * 1_000_000, alone: alone, physical: physical)
    }
    tap.reset(held: true)
    precondition(!edge(true, 10) && !edge(false, 12)) // Startup while held.
    precondition(!edge(true, 21) && edge(false, 130))
    precondition(!edge(true, 200) && !edge(false, 651))
    precondition(!edge(true, 700, alone: false) && !edge(false, 750))
    precondition(!edge(true, 800) && !edge(true, 810) && !edge(true, 820) && !edge(false, 850))
    precondition(!edge(true, 900) && !edge(false, 950, alone: false))
    precondition(!edge(true, 1000))
    tap.interrupt() // An unrelated keyboard event.
    precondition(!edge(true, 1050) && !edge(false, 1090))
    precondition(!edge(true, 1110) && !edge(false, 1109))
    precondition(!edge(true, 1200, physical: false) && !edge(false, 1250))
    precondition(!edge(true, 1300) && !edge(false, 1330, physical: false) && !edge(false, 1350))
    precondition(!edge(true, 1400) && edge(false, 1440))
    shortcutOutput("ok")
}

private func testEditorTarget() {
    var insertionRange = CFRange(location: 0, length: 0)
    var selectedRange = CFRange(location: 0, length: 3)
    let caret = AXValueCreate(.cfRange, &insertionRange)!
    let selection = AXValueCreate(.cfRange, &selectedRange)!
    func eligible(role: String = kAXTextAreaRole, subrole: String? = nil, protectedContent: Bool = false,
                  enabled: AttributeRead = (.attributeUnsupported, nil), writable: Bool = true,
                  range: CFTypeRef? = caret) -> Bool {
        acceptsFocusedEditor(read: { name in
            switch name {
            case kAXRoleAttribute: return (.success, role as CFString)
            case kAXSubroleAttribute: return subrole.map { (.success, $0 as CFString) } ?? (.noValue, nil)
            case "AXProtectedContent": return (.success, protectedContent ? kCFBooleanTrue : kCFBooleanFalse)
            case kAXEnabledAttribute: return enabled
            case kAXSelectedTextRangeAttribute: return range.map { (.success, $0) } ?? (.noValue, nil)
            default: return (.attributeUnsupported, nil)
            }
        }, isValueWritable: { writable })
    }
    precondition(eligible()) // The native TextEdit editor exposes no AXEnabled attribute.
    precondition(eligible(enabled: (.success, kCFBooleanTrue))) // Existing browser editor path.
    precondition(!eligible(enabled: (.success, kCFBooleanFalse)))
    precondition(!eligible(enabled: (.cannotComplete, nil)))
    precondition(!eligible(enabled: (.noValue, nil)))
    precondition(!eligible(writable: false))
    precondition(!eligible(range: selection) && !eligible(range: nil))
    precondition(!eligible(role: kAXStaticTextRole))
    precondition(!eligible(role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole))
    precondition(!eligible(protectedContent: true))
    shortcutOutput("ok")
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--shortcut"] {
    runShortcutMonitor()
} else if arguments == ["--request-shortcut-permission"] {
    shortcutOutput(CGPreflightListenEventAccess() || CGRequestListenEventAccess() ? "READY" : "PERMISSION")
} else if arguments == ["--test-shortcut"] {
    testShortcut()
} else if arguments == ["--test-editor-target"] {
    testEditorTarget()
} else if arguments == ["--test-pasteboard"] {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let type = NSPasteboard.PasteboardType("voiceinput.test")
    let empty = Clipboard(board)!
    let (stagedOnEmpty, temporary) = empty.stage("임시")
    precondition(stagedOnEmpty && empty.restore(temporary!) && board.pasteboardItems?.isEmpty == true)
    let original = NSPasteboardItem()
    precondition(original.setString("원본", forType: .string))
    precondition(original.setData(Data([2, 4, 6]), forType: type))
    precondition(board.writeObjects([original]))
    let snapshot = Clipboard(board)!
    let (staged, first) = snapshot.stage("임시")
    precondition(staged && snapshot.restore(first!))
    precondition(board.string(forType: .string) == "원본" && board.data(forType: type) == Data([2, 4, 6]))
    let second = Clipboard(board)!
    let (stagedAgain, own) = second.stage("임시")
    precondition(stagedAgain)
    _ = board.clearContents()
    precondition(board.setString("새 클립보드", forType: .string))
    precondition(second.restore(own!) && board.string(forType: .string) == "새 클립보드")
    print("ok")
} else {
    let bridge = Bridge()
    DispatchQueue.global().async {
        while let line = readLine() {
            DispatchQueue.main.sync {
                let result = bridge.run(line)
                let bytes = try! JSONEncoder().encode(result)
                FileHandle.standardOutput.write(bytes + Data([10]))
            }
        }
        DispatchQueue.main.sync { exit(EXIT_SUCCESS) }
    }
    CFRunLoopRun()
}
