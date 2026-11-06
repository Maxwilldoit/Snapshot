import { StrictMode } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacPetVideo } from "./MacPetVideo";
import { petVideoPixels } from "../lib/petVideoAlpha";

let contexts: Array<{ pixels: Uint8ClampedArray; putImageData: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  contexts = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["webm"], { type: "video/webm" }) })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    // The visible canvas contains black colour; the offscreen plane encodes alpha=127.
    const pixels = new Uint8ClampedArray(this.isConnected ? [0, 0, 0, 255] : [127, 127, 127, 255]);
    const context = { pixels, clearRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: pixels }), putImageData: vi.fn() };
    contexts.push(context);
    return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllGlobals());

const props = { src: "media://localhost/pet/fish/idle.webm", alphaSrc: "media://localhost/pet-alpha/fish/idle.webm", entry: "idle.webm", playing: false };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function decoded(video: HTMLVideoElement, readyState = 2) {
  for (const [key, value] of Object.entries({ readyState, videoWidth: 1, videoHeight: 1 })) {
    Object.defineProperty(video, key, { configurable: true, value });
  }
}

describe("MacPetVideo", () => {
  it("uses origin-clean data URLs in packaged apps and releases videos on StrictMode cleanup", async () => {
    const ready = vi.fn();
    const { container, unmount } = render(<StrictMode><MacPetVideo {...props} onReady={ready} /></StrictMode>);
    await flush();
    const [colour, alpha] = [...container.querySelectorAll("video")];
    await waitFor(() => {
      expect(colour.getAttribute("src")).toMatch(/^data:video\/webm;base64,/);
      expect(alpha.getAttribute("src")).toMatch(/^data:video\/webm;base64,/);
    });
    decoded(colour);
    decoded(alpha, 0);
    fireEvent.loadedData(colour);
    expect(ready).not.toHaveBeenCalled();
    decoded(alpha);
    fireEvent.loadedData(alpha);
    expect(ready).toHaveBeenCalledExactlyOnceWith(colour);
    expect([...contexts.at(-2)!.pixels]).toEqual([0, 0, 0, 127]);
    expect(petVideoPixels(colour)).toBe(container.querySelector("canvas"));
    fireEvent.loadedData(colour);
    expect(ready).toHaveBeenCalledTimes(1);
    unmount();
    expect(petVideoPixels(colour)).toBe(colour);
    expect(colour.hasAttribute("src")).toBe(false);
    expect(alpha.hasAttribute("src")).toBe(false);
  });

  it("does not attach a late data URL after unmounting", async () => {
    const failed = vi.fn();
    const { container, unmount } = render(<MacPetVideo {...props} onError={failed} />);
    const colour = container.querySelector("video")!;
    await flush();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(colour.hasAttribute("src")).toBe(false);
    expect(failed).not.toHaveBeenCalled();
  });

  it("synchronizes imperative seek/play/pause and forwards one-shot completion", async () => {
    const ended = vi.fn();
    const { container } = render(<MacPetVideo {...props} loop={false} onEnded={ended} />);
    await flush();
    const [colour, alpha] = [...container.querySelectorAll("video")];
    decoded(colour);
    decoded(alpha);
    fireEvent.loadedData(alpha);
    colour.currentTime = 2;
    fireEvent.seeked(colour);
    expect(alpha.currentTime).toBe(2);
    await act(async () => { await colour.play(); fireEvent.play(colour); });
    expect(alpha.paused).toBe(false);
    colour.pause();
    fireEvent.pause(colour);
    expect(alpha.paused).toBe(true);
    expect(colour.loop).toBe(false);
    expect(alpha.loop).toBe(false);
    fireEvent.ended(colour);
    expect(ended).toHaveBeenCalledExactlyOnceWith(colour);
  });

  it("continues ordinary opaque WebM even if its alpha request fails before colour loads", async () => {
    const ready = vi.fn();
    const failed = vi.fn();
    vi.mocked(fetch).mockImplementation(async (url) => ({ ok: !String(url).includes("pet-alpha"), status: 404, blob: async () => new Blob() } as Response));
    const { container } = render(<MacPetVideo {...props} onReady={ready} onError={failed} />);
    await flush();
    const colour = container.querySelector("video")!;
    expect(ready).not.toHaveBeenCalled();
    decoded(colour);
    fireEvent.loadedData(colour);
    expect(ready).toHaveBeenCalledExactlyOnceWith(colour);
    expect(failed).not.toHaveBeenCalled();
    expect(colour.classList.contains("pet-alpha-colour")).toBe(false);
    expect(container.querySelector("canvas")!.hidden).toBe(true);
    expect(petVideoPixels(colour)).toBe(colour);
  });

  it("does not turn an interrupted play into an animation failure", async () => {
    const failed = vi.fn();
    const { container, rerender } = render(<MacPetVideo {...props} onError={failed} />);
    await flush();
    await waitFor(() => expect(container.querySelector("video")!.hasAttribute("src")).toBe(true));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("Paused during load", "AbortError"));
    rerender(<MacPetVideo {...props} playing onError={failed} />);
    await flush();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(failed).not.toHaveBeenCalled();
  });
});
