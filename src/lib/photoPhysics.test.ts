import { describe, expect, it } from "vitest";
import {
  VelocityTracker,
  boundsFor,
  getClampedTransform,
  isNotchedZoom,
  maxScaleFor,
  momentumStep,
  rubberBand,
  rubberClamp,
  springSettled,
  springStep,
  straightZoomFrame,
  zoomAnchored,
  zoomDeltaOf,
} from "./photoPhysics";

const view = { w: 800, h: 600 };
const base = { w: 400, h: 300 };

describe("动态边界", () => {
  it("比视口小的轴强制居中，比视口大的轴限制在两端之间", () => {
    const fit = boundsFor(1, view, base);
    expect(fit.minTx).toBe(200);
    expect(fit.maxTx).toBe(200);
    expect(fit.minTy).toBe(150);
    expect(fit.maxTy).toBe(150);
    const zoomed = boundsFor(3, view, base);
    expect(zoomed.minTx).toBe(800 - 1200);
    expect(zoomed.maxTx).toBe(0);
    expect(zoomed.minTy).toBe(600 - 900);
    expect(zoomed.maxTy).toBe(0);
  });

  it("getClampedTransform 把缩放和平移一起投影回合法域", () => {
    expect(getClampedTransform(0.5, 999, 999, view, base, 8)).toEqual({ scale: 1, tx: 200, ty: 150 });
    expect(getClampedTransform(99, -9999, 9999, view, base, 8)).toEqual({ scale: 8, tx: -2400, ty: 0 });
  });
});

describe("光标锚点不变性", () => {
  it("指数缩放后光标下的内容像素保持不动", () => {
    const current = { scale: 2, tx: -100, ty: -50 };
    const cx = 321;
    const cy = 234;
    const contentX = (cx - current.tx) / current.scale;
    const contentY = (cy - current.ty) / current.scale;
    const next = zoomAnchored(current, 0.37, cx, cy);
    expect(next.scale).toBeCloseTo(2 * Math.exp(0.37), 10);
    expect(next.tx + contentX * next.scale).toBeCloseTo(cx, 8);
    expect(next.ty + contentY * next.scale).toBeCloseTo(cy, 8);
  });

  it("离散滚轮单次限幅 ±15%，触控板细腻信号不限", () => {
    expect(isNotchedZoom({ deltaMode: 1, deltaY: 3 })).toBe(true);
    expect(isNotchedZoom({ deltaMode: 0, deltaY: 120 })).toBe(true);
    expect(isNotchedZoom({ deltaMode: 0, deltaY: 4.5 })).toBe(false);
    const notched = zoomDeltaOf(-1000, 0, true);
    expect(Math.exp(notched)).toBeLessThanOrEqual(1.15 + 1e-9);
    const smooth = zoomDeltaOf(-12, 0, false);
    expect(smooth).toBeCloseTo(0.12, 6);
  });
});

describe("橡皮筋", () => {
  it("越界衰减单调、起点跟手、渐近上限", () => {
    expect(rubberBand(0)).toBe(0);
    const a = rubberBand(10);
    const b = rubberBand(100);
    const c = rubberBand(10000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(140);
    expect(a / 10).toBeCloseTo(0.55, 1);
  });

  it("rubberClamp 界内原样、两端对称阻尼", () => {
    expect(rubberClamp(-5, -10, 100)).toBe(-5);
    expect(rubberClamp(50, 0, 100)).toBe(50);
    expect(rubberClamp(105, 0, 100)).toBeGreaterThan(100);
    expect(rubberClamp(105, 0, 100)).toBeLessThan(106);
    expect(rubberClamp(-50, 0, 100)).toBeLessThan(0);
    expect(rubberClamp(-50, 0, 100)).toBeGreaterThan(-50);
  });
});

describe("临界阻尼弹簧", () => {
  it("无过冲收敛，继承初速度也不反向越过目标", () => {
    let x = 100;
    let v = 0;
    for (let i = 0; i < 240; i++) {
      const next = springStep(x, v, 1 / 120, 26);
      x = next.x;
      v = next.v;
      expect(x).toBeGreaterThanOrEqual(0);
    }
    expect(springSettled(x, v, 0.05, 0.5)).toBe(true);
    // 朝目标甩（v<0）也不应过冲到负侧
    x = 100;
    v = -800;
    for (let i = 0; i < 240; i++) {
      const next = springStep(x, v, 1 / 120, 26);
      x = next.x;
      v = next.v;
      expect(x).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("dt=0 是恒等变换（掉帧保护）", () => {
    expect(springStep(12, -34, 0, 26)).toEqual({ x: 12, v: -34 });
  });
});

describe("惯性滑行", () => {
  it("位移收敛到 v*tau，速度指数衰减", () => {
    let v = 2000;
    let total = 0;
    for (let i = 0; i < 600; i++) {
      const step = momentumStep(v, 8);
      total += step.delta;
      v = step.v;
    }
    expect(total).toBeCloseTo(2000 * 325, -2);
    expect(v).toBeLessThan(1);
  });
});

describe("速度采样器", () => {
  it("线性手势回归出精确速度，scale 用对数域", () => {
    const tracker = new VelocityTracker();
    for (let i = 0; i < 5; i++) {
      tracker.push({ t: 1000 + i * 16, tx: 10 * i, ty: -4 * i, scale: Math.exp(0.02 * i) });
    }
    const { vx, vy, vScale } = tracker.velocity(1064);
    expect(vx).toBeCloseTo(625, 0); // 10px / 16ms
    expect(vy).toBeCloseTo(-250, 0);
    expect(vScale / Math.exp(0.08)).toBeCloseTo(1.25, 1); // 0.02 / 16ms
  });

  it("松手前停顿超过间隙时速度归零", () => {
    const tracker = new VelocityTracker();
    tracker.push({ t: 0, tx: 0, ty: 0, scale: 1 });
    tracker.push({ t: 16, tx: 30, ty: 0, scale: 1 });
    expect(tracker.velocity(16).vx).toBeGreaterThan(0);
    expect(tracker.velocity(400)).toEqual({ vx: 0, vy: 0, vScale: 0 });
    tracker.clear();
    expect(tracker.velocity(16)).toEqual({ vx: 0, vy: 0, vScale: 0 });
  });

  it("同帧多个事件合并、缓冲区只留最近 5 帧", () => {
    const tracker = new VelocityTracker();
    tracker.push({ t: 10, tx: 0, ty: 0, scale: 1 });
    tracker.push({ t: 10, tx: 5, ty: 0, scale: 1 });
    for (let i = 1; i <= 8; i++) tracker.push({ t: 10 + i * 16, tx: 5 + i * 10, ty: 0, scale: 1 });
    const { vx } = tracker.velocity(138);
    expect(vx).toBeCloseTo(625, 0);
  });
});

describe("双击直线轨迹", () => {
  it("锚点像素每一帧都在起点到终点的直线上", () => {
    const start = getClampedTransform(1, 200, 150, view, base, 8);
    const anchor = { x: 700, y: 500 }; // 角落
    const zoomed = zoomAnchored(start, Math.log(2.5), anchor.x, anchor.y);
    const target = getClampedTransform(zoomed.scale, zoomed.tx, zoomed.ty, view, base, 8);
    const endPx = {
      x: target.tx + ((anchor.x - start.tx) / start.scale) * target.scale,
      y: target.ty + ((anchor.y - start.ty) / start.scale) * target.scale,
    };
    for (const scale of [1.1, 1.4, 1.9, 2.2, 2.5]) {
      const frame = straightZoomFrame(start, target, anchor, scale);
      const px = frame.tx + ((anchor.x - start.tx) / start.scale) * frame.scale;
      const py = frame.ty + ((anchor.y - start.ty) / start.scale) * frame.scale;
      // 像素位置对缩放进度共线：叉积为 0
      const cross = (px - anchor.x) * (endPx.y - anchor.y) - (py - anchor.y) * (endPx.x - anchor.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
    expect(straightZoomFrame(start, target, anchor, target.scale)).toEqual(target);
  });
});

describe("maxScale", () => {
  it("至少 8x，retina 原图 1:1 更大时覆盖原生分辨率", () => {
    expect(maxScaleFor(base, { w: 400, h: 300 })).toBe(8);
    expect(maxScaleFor({ w: 400, h: 300 }, { w: 4000, h: 3000 })).toBeCloseTo(10, 6);
    expect(maxScaleFor({ w: 200, h: 150 }, { w: 1600, h: 1200 })).toBe(8);
  });
});
