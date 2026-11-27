// This file is compiled beside the pristine sources extracted from tag v0.2.11.
// Its fixtures must run only on a disposable Windows runner.
#define main sitevoice_bridge_main
#include "win.cpp"
#undef main

namespace {
struct Window {
    HWND value = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 0, 0,
                                  nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    ~Window() { if (value) DestroyWindow(value); }
};

constexpr wchar_t original[] = L"original clipboard";
constexpr char url[] = "https://example.test/";

bool seed(HWND owner, UINT chromium) {
    const ClipboardLock lock(owner);
    if (!lock.open || !EmptyClipboard()) return false;
    auto text = formatBytes(CF_UNICODETEXT, original, sizeof(original));
    if (!text || !text->write()) return false;
    if (!chromium) return true;
    auto source = formatBytes(chromium, url, sizeof(url));
    return source && source->write();
}

bool matches(UINT format, const void* expected, size_t size) {
    const auto data = GetClipboardData(format);
    if (!data || GlobalSize(data) < size) return false;
    const auto bytes = GlobalLock(data);
    if (!bytes) return false;
    const bool equal = std::memcmp(bytes, expected, size) == 0;
    GlobalUnlock(data);
    return equal;
}

bool originalPreserved(HWND owner, UINT chromium) {
    const ClipboardLock lock(owner);
    return lock.open && matches(CF_UNICODETEXT, original, sizeof(original)) &&
           (!chromium || matches(chromium, url, sizeof(url)));
}
}

int main() {
    const Window source, helper;
    const UINT chromium = RegisterClipboardFormatW(L"Chromium internal source URL");
    if (!source.value || !helper.value || !chromium) return 1;
    for (const auto format : {0u, chromium, 0u}) {
        if (!seed(source.value, format) || !originalPreserved(source.value, format)) {
            std::cerr << "INCONCLUSIVE: unable to seed clipboard" << std::endl;
            return 1;
        }
        Clipboard clipboard(helper.value);
        const bool staged = clipboard.stage(L"SiteVoice clipboard probe");
        const bool ownedAfterClose = clipboard.owned();
        const bool restored = clipboard.restore();
        const bool preserved = originalPreserved(source.value, format);
        std::cout << "format=" << (format ? "Chromium-internal-source-URL" : "plain") << std::boolalpha
                  << " staged=" << staged << " ownedAfterClose=" << ownedAfterClose
                  << " restoreReported=" << restored << " originalPreserved=" << preserved << std::endl;
        if (staged == (format != 0) || !preserved) return 1;
    }
    std::cout << "REPRODUCED: v0.2.11 stages plain clipboard content but rejects Chromium source URL metadata." << std::endl;
    return 0;
}
