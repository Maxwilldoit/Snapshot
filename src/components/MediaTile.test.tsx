import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaTile } from "./MediaTile";
import { setupTauriMock } from "../test/tauri";
import type { MediaItem } from "../lib/mediaTimeline";

const item = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: "snap-1",
  kind: "snapshot",
  fileName: "snap-1.png",
  appName: "Google Chrome",
  width: 200,
  height: 100,
  sizeBytes: 1000,
  createdAt: 1,
  ...overrides,
});

const renderTile = (media: MediaItem) =>
  render(
    <MediaTile
      item={media}
      boxWidth={200}
      boxHeight={100}
      onOpen={() => {}}
      onCheck={() => {}}
    />,
  );

describe("历史格子的来源应用角标", () => {
  it("有稳定标识时左下角渲染来源应用图标", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(item({ appId: "/usr/bin/google-chrome" }));
    const icon = container.querySelector("img.tile-app") as HTMLImageElement;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute("src")).toContain("app-icon");
    // 不再用媒体类型图标顶替
    expect(container.querySelector(".tile-type")).toBeNull();
  });

  it("旧记录没有标识就不显示角标，也不退回类型图标", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(item());
    expect(container.querySelector("img.tile-app")).toBeNull();
    expect(container.querySelector(".tile-type")).toBeNull();
  });

  it("图标取不到（加载失败）时收起角标，不留空位也不换类型图标", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(item({ appId: "/usr/bin/ghost" }));
    const icon = container.querySelector("img.tile-app") as HTMLImageElement;
    expect(icon).toBeTruthy();
    fireEvent.error(icon);
    expect(container.querySelector("img.tile-app")).toBeNull();
    expect(container.querySelector(".tile-type")).toBeNull();
  });

  it("录屏同样按来源应用显示图标，右下角保留时长", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(
      item({ kind: "recording", appId: "/usr/bin/obs", durationMs: 65_000 }),
    );
    expect(container.querySelector("img.tile-app")).toBeTruthy();
    expect(screen.getByText("01:05")).toBeTruthy();
  });
});