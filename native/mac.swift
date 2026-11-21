import AppKit
import ApplicationServices
import Carbon

private let maxTextBytes = 512 * 1024
private let maxClipboardBytes = 32 * 1024 * 1024
private let modifiers: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]

private func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success else { return nil }
    return value
}

private func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(e, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
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
              AXUIElementSetMessagingTimeout(focus, 0.12) == .success,
              let role = attribute(focus, kAXRoleAttribute) as? String,
              [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
              attribute(focus, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
              attribute(focus, "AXProtectedContent") as? Bool != true,
              attribute(focus, kAXEnabledAttribute) as? Bool == true else { return nil }

        var settable = DarwinBoolean(false)
        let editable = AXUIElementIsAttributeSettable(focus, kAXValueAttribute as CFString, &settable) == .success
            && settable.boolValue
        guard editable || attribute(focus, "AXEditable") as? Bool == true else { return nil }
        guard let selection = attribute(focus, kAXSelectedTextRangeAttribute),
              CFGetTypeID(selection) == AXValueGetTypeID() else { return nil }
        let selected = unsafeBitCast(selection, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetValue(selected, .cfRange, &range),
              range.location >= 0, range.length == 0 else { return nil }
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

if CommandLine.arguments.dropFirst().elementsEqual(["--test-pasteboard"]) {
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
