#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <uiautomation.h>
#include <wrl/client.h>
#include <wincrypt.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "win_shortcut.hpp"

using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;

namespace {
constexpr size_t maxTextBytes = 512 * 1024;
constexpr size_t maxClipboardBytes = 32 * 1024 * 1024;
constexpr std::array<int, 6> modifiers{VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, 'V'};
constexpr auto pasteDelay = 450ms;
using Revision = std::shared_ptr<std::atomic_uint64_t>;
std::atomic_uint64_t foregroundRevision = 0;

void CALLBACK windowChanged(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) {
    ++foregroundRevision;
}

void pumpMessages() {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

class FocusListener final : public IUIAutomationFocusChangedEventHandler {
    std::atomic_ulong references{1};
    const Revision revision;
public:
    explicit FocusListener(Revision counter) : revision(std::move(counter)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid != __uuidof(IUnknown) && iid != __uuidof(IUIAutomationFocusChangedEventHandler)) return E_NOINTERFACE;
        *out = static_cast<IUIAutomationFocusChangedEventHandler*>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --references;
        if (!count) delete this;
        return count;
    }
    HRESULT STDMETHODCALLTYPE HandleFocusChangedEvent(IUIAutomationElement*) override {
        ++*revision;
        return S_OK;
    }
};

DWORD parentProcess() {
    const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD parent = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID == GetCurrentProcessId()) {
                parent = entry.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parent;
}

std::optional<DWORD> integrity(DWORD pid) {
    const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return std::nullopt;
    HANDLE token = nullptr;
    const BOOL open = OpenProcessToken(process, TOKEN_QUERY, &token);
    CloseHandle(process);
    if (!open) return std::nullopt;
    DWORD size = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
    std::vector<BYTE> bytes(size);
    const bool read = size && GetTokenInformation(token, TokenIntegrityLevel, bytes.data(), size, &size);
    CloseHandle(token);
    if (!read) return std::nullopt;
    const auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(bytes.data())->Label.Sid;
    if (!IsValidSid(sid) || !*GetSidSubAuthorityCount(sid)) return std::nullopt;
    return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
}

bool knownBoolean(IUIAutomationElement* element, PROPERTYID id, bool expected) {
    VARIANT value{};
    const bool matched = SUCCEEDED(element->GetCurrentPropertyValueEx(id, TRUE, &value)) &&
        value.vt == VT_BOOL && (value.boolVal != VARIANT_FALSE) == expected;
    VariantClear(&value);
    return matched;
}

bool editable(IUIAutomationElement* element) {
    CONTROLTYPEID type = 0;
    if (FAILED(element->get_CurrentControlType(&type)) ||
        (type != UIA_EditControlTypeId && type != UIA_DocumentControlTypeId && type != UIA_ComboBoxControlTypeId) ||
        !knownBoolean(element, UIA_IsEnabledPropertyId, true) ||
        !knownBoolean(element, UIA_HasKeyboardFocusPropertyId, true) ||
        !knownBoolean(element, UIA_IsPasswordPropertyId, false)) return false;

    ComPtr<IUIAutomationValuePattern> value;
    BOOL readOnly = TRUE;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value) {
        return SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly;
    }
    ComPtr<IUIAutomationTextPattern> text;
    ComPtr<IUIAutomationTextRange> range;
    if (FAILED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) || !text ||
        FAILED(text->get_DocumentRange(&range)) || !range) return false;
    VARIANT attribute{};
    const auto result = range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &attribute);
    const bool writable = SUCCEEDED(result) && attribute.vt == VT_BOOL && attribute.boolVal == VARIANT_FALSE;
    VariantClear(&attribute);
    return writable;
}

bool caretOnly(IUIAutomationElement* element, HWND nativeFocus) {
    ComPtr<IUIAutomationTextPattern> text;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) && text) {
        ComPtr<IUIAutomationTextRangeArray> selection;
        ComPtr<IUIAutomationTextRange> range;
        int count = 0;
        int comparison = 0;
        return SUCCEEDED(text->GetSelection(&selection)) && selection &&
            SUCCEEDED(selection->get_Length(&count)) && count == 1 &&
            SUCCEEDED(selection->GetElement(0, &range)) && range &&
            SUCCEEDED(range->CompareEndpoints(TextPatternRangeEndpoint_Start, range.Get(),
                                             TextPatternRangeEndpoint_End, &comparison)) && comparison == 0;
    }

    // Standard Win32 edit controls may expose ValuePattern without TextPattern.
    UIA_HWND hwnd = nullptr;
    wchar_t windowClass[16]{};
    DWORD_PTR range = static_cast<DWORD_PTR>(-1);
    return SUCCEEDED(element->get_CurrentNativeWindowHandle(&hwnd)) && hwnd == nativeFocus &&
        GetClassNameW(nativeFocus, windowClass, ARRAYSIZE(windowClass)) &&
        std::wstring_view(windowClass) == L"Edit" &&
        SendMessageTimeoutW(nativeFocus, EM_GETSEL, 0, 0, SMTO_BLOCK | SMTO_ABORTIFHUNG, 150, &range) &&
        range != static_cast<DWORD_PTR>(-1) && LOWORD(range) == HIWORD(range);
}

struct Target {
    HWND window{};
    HWND nativeFocus{};
    DWORD pid{};
    ComPtr<IUIAutomationElement> element;
    uint64_t foreground{};
    uint64_t focus{};
};

std::optional<Target> capture(IUIAutomation* automation, DWORD parent) {
    Target target;
    target.window = GetForegroundWindow();
    if (!target.window) return std::nullopt;
    const auto thread = GetWindowThreadProcessId(target.window, &target.pid);
    GUITHREADINFO info{};
    info.cbSize = sizeof(info);
    if (!thread || !target.pid || target.pid == parent || target.pid == GetCurrentProcessId() ||
        !GetGUIThreadInfo(thread, &info) || !info.hwndFocus ||
        (info.flags & (GUI_INMENUMODE | GUI_INMOVESIZE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE))) return std::nullopt;
    target.nativeFocus = info.hwndFocus;
    if (FAILED(automation->GetFocusedElement(&target.element)) || !target.element) return std::nullopt;
    int pid = 0;
    if (FAILED(target.element->get_CurrentProcessId(&pid)) || pid <= 0 || static_cast<DWORD>(pid) != target.pid ||
        !editable(target.element.Get()) || !caretOnly(target.element.Get(), target.nativeFocus) ||
        target.window != GetForegroundWindow()) return std::nullopt;
    return target;
}

std::optional<std::wstring> decode(std::string_view encoded) {
    if (encoded.empty() || encoded.size() > ((maxTextBytes + 2) / 3) * 4 ||
        encoded.size() % 4 || encoded.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != encoded.npos) return std::nullopt;
    const auto length = static_cast<DWORD>(encoded.size());
    DWORD size = 0;
    if (!CryptStringToBinaryA(encoded.data(), length, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
                             nullptr, &size, nullptr, nullptr) || !size || size > maxTextBytes) return std::nullopt;
    std::string bytes(size, '\0');
    if (!CryptStringToBinaryA(encoded.data(), length, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
                             reinterpret_cast<BYTE*>(bytes.data()), &size, nullptr, nullptr) ||
        bytes.find('\0') != std::string::npos) return std::nullopt;
    const int len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(size), nullptr, 0);
    if (!len) return std::nullopt;
    std::wstring result(len, L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(size), result.data(), len) != len) return std::nullopt;
    return result;
}

struct ClipboardLock {
    const bool open;
    explicit ClipboardLock(HWND owner) : open(OpenClipboard(owner) != FALSE) {}
    ~ClipboardLock() { if (open) CloseClipboard(); }
};

bool byteFormat(UINT format) {
    switch (format) {
        case CF_TEXT: case CF_OEMTEXT: case CF_UNICODETEXT: case CF_LOCALE:
        case CF_DIB: case CF_DIBV5: case CF_HDROP: case CF_TIFF: return true;
        default: break;
    }
    wchar_t name[128]{};
    if (!GetClipboardFormatNameW(format, name, ARRAYSIZE(name))) return false;
    const std::wstring_view key(name);
    return key == L"HTML Format" || key == L"Rich Text Format" || key == L"Rich Text Format Without Objects" ||
           key == L"PNG" || key == L"JFIF" || key == L"GIF" || key == L"UniformResourceLocator" ||
           key == L"UniformResourceLocatorW" || key == L"CanIncludeInClipboardHistory" ||
           key == L"CanUploadToCloudClipboard" || key == L"ExcludeClipboardContentFromMonitorProcessing";
}

struct Format {
    UINT id;
    HANDLE data;
    Format(UINT id, HANDLE data) : id(id), data(data) {}
    Format(Format&& other) noexcept : id(other.id), data(std::exchange(other.data, nullptr)) {}
    Format(const Format&) = delete;
    ~Format() {
        if (data && (id == CF_BITMAP || id == CF_PALETTE)) DeleteObject(data);
        else if (data) GlobalFree(data);
    }
    bool write() {
        if (!SetClipboardData(id, data)) return false;
        data = nullptr;
        return true;
    }
};

std::optional<Format> formatBytes(UINT id, const void* bytes, size_t size) {
    if (!id) return std::nullopt;
    Format copy(id, GlobalAlloc(GMEM_MOVEABLE, size));
    if (!copy.data) return std::nullopt;
    void* dest = GlobalLock(copy.data);
    if (!dest) return std::nullopt;
    std::memcpy(dest, bytes, size);
    GlobalUnlock(copy.data);
    return copy;
}

std::optional<Format> saveFormat(UINT id, size_t& remaining) {
    if (!byteFormat(id) && id != CF_BITMAP && id != CF_PALETTE) return std::nullopt;
    const auto data = GetClipboardData(id);
    if (!data) return std::nullopt;
    if (id == CF_BITMAP || id == CF_PALETTE) {
        BITMAP bitmap{};
        if (id == CF_BITMAP) {
            if (!GetObjectW(data, sizeof(bitmap), &bitmap) || bitmap.bmHeight <= 0 || bitmap.bmWidthBytes <= 0) return std::nullopt;
            const auto size = static_cast<size_t>(bitmap.bmHeight) * bitmap.bmWidthBytes;
            if (size > remaining) return std::nullopt;
            remaining -= size;
        }
        const auto copy = OleDuplicateData(data, static_cast<CLIPFORMAT>(id), GMEM_MOVEABLE);
        if (!copy) return std::nullopt;
        return Format(id, copy);
    }
    const auto size = GlobalSize(data);
    if (!size || size > remaining) return std::nullopt;
    const auto bytes = GlobalLock(data);
    if (!bytes) return std::nullopt;
    auto result = formatBytes(id, bytes, size);
    GlobalUnlock(data);
    remaining -= size;
    return result;
}

class Clipboard {
    HWND owner;
    std::vector<Format> saved;
    std::optional<DWORD> staged;
    bool restored = true;

    bool restoreLocked() {
        if (!EmptyClipboard()) return false;
        bool success = true;
        for (auto& item : saved) if (!item.write()) success = false;
        return success;
    }

public:
    explicit Clipboard(HWND owner) : owner(owner) {}
    ~Clipboard() { (void)restore(); }

    bool restore() {
        if (!staged) return restored;
        for (int retry = 0; retry < 40 && GetClipboardSequenceNumber() == *staged; ++retry) {
            const ClipboardLock lock(owner);
            if (lock.open) {
                if (GetClipboardSequenceNumber() == *staged) restored = restoreLocked();
                staged.reset();
                return restored;
            }
            std::this_thread::sleep_for(25ms);
        }
        restored = GetClipboardSequenceNumber() != *staged;
        staged.reset();
        return restored;
    }

    bool stage(const std::wstring& text) {
        const ClipboardLock lock(owner);
        if (!lock.open) return false;
        const auto initial = GetClipboardSequenceNumber();
        auto remaining = maxClipboardBytes;
        for (UINT id = 0;;) {
            SetLastError(ERROR_SUCCESS);
            id = EnumClipboardFormats(id);
            if (!id) {
                if (GetLastError() != ERROR_SUCCESS) return false;
                break;
            }
            auto item = saveFormat(id, remaining);
            if (!item) return false;
            saved.push_back(std::move(*item));
        }
        const DWORD zero = 0;
        auto contents = formatBytes(CF_UNICODETEXT, text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        auto history = formatBytes(RegisterClipboardFormatW(L"CanIncludeInClipboardHistory"), &zero, sizeof(zero));
        auto cloud = formatBytes(RegisterClipboardFormatW(L"CanUploadToCloudClipboard"), &zero, sizeof(zero));
        if (!contents || !history || !cloud || GetClipboardSequenceNumber() != initial || !EmptyClipboard()) return false;
        if (!history->write() || !cloud->write() || !contents->write()) {
            restored = restoreLocked();
            return false;
        }
        staged = GetClipboardSequenceNumber();
        return true;
    }

    bool owned() const { return staged && GetClipboardSequenceNumber() == *staged; }
};

struct Response {
    const char* reason = nullptr;
    bool clipboardWarning = false;
    explicit Response(const char* reason = nullptr, bool clipboardWarning = false)
        : reason(reason), clipboardWarning(clipboardWarning) {}
};

class Bridge {
    const DWORD parent = parentProcess();
    const HWND owner = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    const HWINEVENTHOOK foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
                                                        windowChanged, 0, 0, WINEVENT_OUTOFCONTEXT);
    const Revision focusRevision = std::make_shared<std::atomic_uint64_t>(0);
    ComPtr<IUIAutomation2> automation;
    ComPtr<IUIAutomationFocusChangedEventHandler> listener;
    std::optional<Target> target;

    bool ready() const { return parent && owner && foreground && automation && listener; }

    bool revisionsMatch(const Target& expected) const {
        return foregroundRevision == expected.foreground && *focusRevision == expected.focus;
    }

    bool checkFocus(const Target& expected) {
        pumpMessages();
        if (!revisionsMatch(expected)) return false;
        const auto current = capture(automation.Get(), parent);
        BOOL same = FALSE;
        return current && current->window == expected.window && current->nativeFocus == expected.nativeFocus &&
            current->pid == expected.pid &&
            SUCCEEDED(automation->CompareElements(current->element.Get(), expected.element.Get(), &same)) &&
            same && revisionsMatch(expected);
    }

    const char* snapshot() {
        target.reset();
        if (!ready()) return "permission";
        pumpMessages();
        const auto win = foregroundRevision.load();
        const auto focus = focusRevision->load();
        auto candidate = capture(automation.Get(), parent);
        if (!candidate) return "target";
        const auto ours = integrity(GetCurrentProcessId());
        const auto theirs = integrity(candidate->pid);
        if (!ours || !theirs || *theirs > *ours || *theirs >= SECURITY_MANDATORY_HIGH_RID) return "permission";
        candidate->foreground = win;
        candidate->focus = focus;
        if (!checkFocus(*candidate)) return "target";
        target = std::move(candidate);
        return nullptr;
    }

    Response paste(std::string_view encoded) {
        const auto expected = std::exchange(target, std::nullopt);
        const auto text = decode(encoded);
        if (!text) return Response("invalid");
        if (!expected || !checkFocus(*expected)) return Response("changed");
        Clipboard clipboard(owner);
        const auto reason = clipboard.stage(*text) ? dispatchPaste(*expected, clipboard) : "clipboard";
        return Response(reason, !clipboard.restore());
    }

    const char* dispatchPaste(const Target& expected, const Clipboard& clipboard) {
        if (!checkFocus(expected) || std::any_of(modifiers.begin(), modifiers.end(), [](int key) {
            return (GetAsyncKeyState(key) & 0x8000) != 0;
        })) return "changed";
        if (!clipboard.owned()) return "clipboard";
        if (!revisionsMatch(expected) || GetForegroundWindow() != expected.window) return "changed";

        INPUT keys[4]{};
        for (auto& key : keys) key.type = INPUT_KEYBOARD;
        keys[0].ki.wVk = VK_CONTROL;
        keys[1].ki.wVk = 'V';
        keys[2].ki.wVk = 'V';
        keys[3].ki.wVk = VK_CONTROL;
        keys[2].ki.dwFlags = KEYEVENTF_KEYUP;
        keys[3].ki.dwFlags = KEYEVENTF_KEYUP;
        const auto sent = SendInput(ARRAYSIZE(keys), keys, sizeof(INPUT));
        if (sent && sent < ARRAYSIZE(keys)) {
            const size_t releaseFrom = sent == 2 ? 2 : 3;
            SendInput(static_cast<UINT>(ARRAYSIZE(keys) - releaseFrom), keys + releaseFrom, sizeof(INPUT));
        }
        // shortcut: SendInput only acknowledges queueing; wait briefly for the target to read.
        if (sent >= 2) std::this_thread::sleep_for(pasteDelay);
        return sent == ARRAYSIZE(keys) ? nullptr : "input";
    }

public:
    Bridge() {
        const auto init = CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
        if (FAILED(init) || !automation ||
            FAILED(automation->put_AutoSetFocus(FALSE)) ||
            FAILED(automation->put_ConnectionTimeout(350)) ||
            FAILED(automation->put_TransactionTimeout(350))) return;
        listener.Attach(new FocusListener(focusRevision));
        if (FAILED(automation->AddFocusChangedEventHandler(nullptr, listener.Get()))) listener.Reset();
    }

    ~Bridge() {
        if (listener) automation->RemoveFocusChangedEventHandler(listener.Get());
        if (foreground) UnhookWinEvent(foreground);
        if (owner) DestroyWindow(owner);
    }

    void poll() {
        pumpMessages();
        if (target && !checkFocus(*target)) target.reset();
    }

    Response run(std::string_view line) {
        if (line == "PERMISSION" || line == "REQUEST_PERMISSION") return Response(ready() ? nullptr : "permission");
        if (line == "RESET") { target.reset(); return Response(); }
        if (line == "SNAPSHOT") return Response(snapshot());
        if (line.substr(0, 6) == "PASTE ") return paste(line.substr(6));
        return Response("invalid");
    }
};

constexpr UINT shortcutEvent = WM_APP + 1;
WindowsKeyTap windowsTap;
HWND shortcutWindow = nullptr;

bool keyboardOrMouseHeld() {
    // The low-level hook sees this key down before the async key state changes.
    for (int key = 1; key < 0xFF; ++key) {
        if (GetAsyncKeyState(key) & 0x8000) return true;
    }
    return false;
}

bool suppressStart(const KBDLLHOOKSTRUCT& event) {
    // Balance the reserved dummy key, then release the real Win key so shell chords remain usable.
    INPUT keys[3]{};
    for (auto& key : keys) key.type = INPUT_KEYBOARD;
    keys[0].ki.wVk = keys[1].ki.wVk = 0xFF;
    keys[1].ki.dwFlags = KEYEVENTF_KEYUP;
    keys[2].ki.wVk = static_cast<WORD>(event.vkCode);
    keys[2].ki.wScan = static_cast<WORD>(event.scanCode);
    keys[2].ki.dwFlags = KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY;
    const auto sent = SendInput(ARRAYSIZE(keys), keys, sizeof(INPUT));
    if (sent == 1) SendInput(1, keys + 1, sizeof(INPUT));
    return sent == ARRAYSIZE(keys);
}

LRESULT CALLBACK shortcutKeyboard(int code, WPARAM message, LPARAM data) {
    if (code != HC_ACTION) return CallNextHookEx(nullptr, code, message, data);
    const auto& event = *reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    const bool win = event.vkCode == VK_LWIN || event.vkCode == VK_RWIN;
    if ((event.flags & LLKHF_INJECTED) || !win) {
        windowsTap.interrupt();
    } else if (event.flags & LLKHF_UP) {
        if (windowsTap.up(event.vkCode, event.time) && shortcutWindow &&
            shortcutWindow == GetForegroundWindow() && suppressStart(event)) {
            PostThreadMessageW(GetCurrentThreadId(), shortcutEvent, 0, 0);
            return 1;
        }
    } else {
        shortcutWindow = GetForegroundWindow();
        windowsTap.down(event.vkCode, event.time, keyboardOrMouseHeld());
    }
    return CallNextHookEx(nullptr, code, message, data);
}

LRESULT CALLBACK shortcutMouse(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && message != WM_MOUSEMOVE) windowsTap.interrupt();
    return CallNextHookEx(nullptr, code, message, data);
}

int watchShortcut() {
    const auto module = GetModuleHandleW(nullptr);
    const auto keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, shortcutKeyboard, module, 0);
    const auto mouse = keyboard ? SetWindowsHookExW(WH_MOUSE_LL, shortcutMouse, module, 0) : nullptr;
    if (!keyboard || !mouse) {
        const DWORD error = GetLastError();
        if (keyboard) UnhookWindowsHookEx(keyboard);
        std::cout << (error == ERROR_ACCESS_DENIED ? "PERMISSION" : "UNAVAILABLE") << std::endl;
        return 1;
    }

    std::atomic_bool eof = false;
    std::thread reader([&] {
        while (std::cin.get() != std::char_traits<char>::eof()) {}
        eof = true;
    });
    std::cout << "READY" << std::endl;
    while (!eof) {
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 100, QS_ALLINPUT);
        MSG message{};
        while (!eof && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == shortcutEvent) std::cout << "TRIGGER" << std::endl;
            else DispatchMessageW(&message);
        }
    }
    UnhookWindowsHookEx(mouse);
    UnhookWindowsHookEx(keyboard);
    reader.join();
    return 0;
}
}

int main(int argc, char* argv[]) {
    if (argc == 2 && std::string_view(argv[1]) == "--shortcut") return watchShortcut();
    const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return 1;
    {
        Bridge bridge;
        std::mutex mutex;
        std::condition_variable changed;
        std::optional<std::string> command;
        bool eof = false;
        std::thread reader([&] {
            std::string line;
            while (std::getline(std::cin, line)) {
                if (!line.empty() && line.back() == '\r') line.pop_back();
                std::unique_lock lock(mutex);
                changed.wait(lock, [&] { return !command; });
                command = std::move(line);
                changed.notify_one();
            }
            std::lock_guard lock(mutex);
            eof = true;
            changed.notify_one();
        });

        for (;;) {
            std::optional<std::string> line;
            {
                std::unique_lock lock(mutex);
                changed.wait_for(lock, 150ms, [&] { return command || eof; });
                if (eof && !command) break;
                line = std::exchange(command, std::nullopt);
                changed.notify_one();
            }
            bridge.poll();
            if (line) {
                const auto response = bridge.run(*line);
                if (response.reason) std::cout << "{\"ok\":false,\"reason\":\"" << response.reason << "\"";
                else std::cout << "{\"ok\":true";
                if (response.clipboardWarning) std::cout << ",\"warning\":\"clipboard\"";
                std::cout << '}' << std::endl;
            }
        }
        reader.join();
    }
    CoUninitialize();
}
