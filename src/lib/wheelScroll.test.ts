import { describe, expect, it, vi } from "vitest";
import { installWheelPace, isNotchedWheel, wheelNotches, wheelStep, WHEEL_STEP_PX } from "./wheelScroll";

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
    expect(wheelStep(3, 1, 600)).toBe(WHEEL_STEP_PX);
    expect(wheelStep(-100, 0, 600)).toBe(-WHEEL_STEP_PX);
  });

  it("页模式折算成三格，且单步封顶在两屏", () => {
    expect(wheelNotches(1, 2)).toBe(3);
    expect(wheelStep(10, 2, 600)).toBe(600 * 2);
    expect(wheelStep(-10, 2, 600)).toBe(-600 * 2);
  });
});

// Exercise the live scheduler, including native scrollbar takeover and a
// subpixel tail at high refresh rates; formula-only checks miss both failures.
describe("wheel animation handoff", () => {
  it("stops immediately on pointerdown so dragging the native thumb wins", () => {
    const harness = wheelHarness();
    try {
      harness.wheel();
      expect(harness.frames.size).toBe(1);
      harness.root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      harness.root.scrollTop = 300;
      expect(harness.frames.size).toBe(0);
      expect(harness.root.scrollTop).toBe(300);
    } finally { harness.dispose(); }
  });

  it("settles a fractional wheel step at 240Hz without oscillating forever", () => {
    const harness = wheelHarness();
    try {
      harness.wheel(101);
      let count = 0;
      while (harness.frames.size && count++ < 300) harness.frame();
      expect(harness.frames.size).toBe(0);
      expect(harness.root.scrollTop).toBeCloseTo(wheelStep(101, 0, 600), 5);
    } finally { harness.dispose(); }
  });
});

function wheelHarness() {
  const root = document.createElement("div");
  root.style.overflowY = "auto";
  document.body.append(root);
  Object.defineProperties(root, { clientHeight: { value: 600 }, scrollHeight: { value: 3000 } });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let time = performance.now();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const uninstall = installWheelPace(root);
  return {
    root, frames,
    wheel: (deltaY = 100) => root.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true })),
    frame: () => { time += 1000 / 240; const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(time)); },
    dispose: () => { uninstall(); root.remove(); vi.unstubAllGlobals(); },
  };
}
