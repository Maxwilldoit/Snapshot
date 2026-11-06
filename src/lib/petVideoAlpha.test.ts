import { describe, expect, it } from "vitest";
import { applyPetAlpha, petVideoPixels, registerPetAlpha } from "./petVideoAlpha";
import { petAlphaUrl } from "./media";
import { setupTauriMock } from "../test/tauri";

const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15";

describe("macOS pet opacity", () => {
  it("uses real alpha and preserves opaque black eyes and partially transparent edges", () => {
    const colour = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 13, 120, 240, 255]);
    const mask = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 127, 127, 127, 255]);
    applyPetAlpha(colour, mask);
    expect([...colour]).toEqual([0, 0, 0, 0, 0, 0, 0, 255, 13, 120, 240, 127]);
    expect(() => applyPetAlpha(colour, new Uint8ClampedArray(4))).toThrow();
    expect(() => applyPetAlpha(new Uint8ClampedArray(3), new Uint8ClampedArray(3))).toThrow();
  });

  it("uses composited pixels for hit testing and releases them on unmount", () => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    expect(petVideoPixels(video)).toBe(video);
    const release = registerPetAlpha(video, canvas);
    expect(petVideoPixels(video)).toBe(canvas);
    release();
    expect(petVideoPixels(video)).toBe(video);
  });

  it("only requests an alpha stream on macOS and only for local pet media", () => {
    setupTauriMock();
    expect(petAlphaUrl("http://media.localhost/pet/fish/idle.webm")).toBeNull();
    setupTauriMock(undefined, { userAgent: mac });
    expect(petAlphaUrl("media://localhost/pet/fish/idle.webm")).toBe("media://localhost/pet-alpha/fish/idle.webm");
    expect(petAlphaUrl("http://media.localhost/pet-walk/fish/walk.webm")).toBe("http://media.localhost/pet-alpha/fish/walk.webm");
    for (const src of ["clip.webm", "https://example.com/pet/fish/idle.webm", "media://localhost/pet-thumb/fish", "media://localhost/sound/pet/fish"]) {
      expect(petAlphaUrl(src)).toBeNull();
    }
  });

  it("preserves encoded separators, Chinese filenames and literal percent escapes", () => {
    setupTauriMock(undefined, { userAgent: mac });
    const src = "media://localhost/pet%2Ffish%2F" + encodeURIComponent("动作/待机 100%20.webm");
    const alpha = new URL(petAlphaUrl(src)!);
    expect(decodeURIComponent(alpha.pathname)).toBe("/pet-alpha/fish/动作/待机 100%20.webm");
    expect(petAlphaUrl("http://media.localhost/pet/fish/%E5%BE%85%E6%9C%BA.webm?v=2")).toBe("http://media.localhost/pet-alpha/fish/%E5%BE%85%E6%9C%BA.webm?v=2");
  });
});
