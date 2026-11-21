#pragma once
#include <cstdint>

class WindowsKeyTap {
    static constexpr std::uint32_t maxTapMs = 450;
    unsigned held = 0;
    std::uint32_t started = 0;
    bool candidate = false;

public:
    void interrupt() { candidate = false; }

    void down(unsigned key, std::uint32_t time, bool anotherHeld) {
        if (!held) {
            held = key;
            candidate = !anotherHeld;
            started = time;
        } else {
            interrupt();
        }
    }

    bool up(unsigned key, std::uint32_t time) {
        const bool tapped = candidate && held == key && time - started <= maxTapMs;
        if (held == key) held = 0;
        interrupt();
        return tapped;
    }
};
