#include "win_shortcut.hpp"
#include <cassert>
#include <cstdint>

int main() {
    WindowsKeyTap tap;
    tap.down(1, 10, false);
    assert(tap.up(1, 250));
    tap.down(2, 300, false);
    assert(tap.up(2, 400));

    tap.down(1, 450, true); // A modifier was already held.
    assert(!tap.up(1, 500));
    tap.down(1, 550, false);
    tap.interrupt(); // Another key was used in the chord.
    assert(!tap.up(1, 600));
    tap.down(1, 650, false);
    tap.down(1, 651, false);
    tap.down(1, 652, false);
    assert(!tap.up(1, 700)); // A repeat cannot re-arm the tap.

    tap.down(2, 800, false);
    tap.down(1, 810, false);
    assert(!tap.up(2, 820) && !tap.up(1, 830)); // Two Windows keys are a chord.
    tap.down(1, 900, false);
    assert(!tap.up(1, 1351)); // A deliberate hold keeps the shell action.
    assert(!tap.up(2, 1450)); // Held before registration, no observed start.

    tap.down(1, UINT32_MAX - 29, false);
    assert(tap.up(1, 50)); // KBDLLHOOKSTRUCT.time wraps around.
}
