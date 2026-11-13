import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
      onMenu={() => {}}
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

  it("旧记录没有标识时按来源应用名请求真实图标", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(item());
    expect(container.querySelector("img.tile-app")?.getAttribute("src")).toContain("app-name-icon");
    expect(container.querySelector(".tile-type")).toBeNull();
  });

  it("格子只有一个主入口，没有悬停操作或圆形复选框，支持右键和键盘菜单", () => {
    setupTauriMock();
    const onOpen = vi.fn(), onMenu = vi.fn();
    const { container } = render(<MediaTile item={item()} boxWidth={200} boxHeight={100} onOpen={onOpen} onMenu={onMenu} />);
    const tile = screen.getByRole("button", { name: "标注：Google Chrome" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.querySelector(".tile-check, .tile-actions")).toBeNull();
    fireEvent.contextMenu(tile, { clientX: 40, clientY: 60 });
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "snap-1" }), tile, { x: 40, y: 60 });
    fireEvent.keyDown(tile, { key: "F10", shiftKey: true });
    expect(onMenu).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
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
