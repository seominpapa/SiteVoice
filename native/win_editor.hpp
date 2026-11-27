#pragma once

#include <windows.h>
#include <limits>

enum class NativeEditor { unknown, blocked, writable };

inline NativeEditor nativeEditor(HWND focus, HWND root, DWORD pid) {
    DWORD focusPid = 0;
    if (!focus || !root || !pid || !GetWindowThreadProcessId(focus, &focusPid) ||
        focusPid != pid || GetAncestor(focus, GA_ROOT) != root) return NativeEditor::blocked;

    wchar_t name[32]{};
    if (!GetClassNameW(focus, name, ARRAYSIZE(name))) return NativeEditor::blocked;
    // Win32 EDIT and the system Rich Edit controls, including Windows 11 Notepad.
    constexpr const wchar_t* classes[] = {
        L"Edit", L"RichEdit20A", L"RichEdit20W", L"RichEdit50W", L"RichEditD2D", L"RichEditD2DPT"
    };
    bool recognized = false;
    for (const auto type : classes) {
        if (CompareStringOrdinal(name, -1, type, -1, TRUE) == CSTR_EQUAL) {
            recognized = true;
            break;
        }
    }
    if (!recognized) return NativeEditor::unknown;
    SetLastError(ERROR_SUCCESS);
    const auto style = GetWindowLongPtrW(focus, GWL_STYLE);
    if ((!style && GetLastError() != ERROR_SUCCESS) || (style & (ES_PASSWORD | ES_READONLY)) ||
        !IsWindowEnabled(root) || !IsWindowEnabled(focus)) return NativeEditor::blocked;

    constexpr auto flags = SMTO_ABORTIFHUNG | SMTO_BLOCK;
    DWORD_PTR password = 0;
    if (!SendMessageTimeoutW(focus, EM_GETPASSWORDCHAR, 0, 0, flags, 150, &password) || password)
        return NativeEditor::blocked;
    // EM_GETSEL marshals both outputs across processes. Its packed return value
    // loses selections beyond 65,535 characters, and -1 can also mean success.
    constexpr auto unset = (std::numeric_limits<DWORD>::max)();
    DWORD start = unset, end = unset;
    DWORD_PTR ignored = 0;
    if (!SendMessageTimeoutW(focus, EM_GETSEL, reinterpret_cast<WPARAM>(&start),
                             reinterpret_cast<LPARAM>(&end), flags, 150, &ignored) ||
        start == unset || start != end) return NativeEditor::blocked;
    return NativeEditor::writable;
}
