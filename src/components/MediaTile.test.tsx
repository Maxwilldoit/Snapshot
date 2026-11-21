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
      onOpen={() => {}}
      onMenu={() => {}}
    />,
  );

describe("历史格子", () => {
  it("截图缩略图不叠加来源应用图标、名称、类型或悬停时间", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(item({ appId: "/usr/bin/google-chrome" }));
    expect(container.querySelectorAll(".tile-preview img")).toHaveLength(1);
    expect(container.querySelector(".tile-name, .tile-type, .tile-info, .tile-time")).toBeNull();
  });

  it("格子只有一个主入口，没有悬停操作或圆形复选框，支持右键和键盘菜单", () => {
    setupTauriMock();
    const onOpen = vi.fn(), onMenu = vi.fn();
    const { container } = render(<MediaTile item={item()} onOpen={onOpen} onMenu={onMenu} />);
    const tile = screen.getByRole("button", { name: "标注：Google Chrome" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.querySelector(".tile-check, .tile-actions")).toBeNull();
    fireEvent.contextMenu(tile, { clientX: 40, clientY: 60 });
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "snap-1" }), tile, { x: 40, y: 60 });
    fireEvent.keyDown(tile, { key: "F10", shiftKey: true });
    expect(onMenu).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("录屏缩略图保留时长，不叠加来源应用图标", () => {
    setupTauriMock(() => undefined);
    const { container } = renderTile(
      item({ kind: "recording", appId: "/usr/bin/obs", durationMs: 65_000 }),
    );
    expect(container.querySelector(".tile-preview img")).toBeNull();
    expect(screen.getByText("01:05")).toBeTruthy();
  });
});
