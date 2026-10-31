import { describe, expect, it } from "vitest";
import { containedMediaBounds, petWindowSize } from "./petSize";

describe("桌宠大小", () => {
  it("应用图标 100% 是屏幕短边的 8%，换屏幕跟着变", () => {
    expect(petWindowSize(852, 100, "app-icon")).toBe(68);
    expect(petWindowSize(1080, 100, "app-icon")).toBe(86);
    expect(petWindowSize(600, 100, "app-icon")).toBe(48);
  });

  it("未单独放大的形象保持原来 19% 的基准，换屏幕跟着变", () => {
    expect(petWindowSize(852, 100, "pet")).toBe(162);
    expect(petWindowSize(1080, 100, "pet")).toBe(205);
    expect(petWindowSize(600, 100, "pet")).toBe(114);
  });

  it("按百分比在各自默认大小上缩放，最后取整", () => {
    expect(petWindowSize(1000, 100, "app-icon")).toBe(80);
    expect(petWindowSize(1000, 150, "app-icon")).toBe(120);
    expect(petWindowSize(1000, 200, "app-icon")).toBe(160);
    expect(petWindowSize(1000, 100, "pet")).toBe(190);
    expect(petWindowSize(1000, 150, "pet")).toBe(285);
    expect(petWindowSize(1000, 200, "pet")).toBe(380);
    expect(petWindowSize(1080, 150, "app-icon")).toBe(130);
    expect(petWindowSize(1080, 150, "pet")).toBe(308);
  });

  it("基准 200 的形象在 100% 时等于普通形象 200%，不会放大其它形象或图标", () => {
    expect(petWindowSize(1000, 100, "pet", 200)).toBe(petWindowSize(1000, 200, "pet"));
    expect(petWindowSize(1000, 150, "pet", 200)).toBe(570);
    expect(petWindowSize(1000, 100, "pet", 100)).toBe(190);
    expect(petWindowSize(1000, 100, "app-icon", 200)).toBe(80);
  });
});

describe("宠物可点击矩形", () => {
  it("横屏素材去掉上下留白，保留底边对齐", () => {
    expect(containedMediaBounds({ left: 2, top: 2, width: 325, height: 325 }, 640, 360)).toEqual({
      left: 2,
      top: 144.1875,
      width: 325,
      height: 182.8125,
    });
  });

  it("竖屏和方图同样按 contain 规则收成实际外接矩形", () => {
    expect(containedMediaBounds({ left: 10, top: 20, width: 200, height: 100 }, 50, 100)).toEqual({
      left: 85,
      top: 20,
      width: 50,
      height: 100,
    });
    expect(containedMediaBounds({ left: 10, top: 20, width: 100, height: 100 }, 64, 64)).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 100,
    });
  });

  it("媒体尺寸还没解码时不做裁剪", () => {
    expect(containedMediaBounds({ left: 0, top: 0, width: 100, height: 100 }, 0, 0)).toBeNull();
  });
});
