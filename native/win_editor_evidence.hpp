#pragma once

enum class EditorReport { yes, no, missing, mixed, error };

struct UiaEditorEvidence {
    EditorReport enabled;
    EditorReport focused;
    EditorReport password;
    bool verifiedNativeEditor;
};

constexpr bool allowsUiaEditorProbe(const UiaEditorEvidence& e) {
    // Win32 enablement and same window/process checks are required by capture.
    // A virtual field with unknown password status is never a paste target.
    return (e.enabled == EditorReport::yes || e.enabled == EditorReport::missing) &&
        (e.focused == EditorReport::yes || e.focused == EditorReport::missing) &&
        (e.password == EditorReport::no || (e.password == EditorReport::missing && e.verifiedNativeEditor));
}

constexpr bool safeUiaEditor(const UiaEditorEvidence& e, bool activeCaret, bool emptySelection, bool writable) {
    return allowsUiaEditorProbe(e) && emptySelection && writable &&
        (e.focused == EditorReport::yes || activeCaret || e.verifiedNativeEditor);
}

constexpr bool writableUiaEditor(EditorReport value, EditorReport caret, EditorReport document) {
    using R = EditorReport;
    if (value != R::no && value != R::missing) return false;
    if (caret == R::no) return true;
    if (caret != R::missing) return false;
    return value == R::no || document == R::no;
}
