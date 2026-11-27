// Windows paste probe. Run only in a disposable Windows desktop session:
// the test deliberately replaces the clipboard with synthetic data.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <array>
#include <cstring>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {
constexpr UINT commandMessage = WM_APP + 1;
constexpr wchar_t initialText[] = L"before [] after";
constexpr int caret = 8;
constexpr wchar_t original[] = L"original clipboard";
constexpr wchar_t sourceFormat[] = L"Chromium internal source URL";
constexpr char sourceUrl[] = "https://example.test/";
enum class Command : WPARAM { plain, chrome, read, close, invalid };
constexpr char isolatedArg[] = "--isolated-clipboard";
constexpr char childArg[] = "--private-standard-probe-child";

struct ScopedHandle {
    HANDLE value = nullptr;
    explicit ScopedHandle(HANDLE handle = nullptr) : value(handle) {}
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
    ~ScopedHandle() { if (value) CloseHandle(value); }
};

std::optional<DWORD> integrity(HANDLE token) {
    DWORD size = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
    if (!size) return std::nullopt;
    std::vector<BYTE> bytes(size);
    if (!GetTokenInformation(token, TokenIntegrityLevel, bytes.data(), size, &size)) return std::nullopt;
    const auto sid = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(bytes.data())->Label.Sid;
    if (!IsValidSid(sid) || !*GetSidSubAuthorityCount(sid)) return std::nullopt;
    return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
}

bool restrictToMedium(HANDLE originalToken, HANDLE* token) {
    alignas(DWORD) BYTE admins[SECURITY_MAX_SID_SIZE]{};
    DWORD adminsSize = sizeof(admins);
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admins, &adminsSize)) return false;
    SID_AND_ATTRIBUTES denied{admins, 0};
    if (!CreateRestrictedToken(originalToken, DISABLE_MAX_PRIVILEGE, 1, &denied, 0, nullptr, 0, nullptr, token))
        return false;

    alignas(DWORD) BYTE medium[SECURITY_MAX_SID_SIZE]{};
    DWORD mediumSize = sizeof(medium);
    if (!CreateWellKnownSid(WinMediumLabelSid, nullptr, medium, &mediumSize)) return false;
    TOKEN_MANDATORY_LABEL label{{medium, SE_GROUP_INTEGRITY}};
    return SetTokenInformation(*token, TokenIntegrityLevel, &label, sizeof(label) + mediumSize) != FALSE;
}

bool pipeForChild(DWORD which, HANDLE* result) {
    const auto pipe = GetStdHandle(which);
    if (pipe == INVALID_HANDLE_VALUE || !pipe || GetFileType(pipe) != FILE_TYPE_PIPE) return false;
    const auto self = GetCurrentProcess();
    return DuplicateHandle(self, pipe, self, result, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}

int fail(std::string_view stage, DWORD error = 0) {
    std::cout << "{\"ready\":false,\"stage\":\"" << stage << '"';
    if (error) std::cout << ",\"win32Error\":" << error;
    std::cout << '}' << std::endl;
    return 1;
}

int startStandardChild(HANDLE token) {
    ScopedHandle input, output, error;
    if (!pipeForChild(STD_INPUT_HANDLE, &input.value) || !pipeForChild(STD_OUTPUT_HANDLE, &output.value) ||
            !pipeForChild(STD_ERROR_HANDLE, &error.value)) return fail("standard-child-pipes");
    std::array<HANDLE, 3> handles{input.value, output.value, error.value};
    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    if (!attributeSize) return fail("child-attributes-size", GetLastError());
    std::vector<BYTE> attributes(attributeSize);
    const auto list = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &attributeSize)) return fail("child-attributes", GetLastError());
    struct DeleteAttributes {
        PPROC_THREAD_ATTRIBUTE_LIST value;
        ~DeleteAttributes() { DeleteProcThreadAttributeList(value); }
    } deleteAttributes{list};
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.data(),
                                  sizeof(HANDLE) * handles.size(), nullptr, nullptr))
        return fail("child-pipe-list", GetLastError());

    std::wstring modulePath(32768, L'\0');
    const auto capacity = static_cast<DWORD>(modulePath.size());
    const auto length = GetModuleFileNameW(nullptr, modulePath.data(), capacity);
    if (!length || length >= capacity) return fail("fixture-module-path", GetLastError());
    modulePath.resize(length);
    std::wstring command = L"\"" + modulePath + L"\" --isolated-clipboard --private-standard-probe-child";
    wchar_t desktop[] = L"winsta0\\default";
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.lpDesktop = desktop;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = error.value;
    startup.lpAttributeList = list;
    PROCESS_INFORMATION process{};
    constexpr DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED;
    if (!CreateProcessAsUserW(token, modulePath.c_str(), command.data(), nullptr, nullptr, TRUE, flags,
                             nullptr, nullptr, &startup.StartupInfo, &process))
        return fail("start-standard-child", GetLastError());
    ScopedHandle child(process.hProcess), thread(process.hThread);
    ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job.value && SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        AssignProcessToJobObject(job.value, child.value); // Stdin EOF still applies if the runner's job blocks this.
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
        const auto cause = GetLastError();
        TerminateProcess(child.value, 1);
        return fail("resume-standard-child", cause);
    }
    DWORD result = 1;
    if (WaitForSingleObject(child.value, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.value, &result))
        return fail("wait-standard-child", GetLastError());
    return result == 0 ? 0 : 1;
}

bool active(HWND window, HWND editor) {
    return IsWindowVisible(window) && GetForegroundWindow() == window && GetFocus() == editor;
}

bool focusEditor(HWND window, HWND editor) {
    // Node may supply SW_HIDE for startup to suppress the console window.
    // Windows applies that value to the first ShowWindow call only.
    ShowWindow(window, SW_SHOW);
    if (!IsWindowVisible(window)) ShowWindow(window, SW_SHOW);
    for (int attempt = 0; attempt < 10; ++attempt) {
        SetForegroundWindow(window);
        SetFocus(editor);
        if (active(window, editor)) return true;
        Sleep(20);
    }
    return false;
}

bool openClipboard(HWND window) {
    // Keep unrelated clipboard listeners from making the fixture flaky.
    for (int attempt = 0; attempt < 10; ++attempt) {
        if (OpenClipboard(window)) return true;
        Sleep(20);
    }
    return false;
}

bool writeClipboard(UINT format, const void* bytes, SIZE_T size) {
    const auto handle = GlobalAlloc(GMEM_MOVEABLE, size);
    if (!handle) return false;
    const auto dest = GlobalLock(handle);
    if (dest) {
        std::memcpy(dest, bytes, size);
        GlobalUnlock(handle);
        if (SetClipboardData(format, handle)) return true;
    }
    GlobalFree(handle);
    return false;
}

bool clipboardMatches(UINT format, const void* expected, SIZE_T size) {
    const auto handle = GetClipboardData(format);
    if (!handle || GlobalSize(handle) < size) return false;
    const auto bytes = GlobalLock(handle);
    if (!bytes) return false;
    const bool matches = std::memcmp(bytes, expected, size) == 0;
    GlobalUnlock(handle);
    return matches;
}

bool prepare(HWND window, HWND editor, UINT format, bool chrome) {
    if (!active(window, editor) || !SetWindowTextW(editor, initialText)) return false;
    SendMessageW(editor, EM_SETSEL, caret, caret);
    if (!openClipboard(window)) return false;
    const bool ok = EmptyClipboard() && writeClipboard(CF_UNICODETEXT, original, sizeof(original)) &&
        (!chrome || writeClipboard(format, sourceUrl, sizeof(sourceUrl)));
    return CloseClipboard() && ok && active(window, editor);
}

std::string jsonString(std::wstring_view text) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (const auto unit : text) {
        if (unit == L'"' || unit == L'\\') {
            result += '\\';
            result += static_cast<char>(unit);
        } else if (unit >= 32 && unit <= 126) {
            result += static_cast<char>(unit);
        } else {
            result += "\\u";
            for (int offset = 12; offset >= 0; offset -= 4) result += hex[(unit >> offset) & 0xf];
        }
    }
    return result + '"';
}

void readResult(HWND window, HWND editor, UINT format) {
    wchar_t contents[512]{};
    const auto capacity = static_cast<int>(ARRAYSIZE(contents));
    const auto length = GetWindowTextW(editor, contents, capacity);
    if (!length || length == capacity - 1) {
        std::cout << R"({"ok":false,"stage":"read-editor"})" << std::endl;
        return;
    }
    if (!openClipboard(window)) {
        std::cout << R"({"ok":false,"stage":"read-clipboard"})" << std::endl;
        return;
    }
    const bool restored = clipboardMatches(CF_UNICODETEXT, original, sizeof(original));
    const bool preservedUrl = clipboardMatches(format, sourceUrl, sizeof(sourceUrl));
    if (!CloseClipboard()) {
        std::cout << R"({"ok":false,"stage":"close-clipboard"})" << std::endl;
        return;
    }
    std::cout << "{\"ok\":true,\"text\":" << jsonString({contents, static_cast<size_t>(length)})
              << ",\"original\":" << (restored ? "true" : "false")
              << ",\"sourceUrl\":" << (preservedUrl ? "true" : "false") << '}' << std::endl;
}

Command parse(std::string_view line) {
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    if (line == "PLAIN") return Command::plain;
    if (line == "CHROME") return Command::chrome;
    if (line == "READ") return Command::read;
    if (line == "CLOSE") return Command::close;
    return Command::invalid;
}

void readCommands(DWORD thread) {
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto command = parse(line);
        if (!PostThreadMessageW(thread, commandMessage, static_cast<WPARAM>(command), 0) ||
            command == Command::close) return;
    }
    PostThreadMessageW(thread, commandMessage, static_cast<WPARAM>(Command::close), 0);
}

}

int main(int argc, char** argv) {
    const bool child = argc == 3 && std::string_view(argv[2]) == childArg;
    if ((argc != 2 && !child) || std::string_view(argv[1]) != isolatedArg) return fail("isolated-desktop-required");
    ScopedHandle selfToken;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &selfToken.value))
        return fail("query-token", GetLastError());
    const auto level = integrity(selfToken.value);
    if (!level) return fail("query-integrity", GetLastError());
    if (*level >= SECURITY_MANDATORY_HIGH_RID) {
        if (child) return fail("standard-child-is-elevated"); // Never recurse or create an elevated test editor.
        ScopedHandle originalToken, restrictedToken;
        constexpr DWORD access = TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT;
        if (!OpenProcessToken(GetCurrentProcess(), access, &originalToken.value) ||
                !restrictToMedium(originalToken.value, &restrictedToken.value))
            return fail("restrict-fixture-token", GetLastError());
        return startStandardChild(restrictedToken.value);
    }
    if (child && *level > SECURITY_MANDATORY_MEDIUM_RID) return fail("standard-child-above-medium");
    const auto instance = GetModuleHandleW(nullptr);
    const auto window = CreateWindowExW(0, L"STATIC", L"SiteVoice Windows paste probe", WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 440, 165, nullptr, nullptr, instance, nullptr);
    const auto editor = window ? CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", initialText,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL, 15, 15, 385, 25,
        window, nullptr, instance, nullptr) : nullptr;
    if (!editor) return fail("create-editor");
    if (!focusEditor(window, editor)) return fail("foreground-focus");
    SendMessageW(editor, EM_SETSEL, caret, caret);
    const auto format = RegisterClipboardFormatW(sourceFormat);
    if (!format) return fail("register-format");

    MSG message{};
    PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
    std::thread reader(readCommands, GetCurrentThreadId());
    std::cout << "{\"ready\":true,\"integrity\":" << *level << '}' << std::endl;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message != commandMessage || message.hwnd) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }
        const auto command = static_cast<Command>(message.wParam);
        if (command == Command::close) break;
        if (command == Command::read) readResult(window, editor, format);
        else if (command == Command::invalid) std::cout << R"({"ok":false,"stage":"command"})" << std::endl;
        else if (!active(window, editor)) std::cout << R"({"ok":false,"stage":"lost-editor-focus"})" << std::endl;
        else if (!prepare(window, editor, format, command == Command::chrome))
            std::cout << R"({"ok":false,"stage":"prepare-editor-clipboard"})" << std::endl;
        else std::cout << R"({"ok":true})" << std::endl;
    }
    DestroyWindow(window);
    reader.join();
}
