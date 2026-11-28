import { afterEach, describe, expect, it, vi } from "vitest";
import { canViewTransition, viewTransition } from "./motion";

function stubStartViewTransition() {
  const spy = vi.fn((cb?: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
    if (typeof cb === "function") void cb();
    else if (cb?.update) void cb.update();
    return {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: () => {},
      types: new Set<string>(),
    } satisfies ViewTransition;
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    writable: true,
    value: spy,
  });
  return spy;
}

describe("viewTransition platform guard", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDescriptor) {
      Object.defineProperty(document, "startViewTransition", originalDescriptor);
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });

  it("skips startViewTransition on Linux WebKitGTK to avoid UI-process SIGSEGV", () => {
    const startSpy = stubStartViewTransition();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    );

    expect(canViewTransition()).toBe(false);
    let updated = false;
    viewTransition("page", () => {
      updated = true;
    }, { direction: "down" });
    expect(updated).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("keeps startViewTransition enabled on macOS WKWebView, Windows WebView2, and Linux Chromium", () => {
    const startSpy = stubStartViewTransition();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    for (const ua of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ]) {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
      expect(canViewTransition()).toBe(true);
    }

    viewTransition("page", () => {}, { direction: "down" });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
