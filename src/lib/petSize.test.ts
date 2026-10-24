import { describe, expect, it } from "vitest";
import { petWindowSize } from "./petSize";

describe("桌宠大小", () => {
  it("应用图标 100% 是屏幕短边的 8%，换屏幕跟着变", () => {
    expect(petWindowSize(852, 100, "app-icon")).toBe(68);
    expect(petWindowSize(1080, 100, "app-icon")).toBe(86);
    expect(petWindowSize(600, 100, "app-icon")).toBe(48);
  });

  it("自定义宠物 100% 是屏幕短边的 16%，换屏幕跟着变", () => {
    expect(petWindowSize(852, 100, "pet")).toBe(136);
    expect(petWindowSize(1080, 100, "pet")).toBe(173);
    expect(petWindowSize(600, 100, "pet")).toBe(96);
  });

  it("按百分比在各自默认大小上缩放，最后取整", () => {
    expect(petWindowSize(1000, 100, "app-icon")).toBe(80);
    expect(petWindowSize(1000, 150, "app-icon")).toBe(120);
    expect(petWindowSize(1000, 200, "app-icon")).toBe(160);
    expect(petWindowSize(1000, 100, "pet")).toBe(160);
    expect(petWindowSize(1000, 150, "pet")).toBe(240);
    expect(petWindowSize(1000, 200, "pet")).toBe(320);
    expect(petWindowSize(1080, 150, "app-icon")).toBe(130);
    expect(petWindowSize(1080, 150, "pet")).toBe(259);
  });
});
