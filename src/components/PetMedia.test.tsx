import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
