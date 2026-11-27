// Compile this file beside both the published and candidate versions of win.cpp.
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
constexpr wchar_t transcript[] = L"SiteVoice clipboard probe";
constexpr wchar_t newer[] = L"newer clipboard from another owner";
constexpr char url[] = "https://example.test/";

template<size_t N>
bool seed(HWND owner, const wchar_t (&value)[N], UINT extra = 0) {
    const ClipboardLock lock(owner);
    if (!lock.open || !EmptyClipboard()) return false;
    auto text = formatBytes(CF_UNICODETEXT, value, sizeof(value));
    if (!text || !text->write()) return false;
    if (!extra) return true;
    auto source = formatBytes(extra, url, sizeof(url));
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

template<size_t N>
bool clipboardMatches(HWND owner, const wchar_t (&value)[N], UINT extra = 0) {
    const ClipboardLock lock(owner);
    return lock.open && matches(CF_UNICODETEXT, value, sizeof(value)) &&
           (!extra || matches(extra, url, sizeof(url)));
}

bool compare(HWND source, HWND helper, UINT format, bool baseline) {
    if (!seed(source, original, format) || !clipboardMatches(source, original, format)) {
        std::cerr << "INCONCLUSIVE: unable to seed clipboard" << std::endl;
        return false;
    }
    const auto before = GetClipboardSequenceNumber();
    Clipboard clipboard(helper);
    const bool staged = clipboard.stage(transcript);
    const auto after = GetClipboardSequenceNumber();
    const bool helperIsOwner = GetClipboardOwner() == helper;
    const bool ownedAfterClose = clipboard.owned();
    const bool transcriptAvailable = clipboardMatches(source, transcript);
    const bool restored = clipboard.restore();
    const bool preserved = clipboardMatches(source, original, format);
    std::cout << "format=" << (format ? "Chromium-internal-source-URL" : "plain")
              << " staged=" << staged << " ownedAfterClose=" << ownedAfterClose
              << " transcriptAvailable=" << transcriptAvailable
              << " restoreReported=" << restored << " originalPreserved=" << preserved
              << " sequenceBefore=" << before << " sequenceAfter=" << after
              << " helperIsOwner=" << helperIsOwner << std::endl;
    if (!baseline) return staged && helperIsOwner && ownedAfterClose && transcriptAvailable && restored && preserved;
    return format ? (!staged && preserved && before == after)
                  : (staged && helperIsOwner && !ownedAfterClose && restored && !preserved);
}

bool newerCopyWins(HWND source, HWND helper, UINT chromium) {
    if (!seed(source, original, chromium)) return false;
    Clipboard clipboard(helper);
    if (!clipboard.stage(transcript) || !clipboard.owned()) {
        std::cout << "case=newer-copy stageFailed=true" << std::endl;
        return false;
    }
    if (!seed(source, newer)) return false;
    const auto sequence = GetClipboardSequenceNumber();
    const bool helperLostOwnership = !clipboard.owned();
    const bool reported = clipboard.restore();
    const bool newerPreserved = clipboardMatches(source, newer);
    const bool unchanged = sequence == GetClipboardSequenceNumber() && GetClipboardOwner() == source;
    std::cout << "case=newer-copy helperLostOwnership=" << helperLostOwnership
              << " restoreReported=" << reported << " newerPreserved=" << newerPreserved
              << " ownerAndSequenceUnchanged=" << unchanged << std::endl;
    return helperLostOwnership && reported && newerPreserved && unchanged;
}

bool unknownFormatUntouched(HWND source, HWND helper, UINT unknown) {
    if (!seed(source, original, unknown) || !clipboardMatches(source, original, unknown)) return false;
    const auto sequence = GetClipboardSequenceNumber();
    Clipboard clipboard(helper);
    const bool declined = !clipboard.stage(transcript);
    const bool reported = clipboard.restore();
    const bool originalPreserved = clipboardMatches(source, original, unknown);
    const bool unchanged = sequence == GetClipboardSequenceNumber() && GetClipboardOwner() == source;
    std::cout << "case=unknown-format declined=" << declined << " restoreReported=" << reported
              << " originalPreserved=" << originalPreserved << " ownerAndSequenceUnchanged=" << unchanged << std::endl;
    return declined && reported && originalPreserved && unchanged;
}
}

int main(int argc, char* argv[]) {
    const bool baseline = argc == 2 && std::string_view(argv[1]) == "--expect-baseline";
    if (argc != 1 && !baseline) return 1;
    const Window source, helper;
    const UINT chromium = RegisterClipboardFormatW(L"Chromium internal source URL");
    const UINT unknown = RegisterClipboardFormatW(L"SiteVoice probe unsupported format");
    if (!source.value || !helper.value || !chromium || !unknown) return 1;
    std::cout << std::boolalpha;
    bool passed = true;
    for (const auto format : {0u, chromium, 0u}) passed &= compare(source.value, helper.value, format, baseline);
    if (!baseline) {
        passed &= newerCopyWins(source.value, helper.value, chromium);
        passed &= unknownFormatUntouched(source.value, helper.value, unknown);
    }
    if (passed && baseline) {
        std::cout << "REPRODUCED: v0.2.11 loses clipboard ownership recognition and rejects Chromium source URL metadata." << std::endl;
    } else if (passed) {
        std::cout << "VERIFIED: plain and Chromium clipboard formats restored; newer copies and unknown formats were preserved." << std::endl;
    }
    return passed ? 0 : 1;
}
