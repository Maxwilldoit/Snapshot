import { describe, expect, it, vi } from "vitest";
import { fileNameOf, formatBytes, formatCalendarDate, normalizeKey, shortcutKeys } from "./format";

describe("format helpers", () => {
  it.each([
    [new Date(2026, 10, 17), new Date(2026, 10, 17), "zh", "11月17日"],
    [new Date(2026, 10, 16), new Date(2026, 10, 17), "zh", "11月16日"],
    [new Date(2025, 11, 31), new Date(2026, 0, 1), "zh", "2025年12月31日"],
    [new Date(2026, 10, 17), new Date(2026, 10, 17), "en", "Nov 17"],
    [new Date(2025, 11, 31), new Date(2026, 0, 1), "en", "Dec 31, 2025"],
  ] as const)("formats a preview calendar date for %s with year relative to %s (%s)", (date, now, language, expected) => {
    expect(formatCalendarDate(date.getTime(), now.getTime(), language)).toBe(expected);
  });

  it("keeps the current zero-byte and large-file labels", () => {
    expect(formatBytes(0)).toBe("1 KB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1024.0 MB");
  });

  it("handles an empty path and both path separator styles", () => {
    expect(fileNameOf(null)).toBe("");
    expect(fileNameOf("")).toBe("");
    expect(fileNameOf("C:\\Users\\Max\\capture.mp4")).toBe("capture.mp4");
    expect(fileNameOf("/Users/max/capture.mp4")).toBe("capture.mp4");
  });

  it("normalizes space, arrows, and single-character keys", () => {
    expect(normalizeKey(" ")).toBe("Space");
    expect(normalizeKey("ArrowLeft")).toBe("Left");
    expect(normalizeKey("a")).toBe("A");
    expect(normalizeKey("Enter")).toBe("Enter");
  });

  it("splits shortcut labels into keys", () => {
    expect(shortcutKeys(null)).toEqual([]);
    expect(shortcutKeys("CommandOrControl+Shift+K")).toEqual(["Ctrl", "Shift", "K"]);
  });

  it("uses macOS modifier symbols in the system order on a Mac", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      expect(shortcutKeys("CommandOrControl+Shift+P")).toEqual(["⇧", "⌘", "P"]);
      expect(shortcutKeys("CommandOrControl+Alt+Shift+2")).toEqual(["⌥", "⇧", "⌘", "2"]);
      expect(shortcutKeys("Control+Alt+K")).toEqual(["⌃", "⌥", "K"]);
    } finally {
      platform.mockRestore();
    }
  });
});
