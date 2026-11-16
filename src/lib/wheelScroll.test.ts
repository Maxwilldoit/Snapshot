import { describe, expect, it } from "vitest";
import { isNotchedWheel, wheelNotches, wheelStep, WHEEL_STEP_PX } from "./wheelScroll";

const wheel = (deltaY: number, deltaMode = 0, extra: Partial<WheelEvent> = {}) =>
  ({ deltaY, deltaMode, deltaX: 0, ctrlKey: false, shiftKey: false, ...extra }) as Pick<
    WheelEvent, "deltaMode" | "deltaY" | "deltaX" | "ctrlKey" | "shiftKey"
  >;

describe("isNotchedWheel", () => {
  it("行 / 页模式的滚轮都拦", () => {
    expect(isNotchedWheel(wheel(3, 1))).toBe(true);
    expect(isNotchedWheel(wheel(1, 2))).toBe(true);
  });

  it("像素模式：大颗粒整数是滚轮，触控板的小数与小步不拦", () => {
    expect(isNotchedWheel(wheel(100))).toBe(true);
    expect(isNotchedWheel(wheel(-120))).toBe(true);
    expect(isNotchedWheel(wheel(53.33333))).toBe(false);
    expect(isNotchedWheel(wheel(4))).toBe(false);
    expect(isNotchedWheel(wheel(0))).toBe(false);
  });

  it("缩放（ctrl）、横向（shift 或 deltaX 为主）不拦", () => {
    expect(isNotchedWheel(wheel(100, 0, { ctrlKey: true }))).toBe(false);
    expect(isNotchedWheel(wheel(100, 0, { shiftKey: true }))).toBe(false);
    expect(isNotchedWheel(wheel(40, 0, { deltaX: 200 }))).toBe(false);
  });
});

describe("wheelStep", () => {
  it("一格滚轮固定 48px，与系统原始 100/120px 解耦", () => {
    expect(wheelStep(100, 0, 600)).toBe(WHEEL_STEP_PX);
    expect(wheelStep(120, 0, 600)).toBeCloseTo(WHEEL_STEP_PX * 1.2);
    expect(wheelStep(3, 1, 600)).toBe(WHEEL_STEP_PX * 3);
    expect(wheelStep(-100, 0, 600)).toBe(-WHEEL_STEP_PX);
  });

  it("页模式折算成三格，且单步封顶在两屏", () => {
    expect(wheelNotches(1, 2)).toBe(3);
    expect(wheelStep(10, 2, 600)).toBe(600 * 2);
    expect(wheelStep(-10, 2, 600)).toBe(-600 * 2);
  });
});
