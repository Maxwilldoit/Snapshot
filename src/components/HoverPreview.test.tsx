import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HoverPreview, computeHoverPreviewBox } from "./HoverPreview";
import { setupTauriMock } from "../test/tauri";
import type { MediaItem } from "../lib/mediaTimeline";

const makeItem = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: "shot-1",
  kind: "snapshot",
  fileName: "shot-1.webp",
  appName: "Figma",
  width: 1920,
  height: 1080,
  sizeBytes: 256 * 1024,
  createdAt: new Date(2026, 10, 18, 12, 30).getTime(),
  ...overrides,
});

describe("HoverPreview geometry and rendering", () => {
  it("opens on the right when the hovered tile sits in the left portion of the window", () => {
    const box = computeHoverPreviewBox(
      {
        item: makeItem(),
        rect: { left: 204, top: 120, right: 384, bottom: 260, width: 180, height: 140 },
      },
      { width: 960, height: 600 },
    );
    expect(box.side).toBe("right");
    expect(box.left).toBeGreaterThanOrEqual(396);
    expect(box.left + box.cardWidth).toBeLessThanOrEqual(948);
  });

  it("opens on the left when the hovered tile sits near the right edge", () => {
    const box = computeHoverPreviewBox(
      {
        item: makeItem(),
        rect: { left: 720, top: 120, right: 930, bottom: 260, width: 210, height: 140 },
      },
      { width: 960, height: 600 },
    );
    expect(box.side).toBe("left");
    expect(box.left + box.cardWidth).toBeLessThanOrEqual(708);
    expect(box.left).toBeGreaterThanOrEqual(12);
  });

  it("keeps small screenshots at 1:1 pixel dimensions without upscaling blur", () => {
    const box = computeHoverPreviewBox(
      {
        item: makeItem({ width: 160, height: 90 }),
        rect: { left: 204, top: 120, right: 364, bottom: 210, width: 160, height: 90 },
      },
      { width: 960, height: 600 },
    );
    expect(box.mediaWidth).toBe(160);
    expect(box.mediaHeight).toBe(90);
    expect(box.cardWidth).toBeGreaterThanOrEqual(228);
  });

  it("renders uncompressed snapshot URL and full format/resolution specs", () => {
    setupTauriMock(() => undefined);
    render(
      <HoverPreview
        anchor={{
          item: makeItem(),
          rect: { left: 204, top: 120, right: 384, bottom: 260, width: 180, height: 140 },
        }}
      />,
    );
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).not.toContain("Figma");
    expect(tip.textContent).toContain("1920 × 1080 · WEBP · 256 KB");
    const full = tip.querySelector<HTMLImageElement>("img.hover-preview-full");
    expect(full?.src).toContain("snapshot");
  });

  it.each([
    { appId: "/usr/bin/figma", iconRoute: "/app-icon/" },
    { appId: undefined, iconRoute: "/app-name-icon/" },
  ])("resolves the source icon via $iconRoute and hides it on failure", ({ appId, iconRoute }) => {
    setupTauriMock(() => undefined);
    render(
      <HoverPreview
        anchor={{
          item: makeItem({ appId }),
          rect: { left: 204, top: 120, right: 384, bottom: 260, width: 180, height: 140 },
        }}
      />,
    );
    const tip = screen.getByRole("tooltip");
    const icon = tip.querySelector<HTMLImageElement>("img.hover-preview-app-icon");
    expect(icon).not.toBeNull();
    if (!icon) throw new Error("Missing source app icon");
    expect(decodeURIComponent(icon.src)).toContain(iconRoute);
    expect(icon.alt).toBe("");
    fireEvent.error(icon);
    expect(tip.querySelector("img.hover-preview-app-icon")).toBeNull();
    expect(tip.textContent).toContain("1920 × 1080 · WEBP · 256 KB");
  });
});
