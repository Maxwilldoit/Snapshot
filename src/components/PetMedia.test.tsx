import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isWebmEntry } from "../lib/media";
import { PetMedia } from "./PetMedia";

describe("PetMedia", () => {
  it("detects the WebM extension case-insensitively", () => {
    expect(isWebmEntry("idle.webm")).toBe(true);
    expect(isWebmEntry("动作/待机.WEBM")).toBe(true);
    expect(isWebmEntry("idle.gif")).toBe(false);
    expect(isWebmEntry(null)).toBe(false);
  });

  it("keeps GIF rendering on img", () => {
    const { container } = render(
      <PetMedia src="http://media.localhost/pet/one/idle.gif" entry="idle.gif" />,
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("renders muted, inline, looping WebM and can keep a thumbnail paused", () => {
    const { container } = render(
      <PetMedia
        src="http://media.localhost/pet/one/idle.webm"
        entry="idle.webm"
        playing={false}
      />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.muted).toBe(true);
    expect(video?.loop).toBe(true);
    expect(video?.preload).toBe("metadata");
  });

  it("forwards a one-shot video's actual completion and decoding failure", () => {
    const ended = vi.fn();
    const failed = vi.fn();
    const { container } = render(<PetMedia src="clip.webm" entry="clip.webm" playing={false} loop={false} onEnded={ended} onError={failed} />);
    const video = container.querySelector("video")!;
    expect(video.loop).toBe(false);
    fireEvent.ended(video);
    expect(ended).toHaveBeenCalledExactlyOnceWith(video);
    fireEvent.error(video);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")).toBeNull();
  });

  it("on Linux plays media:// WebM through a Blob URL and revokes it on unmount", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    // Node 22's undici Response doesn't take jsdom's Blob as a body, so stub just what the code reads
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: true, status: 200, blob: async () => new Blob(["webm"], { type: "video/webm" }) }) as unknown as Response));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pet-idle");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container, unmount } = render(<PetMedia src="media://localhost/pet%2Fone%2Fidle.webm" entry="idle.webm" playing={false} />);
    await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe("blob:pet-idle"));
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:pet-idle");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
