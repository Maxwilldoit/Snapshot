import { describe, expect, it } from "vitest";
import { petWindowSize } from "./petSize";

describe("桌宠大小", () => {
  it("100% 是屏幕短边的 60%，换屏幕跟着变", () => {
    expect(petWindowSize(852, 100)).toBe(511);
    expect(petWindowSize(1080, 100)).toBe(648);
    expect(petWindowSize(600, 100)).toBe(360);
  });

  it("按百分比在默认大小上缩放", () => {
    expect(petWindowSize(1000, 100)).toBe(600);
    expect(petWindowSize(1000, 150)).toBe(900);
    expect(petWindowSize(1000, 200)).toBe(1200);
  });
});
