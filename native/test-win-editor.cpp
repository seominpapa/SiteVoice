#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cassert>
#include <string>

#include "win_editor.hpp"

static WNDPROC editProcedure;
static LRESULT CALLBACK withoutSelectionInfo(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == EM_GETSEL) return 0;
    return CallWindowProcW(editProcedure, window, message, wparam, lparam);
}

int main() {
    const auto instance = GetModuleHandleW(nullptr);
    const auto dialog = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 400, 300,
                                       nullptr, nullptr, instance, nullptr);
    const auto richEdit = LoadLibraryExW(L"Msftedit.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    assert(dialog && richEdit);
    auto make = [&](const wchar_t* type, DWORD style = 0) {
        const auto control = CreateWindowExW(0, type, L"x sample", WS_CHILD | style, 0, 0, 200, 30,
                                            dialog, nullptr, instance, nullptr);
        assert(control);
        return control;
    };
    const auto check = [&](HWND control) { return nativeEditor(control, dialog, GetCurrentProcessId()); };
    const auto edit = make(L"EDIT");
    const auto rich = make(L"RICHEDIT50W", ES_MULTILINE);
    for (const auto field : {edit, rich}) {
        SendMessageW(field, EM_SETSEL, 2, 2);
        assert(check(field) == NativeEditor::writable);
        SendMessageW(field, EM_SETSEL, 2, 4);
        assert(check(field) == NativeEditor::blocked);
        SendMessageW(field, EM_SETSEL, 2, 2);
        SendMessageW(field, EM_SETREADONLY, TRUE, 0);
        assert(check(field) == NativeEditor::blocked);
        SendMessageW(field, EM_SETREADONLY, FALSE, 0);
        EnableWindow(field, FALSE);
        assert(check(field) == NativeEditor::blocked);
    }
    assert(check(make(L"EDIT", ES_PASSWORD)) == NativeEditor::blocked);
    assert(check(make(L"STATIC")) == NativeEditor::unknown);
    const auto selectionUnavailable = make(L"EDIT");
    editProcedure = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(selectionUnavailable, GWLP_WNDPROC,
        reinterpret_cast<LONG_PTR>(withoutSelectionInfo)));
    assert(editProcedure);
    assert(check(selectionUnavailable) == NativeEditor::selectionUnavailable);
    SendMessageW(selectionUnavailable, EM_SETREADONLY, TRUE, 0);
    assert(check(selectionUnavailable) == NativeEditor::blocked);
    const auto multiline = make(L"EDIT", ES_MULTILINE);
    const std::wstring longText(70000, L'x');
    SendMessageW(multiline, EM_SETLIMITTEXT, longText.size(), 0);
    assert(SetWindowTextW(multiline, longText.c_str()));
    SendMessageW(multiline, EM_SETSEL, 68000, 68000);
    assert(check(multiline) == NativeEditor::writable);
    SendMessageW(multiline, EM_SETSEL, 68000, 69000);
    assert(check(multiline) == NativeEditor::blocked);
    assert(nativeEditor(multiline, nullptr, GetCurrentProcessId()) == NativeEditor::blocked);
    assert(nativeEditor(multiline, dialog, 0) == NativeEditor::blocked);
    DestroyWindow(dialog);
    FreeLibrary(richEdit);
}
