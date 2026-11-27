#include "win_editor_evidence.hpp"

#include <cassert>

int main() {
    using R = EditorReport;
    // A caret and a writable field are positive evidence when optional UIA
    // flags are missing. Provider errors and explicit negative flags veto.
    assert(safeUiaEditor({R::missing, R::missing, R::no, false}, true, true, true));
    assert(!safeUiaEditor({R::missing, R::missing, R::no, false}, false, true, true));
    assert(!safeUiaEditor({R::no, R::missing, R::no, false}, true, true, true));
    assert(!safeUiaEditor({R::missing, R::no, R::no, false}, true, true, true));
    assert(!safeUiaEditor({R::error, R::yes, R::no, false}, true, true, true));
    assert(!safeUiaEditor({R::yes, R::error, R::no, false}, true, true, true));
    assert(!safeUiaEditor({R::yes, R::yes, R::yes, true}, true, true, true));
    assert(!safeUiaEditor({R::yes, R::yes, R::missing, false}, true, true, true));
    assert(safeUiaEditor({R::yes, R::missing, R::missing, true}, false, true, true));
    assert(!safeUiaEditor({R::yes, R::yes, R::error, true}, true, true, true));
    assert(!safeUiaEditor({R::yes, R::yes, R::no, false}, true, false, true));
    assert(!safeUiaEditor({R::yes, R::yes, R::no, false}, true, true, false));

    // A document can mix protected and writable sections. Prefer the precise
    // caret, and do not treat missing or mixed metadata as writable.
    assert(writableUiaEditor(R::missing, R::no, R::missing));
    assert(writableUiaEditor(R::missing, R::missing, R::no));
    assert(writableUiaEditor(R::no, R::missing, R::missing));
    assert(!writableUiaEditor(R::missing, R::missing, R::missing));
    assert(!writableUiaEditor(R::yes, R::no, R::missing));
    assert(!writableUiaEditor(R::no, R::yes, R::missing));
    assert(!writableUiaEditor(R::missing, R::missing, R::yes));
    assert(!writableUiaEditor(R::missing, R::missing, R::mixed));
    assert(!writableUiaEditor(R::no, R::mixed, R::missing));
    assert(!writableUiaEditor(R::missing, R::error, R::missing));
}
