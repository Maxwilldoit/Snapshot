import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme, watchSystemTheme } from "./theme";

function mockSystemTheme(dark: boolean) {
  const query = Object.assign(new EventTarget(), { matches: dark });
  const matchMedia = vi.fn().mockReturnValue(query);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    change(matches: boolean) {
      query.matches = matches;
      query.dispatchEvent(Object.assign(new Event("change"), { matches }));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("system theme", () => {
  it.each([
    { saved: "light", dark: true, expected: "dark" },
    { saved: "dark", dark: false, expected: "light" },
  ])("uses system $expected despite a saved $saved preference", ({ saved, dark, expected }) => {
    localStorage.setItem("snapshot-theme", saved);
    const { matchMedia } = mockSystemTheme(dark);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    expect(readTheme()).toBe(expected);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("updates independent listeners and stops each one when cancelled", () => {
    const system = mockSystemTheme(false);
    const firstWindow = vi.fn(applyTheme);
    const secondWindow = vi.fn(applyTheme);
    const stopFirst = watchSystemTheme(firstWindow);
    const stopSecond = watchSystemTheme(secondWindow);

    system.change(true);
    expect(readTheme()).toBe("dark");
    expect(firstWindow).toHaveBeenLastCalledWith("dark");
    expect(secondWindow).toHaveBeenLastCalledWith("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    stopFirst();
    system.change(false);
    expect(readTheme()).toBe("light");
    expect(firstWindow).toHaveBeenCalledTimes(1);
    expect(secondWindow).toHaveBeenLastCalledWith("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    stopSecond();
    system.change(true);
    expect(firstWindow).toHaveBeenCalledTimes(1);
    expect(secondWindow).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to light and allows cleanup when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const onChange = vi.fn();

    expect(readTheme()).toBe("light");
    const stop = watchSystemTheme(onChange);
    expect(() => stop()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
