import { describe, expect, it, vi } from "vitest";
import { createPetPlayback } from "./petPlayback";

describe("pet one-shot playback", () => {
  it("only the requested visible frame can become ready or finish playback", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const ready = vi.fn();
    const done = vi.fn();
    const media = document.createElement("video");
    const result = playback.play("new", "auto", ready).then(done);
    playback.ready("old", media);
    playback.ended("old");
    expect(ready).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    playback.ready("new", media);
    playback.ready("new", media);
    expect(ready).toHaveBeenCalledExactlyOnceWith(media);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).not.toHaveBeenCalled();
    playback.ended("new");
    await result;
    expect(done).toHaveBeenCalledExactlyOnceWith("ended");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a newer request cancels the previous one and ignores its late events", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const first = playback.play("first", "auto");
    const next = playback.play("next", "click");
    await expect(first).resolves.toBe("cancelled");
    playback.ready("first", document.createElement("video"));
    playback.failed("first");
    playback.ended("first");
    expect(playback.matches("next")).toBe(true);
    playback.ended("next");
    await expect(next).resolves.toBe("ended");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping autonomy cannot cancel a newly started manual interaction", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const result = playback.play("click", "click");
    playback.cancel("auto");
    expect(playback.matches("click")).toBe(true);
    playback.cancel();
    await expect(result).resolves.toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("missing clips and explicit media errors release the request", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const missing = playback.play("missing", "auto");
    await vi.advanceTimersByTimeAsync(8000);
    await expect(missing).resolves.toBe("failed");
    const broken = playback.play("broken", "auto");
    playback.failed("broken");
    await expect(broken).resolves.toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stalled video has a bounded recovery deadline, independent of normal completion", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const media = document.createElement("video");
    Object.defineProperty(media, "duration", { value: Infinity });
    const result = playback.play("stalled", "auto");
    playback.ready("stalled", media);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an invalid movement callback cannot leave playback occupied", async () => {
    vi.useFakeTimers();
    const playback = createPetPlayback();
    const result = playback.play("clip", "auto", () => { throw new Error("movement unavailable"); });
    playback.ready("clip", document.createElement("video"));
    await expect(result).resolves.toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
