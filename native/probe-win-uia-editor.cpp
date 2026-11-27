// Interactive Windows fixture. The system EDIT handles actual keyboard input
// and pasting; a superclass replaces only the accessibility provider.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <ole2.h>
#include <oleauto.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <new>
#include <string>
#include <string_view>

using Microsoft::WRL::ComPtr;

namespace {
constexpr wchar_t editorClass[] = L"SiteVoiceUIAProbeEdit";
constexpr wchar_t windowClass[] = L"SiteVoiceUIAProbe";
constexpr wchar_t windowTitle[] = L"SiteVoice UIA editor probe";
constexpr wchar_t initialText[] = L"before  after";
constexpr int initialCaret = 7;
constexpr GUID probeRangeIid = {0x402acbaa, 0xbdea, 0x4cb6, {0x80, 0xc9, 0x72, 0xdb, 0x61, 0x08, 0x27, 0x65}};

enum class Mode { standard, missingEnabled, missingFocus, missingBoth, readOnly, password, selection };

struct Fixture {
    std::filesystem::path document;
    HWND editor{};
    WNDPROC editProc{};
    Mode mode = Mode::standard;
    ComPtr<IRawElementProviderSimple> providerRoot;
    ComPtr<IRawElementProviderSimple> providerField;
};
Fixture fixture;

bool omitted(Mode mode, PROPERTYID id) {
    return (id == UIA_IsEnabledPropertyId && (mode == Mode::missingEnabled || mode == Mode::missingBoth)) ||
        (id == UIA_HasKeyboardFocusPropertyId && (mode == Mode::missingFocus || mode == Mode::missingBoth));
}

std::wstring contents(HWND window) {
    const auto capacity = GetWindowTextLengthW(window) + 1;
    std::wstring value(static_cast<size_t>(capacity), L'\0');
    value.resize(static_cast<size_t>(GetWindowTextW(window, value.data(), capacity)));
    return value;
}

bool saveDocument(HWND window) {
    const auto value = contents(window);
    const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string utf8(static_cast<size_t>(size), '\0');
    if ((!value.empty() && !size) || (size && !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()), utf8.data(), size, nullptr, nullptr))) return false;
    std::ofstream file(fixture.document, std::ios::binary | std::ios::trunc);
    file.write(utf8.data(), size);
    file.close();
    return static_cast<bool>(file);
}

bool activeEditor(HWND window) {
    return GetForegroundWindow() == GetAncestor(window, GA_ROOT) && GetFocus() == window;
}

struct Range final : ITextRangeProvider {
    std::atomic_ulong refs{1};
    const ComPtr<IRawElementProviderSimple> owner;
    const HWND window;
    const LONG start;
    const LONG end;

    Range(IRawElementProviderSimple* owner, HWND window, LONG start, LONG end) :
        owner(owner), window(window), start(start), end(end) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (id != __uuidof(IUnknown) && id != __uuidof(ITextRangeProvider) && id != probeRangeIid)
            return E_NOINTERFACE;
        *out = static_cast<ITextRangeProvider*>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --refs;
        if (!count) delete this;
        return count;
    }

    HRESULT STDMETHODCALLTYPE Clone(ITextRangeProvider** out) override {
        *out = new (std::nothrow) Range(owner.Get(), window, start, end);
        return *out ? S_OK : E_OUTOFMEMORY;
    }
    HRESULT STDMETHODCALLTYPE Compare(ITextRangeProvider* target, BOOL* out) override {
        *out = FALSE;
        ComPtr<ITextRangeProvider> privateRange;
        if (!target || FAILED(target->QueryInterface(probeRangeIid, reinterpret_cast<void**>(privateRange.GetAddressOf()))))
            return E_INVALIDARG;
        const auto same = static_cast<Range*>(privateRange.Get());
        *out = window == same->window && start == same->start && end == same->end;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE CompareEndpoints(TextPatternRangeEndpoint a, ITextRangeProvider* target,
        TextPatternRangeEndpoint b, int* out) override {
        ComPtr<ITextRangeProvider> privateRange;
        if (!target || FAILED(target->QueryInterface(probeRangeIid, reinterpret_cast<void**>(privateRange.GetAddressOf()))))
            return E_INVALIDARG;
        const auto other = static_cast<Range*>(privateRange.Get());
        if (window != other->window) return E_INVALIDARG;
        *out = (a == TextPatternRangeEndpoint_Start ? start : end) -
            (b == TextPatternRangeEndpoint_Start ? other->start : other->end);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetAttributeValue(TEXTATTRIBUTEID id, VARIANT* out) override {
        VariantInit(out);
        if (id != UIA_IsReadOnlyAttributeId) {
            out->vt = VT_UNKNOWN;
            return UiaGetReservedNotSupportedValue(&out->punkVal);
        }
        out->vt = VT_BOOL;
        out->boolVal = (GetWindowLongPtrW(window, GWL_STYLE) & ES_READONLY) ? VARIANT_TRUE : VARIANT_FALSE;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetEnclosingElement(IRawElementProviderSimple** out) override {
        return owner.CopyTo(out);
    }
    HRESULT STDMETHODCALLTYPE GetText(int maxLength, BSTR* out) override {
        const auto text = contents(window);
        const auto first = (std::min)(static_cast<size_t>(start), text.size());
        const auto last = (std::min)(static_cast<size_t>(end), text.size());
        const auto length = maxLength < 0 ? last - first : (std::min)(last - first, static_cast<size_t>(maxLength));
        *out = SysAllocStringLen(text.data() + first, static_cast<UINT>(length));
        return *out ? S_OK : E_OUTOFMEMORY;
    }
    HRESULT STDMETHODCALLTYPE ExpandToEnclosingUnit(TextUnit) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE FindAttribute(TEXTATTRIBUTEID, VARIANT, BOOL, ITextRangeProvider**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE FindText(BSTR, BOOL, BOOL, ITextRangeProvider**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetBoundingRectangles(SAFEARRAY**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE Move(TextUnit, int, int*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE MoveEndpointByUnit(TextPatternRangeEndpoint, TextUnit, int, int*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE MoveEndpointByRange(TextPatternRangeEndpoint, ITextRangeProvider*, TextPatternRangeEndpoint) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE Select() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE AddToSelection() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RemoveFromSelection() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE ScrollIntoView(BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetChildren(SAFEARRAY**) override { return E_NOTIMPL; }
};

struct EditorProvider final : IRawElementProviderSimple, IRawElementProviderFragment,
    IRawElementProviderFragmentRoot, ITextProvider2 {
    std::atomic_ulong refs{1};
    const HWND window;
    const bool root;

    EditorProvider(HWND window, bool root) : window(window), root(root) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (id == __uuidof(IUnknown) || id == __uuidof(IRawElementProviderSimple))
            *out = static_cast<IRawElementProviderSimple*>(this);
        else if (id == __uuidof(IRawElementProviderFragment))
            *out = static_cast<IRawElementProviderFragment*>(this);
        else if (root && id == __uuidof(IRawElementProviderFragmentRoot))
            *out = static_cast<IRawElementProviderFragmentRoot*>(this);
        else if (!root && (id == __uuidof(ITextProvider2) || id == __uuidof(ITextProvider)))
            *out = static_cast<ITextProvider2*>(this);
        else
            return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --refs;
        if (!count) delete this;
        return count;
    }

    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* out) override {
        *out = static_cast<ProviderOptions>(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** out) override {
        *out = nullptr;
        return root ? UiaHostProviderFromHwnd(window, out) : S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID id, IUnknown** out) override {
        *out = nullptr;
        if (!root && (id == UIA_TextPatternId || id == UIA_TextPattern2Id)) {
            *out = static_cast<ITextProvider2*>(this);
            AddRef();
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID id, VARIANT* out) override {
        VariantInit(out);
        if (!root && omitted(fixture.mode, id)) {
            // The focused field is a virtual child with no HWND provider that
            // can fill in a missing property from the real Edit control.
            out->vt = VT_UNKNOWN;
            return UiaGetReservedNotSupportedValue(&out->punkVal);
        }
        switch (id) {
        case UIA_ControlTypePropertyId:
            out->vt = VT_I4;
            out->lVal = root ? UIA_PaneControlTypeId : UIA_EditControlTypeId;
            return S_OK;
        case UIA_AutomationIdPropertyId:
            out->vt = VT_BSTR;
            out->bstrVal = SysAllocString(root ? L"SiteVoiceProbeHost" : L"SiteVoiceProbeField");
            return out->bstrVal ? S_OK : E_OUTOFMEMORY;
        case UIA_ProcessIdPropertyId:
            out->vt = VT_I4;
            out->lVal = static_cast<LONG>(GetCurrentProcessId());
            return S_OK;
        case UIA_IsEnabledPropertyId:
        case UIA_HasKeyboardFocusPropertyId:
        case UIA_IsPasswordPropertyId:
        case UIA_IsKeyboardFocusablePropertyId:
        case UIA_IsControlElementPropertyId:
        case UIA_IsContentElementPropertyId:
            bool state = true;
            if (id == UIA_IsEnabledPropertyId) state = IsWindowEnabled(window) != FALSE;
            if (id == UIA_HasKeyboardFocusPropertyId) state = !root && activeEditor(window);
            if (id == UIA_IsKeyboardFocusablePropertyId) state = !root;
            if (id == UIA_IsPasswordPropertyId) state = !root && fixture.mode == Mode::password;
            out->vt = VT_BOOL;
            out->boolVal = state ? VARIANT_TRUE : VARIANT_FALSE;
            return S_OK;
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection direction, IRawElementProviderFragment** out) override {
        *out = nullptr;
        if (root && (direction == NavigateDirection_FirstChild || direction == NavigateDirection_LastChild))
            return fixture.providerField->QueryInterface(IID_PPV_ARGS(out));
        if (!root && direction == NavigateDirection_Parent) return fixture.providerRoot->QueryInterface(IID_PPV_ARGS(out));
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY** out) override {
        *out = nullptr;
        if (root) return S_OK; // the HWND supplies the root identity
        const auto array = SafeArrayCreateVector(VT_I4, 0, 2);
        if (!array) return E_OUTOFMEMORY;
        LONG index = 0;
        LONG value = UiaAppendRuntimeId;
        auto hr = SafeArrayPutElement(array, &index, &value);
        if (SUCCEEDED(hr)) {
            index = 1;
            value = 1;
            hr = SafeArrayPutElement(array, &index, &value);
        }
        if (FAILED(hr)) { SafeArrayDestroy(array); return hr; }
        *out = array;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect* out) override {
        RECT rect{};
        if (!GetWindowRect(window, &rect)) return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        *out = {static_cast<double>(rect.left), static_cast<double>(rect.top),
            static_cast<double>(rect.right - rect.left), static_cast<double>(rect.bottom - rect.top)};
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** out) override { *out = nullptr; return S_OK; }
    HRESULT STDMETHODCALLTYPE SetFocus() override {
        ::SetFocus(window);
        return ::GetFocus() == window ? S_OK : E_FAIL;
    }
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot** out) override {
        return fixture.providerRoot->QueryInterface(IID_PPV_ARGS(out));
    }
    HRESULT STDMETHODCALLTYPE ElementProviderFromPoint(double x, double y, IRawElementProviderFragment** out) override {
        *out = nullptr;
        UiaRect area{};
        const auto hr = get_BoundingRectangle(&area);
        if (FAILED(hr)) return hr;
        return x >= area.left && x < area.left + area.width && y >= area.top && y < area.top + area.height
            ? fixture.providerField->QueryInterface(IID_PPV_ARGS(out)) : S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetFocus(IRawElementProviderFragment** out) override {
        *out = nullptr;
        return activeEditor(window) ? fixture.providerField->QueryInterface(IID_PPV_ARGS(out)) : S_OK;
    }

    HRESULT createRange(LONG start, LONG end, ITextRangeProvider** out) {
        *out = new (std::nothrow) Range(this, window, start, end);
        return *out ? S_OK : E_OUTOFMEMORY;
    }
    HRESULT STDMETHODCALLTYPE GetSelection(SAFEARRAY** out) override {
        *out = nullptr;
        DWORD start = 0, end = 0;
        SendMessageW(window, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
        ComPtr<ITextRangeProvider> selection;
        const auto created = createRange(static_cast<LONG>(start), static_cast<LONG>(end), &selection);
        if (FAILED(created)) return created;
        const auto array = SafeArrayCreateVector(VT_UNKNOWN, 0, 1);
        if (!array) return E_OUTOFMEMORY;
        LONG index = 0;
        const auto inserted = SafeArrayPutElement(array, &index, selection.Get());
        if (FAILED(inserted)) {
            SafeArrayDestroy(array);
            return inserted;
        }
        *out = array;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_DocumentRange(ITextRangeProvider** out) override {
        return createRange(0, GetWindowTextLengthW(window), out);
    }
    HRESULT STDMETHODCALLTYPE get_SupportedTextSelection(SupportedTextSelection* out) override {
        *out = SupportedTextSelection_Single;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetCaretRange(BOOL* active, ITextRangeProvider** out) override {
        *active = activeEditor(window);
        DWORD start = 0, end = 0;
        SendMessageW(window, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
        return createRange(static_cast<LONG>(end), static_cast<LONG>(end), out);
    }
    HRESULT STDMETHODCALLTYPE GetVisibleRanges(SAFEARRAY**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RangeFromChild(IRawElementProviderSimple*, ITextRangeProvider**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RangeFromPoint(UiaPoint, ITextRangeProvider**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RangeFromAnnotation(IRawElementProviderSimple*, ITextRangeProvider**) override { return E_NOTIMPL; }
};

LRESULT CALLBACK editWindowProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_GETOBJECT && static_cast<LONG>(lp) == UiaRootObjectId) {
        if (!fixture.providerRoot) fixture.providerRoot.Attach(new (std::nothrow) EditorProvider(window, true));
        if (!fixture.providerField) fixture.providerField.Attach(new (std::nothrow) EditorProvider(window, false));
        return fixture.providerRoot && fixture.providerField
            ? UiaReturnRawElementProvider(window, wp, lp, fixture.providerRoot.Get()) : 0;
    }
    const auto result = CallWindowProcW(fixture.editProc, window, message, wp, lp);
    if (message == WM_DESTROY) {
        UiaReturnRawElementProvider(window, 0, 0, nullptr);
        fixture.providerField.Reset();
        fixture.providerRoot.Reset();
    }
    return result;
}

LRESULT CALLBACK rootWindowProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_COMMAND && HIWORD(wp) == EN_CHANGE && reinterpret_cast<HWND>(lp) == fixture.editor) {
        if (!saveDocument(fixture.editor)) std::cerr << "Failed to write the probe document.\n";
    } else if (message == WM_DESTROY) {
        PostQuitMessage(0);
    }
    return DefWindowProcW(window, message, wp, lp);
}

bool registerClasses(HINSTANCE instance) {
    WNDCLASSEXW root{};
    root.cbSize = sizeof(root);
    root.lpfnWndProc = rootWindowProc;
    root.hInstance = instance;
    root.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    root.lpszClassName = windowClass;
    if (!RegisterClassExW(&root)) return false;
    WNDCLASSEXW edit{};
    edit.cbSize = sizeof(edit);
    if (!GetClassInfoExW(nullptr, L"Edit", &edit)) return false;
    fixture.editProc = edit.lpfnWndProc;
    edit.style &= ~CS_GLOBALCLASS;
    edit.lpfnWndProc = editWindowProc;
    edit.hInstance = instance;
    edit.lpszClassName = editorClass;
    return RegisterClassExW(&edit) != 0;
}

bool parseMode(std::wstring_view arg, Mode& mode) {
    if (arg == L"missing-enabled") mode = Mode::missingEnabled;
    else if (arg == L"missing-focus") mode = Mode::missingFocus;
    else if (arg == L"missing-both") mode = Mode::missingBoth;
    else if (arg == L"read-only") mode = Mode::readOnly;
    else if (arg == L"password") mode = Mode::password;
    else if (arg == L"selection") mode = Mode::selection;
    else if (arg != L"standard") return false;
    return true;
}

void showEditor(HWND window, HWND editor) {
    // A test launcher can hide the console via STARTUPINFO; apply SW_SHOW
    // again if Windows consumed that startup value on our first call.
    ShowWindow(window, SW_SHOW);
    if (!IsWindowVisible(window)) ShowWindow(window, SW_SHOW);
    SetForegroundWindow(window);
    SetFocus(editor);
    const auto end = fixture.mode == Mode::selection ? initialCaret + 2 : initialCaret;
    SendMessageW(editor, EM_SETSEL, initialCaret, end);
}

int runEditor() {
    const auto instance = GetModuleHandleW(nullptr);
    if (!registerClasses(instance)) return 3;
    const auto window = CreateWindowExW(0, windowClass, windowTitle, WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 640, 150, nullptr, nullptr, instance, nullptr);
    DWORD style = WS_VISIBLE | WS_CHILD | WS_TABSTOP | ES_AUTOHSCROLL;
    if (fixture.mode == Mode::readOnly) style |= ES_READONLY;
    if (fixture.mode == Mode::password) style |= ES_PASSWORD;
    fixture.editor = window ? CreateWindowExW(WS_EX_CLIENTEDGE, editorClass, initialText, style,
        16, 20, 590, 35, window, nullptr, instance, nullptr) : nullptr;
    if (!fixture.editor) return 4;
    SendMessageW(fixture.editor, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
    showEditor(window, fixture.editor);
    if (!saveDocument(fixture.editor)) return 5;
    MSG message{};
    BOOL received = 0;
    while ((received = GetMessageW(&message, nullptr, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return received < 0 ? 6 : 0;
}

bool inspectProperty(IUIAutomation* automation, IUIAutomationElement* editor, PROPERTYID id, bool expected) {
    VARIANT value{};
    const auto result = editor->GetCurrentPropertyValueEx(id, TRUE, &value);
    BOOL unsupported = FALSE;
    const bool missing = result == static_cast<HRESULT>(UIA_E_NOTSUPPORTED) ||
        (SUCCEEDED(result) && SUCCEEDED(automation->CheckNotSupported(value, &unsupported)) && unsupported);
    const bool matched = omitted(fixture.mode, id) ? missing :
        SUCCEEDED(result) && value.vt == VT_BOOL && (value.boolVal != VARIANT_FALSE) == expected;
    if (!matched) {
        std::cerr << "Unexpected UIA property " << id << ": hr=0x" << std::hex << static_cast<unsigned long>(result)
                  << std::dec << ", vt=" << value.vt << ", unsupported=" << unsupported
                  << ", boolean=" << (value.vt == VT_BOOL ? static_cast<int>(value.boolVal) : 0)
                  << ", expected-missing=" << omitted(fixture.mode, id) << ", expected-boolean=" << expected << '\n';
    }
    VariantClear(&value);
    return matched;
}

int inspectEditor() {
    const auto root = FindWindowW(windowClass, windowTitle);
    const auto editor = FindWindowExW(root, nullptr, editorClass, nullptr);
    if (!root || !editor || GetForegroundWindow() != root) return 10;
    GUITHREADINFO gui{};
    gui.cbSize = sizeof(gui);
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(root, nullptr), &gui) || gui.hwndFocus != editor) return 11;
    ComPtr<IUIAutomation> automation;
    ComPtr<IUIAutomationElement> focused, hosted, expected;
    ComPtr<IUIAutomationTreeWalker> walker;
    BOOL same = FALSE;
    if (FAILED(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))) ||
        FAILED(automation->GetFocusedElement(&focused)) || !focused ||
        FAILED(automation->ElementFromHandle(editor, &hosted)) || !hosted ||
        FAILED(automation->get_RawViewWalker(&walker)) || !walker ||
        FAILED(walker->GetFirstChildElement(hosted.Get(), &expected)) || !expected ||
        FAILED(automation->CompareElements(focused.Get(), expected.Get(), &same)) || !same) {
        std::cerr << "Window host, accessibility child, or GetFocusedElement did not match: "
                  << !!hosted << ", " << !!expected << ", " << !!focused << ", " << same << '\n';
        return 12;
    }
    CONTROLTYPEID type = 0;
    const bool enabled = inspectProperty(automation.Get(), focused.Get(), UIA_IsEnabledPropertyId, true);
    const bool focus = inspectProperty(automation.Get(), focused.Get(), UIA_HasKeyboardFocusPropertyId, true);
    const bool password = inspectProperty(automation.Get(), focused.Get(), UIA_IsPasswordPropertyId, fixture.mode == Mode::password);
    if (FAILED(focused->get_CurrentControlType(&type)) || type != UIA_EditControlTypeId) {
        std::cerr << "Unexpected UIA control type: " << type << '\n';
        return 13;
    }
    if (!enabled || !focus || !password) return 13;

    ComPtr<IUIAutomationTextPattern> text;
    ComPtr<IUIAutomationTextRangeArray> selected;
    ComPtr<IUIAutomationTextRange> range;
    int count = 0, comparison = 0;
    if (FAILED(focused->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) || !text ||
        FAILED(text->GetSelection(&selected)) || !selected || FAILED(selected->get_Length(&count)) || count != 1 ||
        FAILED(selected->GetElement(0, &range)) || !range ||
        FAILED(range->CompareEndpoints(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_End, &comparison)) ||
        (comparison != 0) != (fixture.mode == Mode::selection)) return 14;
    VARIANT attr{};
    const bool matched = SUCCEEDED(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &attr)) &&
        attr.vt == VT_BOOL && (attr.boolVal != VARIANT_FALSE) == (fixture.mode == Mode::readOnly);
    VariantClear(&attr);
    if (!matched) return 15;

    ComPtr<IUIAutomationTextPattern2> text2;
    ComPtr<IUIAutomationTextRange> caret;
    BOOL active = FALSE;
    same = FALSE;
    if (FAILED(focused->GetCurrentPatternAs(UIA_TextPattern2Id, IID_PPV_ARGS(&text2))) || !text2 ||
        FAILED(text2->GetCaretRange(&active, &caret)) || !active || !caret ||
        FAILED(caret->Compare(range.Get(), &same)) || (same != FALSE) == (fixture.mode == Mode::selection))
        return 16;
    std::cout << "verified editor: same focused field, expected properties, selection and active caret\n";
    return 0;
}
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 3 || !parseMode(argv[2], fixture.mode)) {
        std::cerr << "Usage: probe-win-uia-editor <document-path|--inspect> <standard|missing-enabled|missing-focus|missing-both|read-only|password|selection>\n";
        return 2;
    }
    const bool inspect = std::wstring_view(argv[1]) == L"--inspect";
    const auto com = CoInitializeEx(nullptr, inspect ? COINIT_MULTITHREADED : COINIT_APARTMENTTHREADED);
    if (FAILED(com)) return 3;
    if (!inspect) fixture.document = argv[1];
    const int result = inspect ? inspectEditor() : runEditor();
    if (result) std::cerr << "Windows UIA fixture failed at stage " << result << ".\n";
    CoUninitialize();
    return result;
}
