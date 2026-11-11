import { describe, expect, it } from "vitest";
import {
  MOSAIC,
  SIZE_DEFAULT,
  SIZE_MAX,
  SIZE_MIN,
  clampSize,
  fontSize,
  handleAt,
  highlightWidth,
  mosaicBlock,
  stepRadius,
  strokeWidth,
  hits,
  isTooSmall,
  moveShape,
  nextStep,
  pixelate,
  resizeShape,
  snapAngle,
  squareFrom,
  topHit,
  type ArrowShape,
  type BoxShape,
  type Shape,
} from "./model";

const rect: BoxShape = { id: 1, type: "rect", color: "#ff3b30", size: 1, x: 100, y: 100, w: 200, h: 100 };
const arrow: ArrowShape = { id: 2, type: "arrow", color: "#ff3b30", size: 1, x1: 0, y1: 0, x2: 100, y2: 0 };

describe("标注对象", () => {
  it("编号取现有最大号 + 1，删掉中间的也不会重号", () => {
    const steps: Shape[] = [
      { id: 1, type: "step", color: "#ff3b30", size: 1, x: 0, y: 0, n: 1 },
      { id: 3, type: "step", color: "#ff3b30", size: 1, x: 0, y: 0, n: 3 },
    ];
    expect(nextStep([])).toBe(1);
    expect(nextStep(steps)).toBe(4);
  });

  it("⇧ 约束：方框变正方形，箭头吸附 45°", () => {
    expect(squareFrom({ x: 0, y: 0 }, { x: 40, y: -10 })).toEqual({ x: 40, y: -40 });
    const snapped = snapAngle({ x: 0, y: 0 }, { x: 100, y: 12 });
    expect(snapped.x).toBeCloseTo(Math.hypot(100, 12));
    expect(snapped.y).toBeCloseTo(0);
    const diagonal = snapAngle({ x: 0, y: 0 }, { x: 50, y: 45 });
    expect(diagonal.x).toBeCloseTo(diagonal.y);
  });

  it("空心矩形只认边线，里面留给继续画；箭头认线段附近", () => {
    expect(hits(rect, { x: 100, y: 150 }, 6, 1)).toBe(true);
    expect(hits(rect, { x: 200, y: 150 }, 6, 1)).toBe(false);
    expect(hits(arrow, { x: 50, y: 5 }, 6, 1)).toBe(true);
    expect(hits(arrow, { x: 50, y: 30 }, 6, 1)).toBe(false);
    // 打了马赛克的方框/椭圆认整块；马赛克笔迹按荧光笔的宽度认
    const mosaic: BoxShape = { ...rect, id: 3, color: MOSAIC };
    expect(hits(mosaic, { x: 200, y: 150 }, 6, 1)).toBe(true);
    expect(topHit([rect, mosaic], { x: 100, y: 150 }, 6, 1)?.id).toBe(3);
    expect(hits({ ...mosaic, type: "ellipse" }, { x: 200, y: 150 }, 6, 1)).toBe(true);
    expect(hits({ ...mosaic, type: "ellipse" }, { x: 105, y: 105 }, 6, 1)).toBe(false);
    const brush = { id: 5, type: "pen" as const, color: MOSAIC, size: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    expect(hits(brush, { x: 50, y: 15 }, 6, 1)).toBe(true);
    expect(hits({ ...brush, color: "#ff3b30" }, { x: 50, y: 15 }, 6, 1)).toBe(false);
  });

  it("粗细是线性的：2/4/7 和原来的细/中/粗一样大，超出范围收回来", () => {
    expect([2, 4, 7].map((size) => strokeWidth(size, 1))).toEqual([2, 4, 7]);
    expect([2, 4, 7].map((size) => highlightWidth(size, 1))).toEqual([12, 20, 32]);
    expect([2, 4, 7].map((size) => mosaicBlock(size, 1))).toEqual([6, 10, 16]);
    expect(fontSize(4, 2)).toBe(40);
    expect(stepRadius(4, 1)).toBe(14);
    expect(fontSize(6, 1) - fontSize(5, 1)).toBe(fontSize(9, 1) - fontSize(8, 1));
    expect(clampSize(0)).toBe(SIZE_MIN);
    expect(clampSize(99)).toBe(SIZE_MAX);
    expect(clampSize(Number.NaN)).toBe(SIZE_DEFAULT);
  });

  it("移动整个对象；拖角以对角为锚点，翻过去也保持正的宽高", () => {
    expect(moveShape(rect, 10, -5)).toMatchObject({ x: 110, y: 95, w: 200, h: 100 });
    expect(moveShape(arrow, 5, 5)).toMatchObject({ x1: 5, y1: 5, x2: 105, y2: 5 });
    expect(handleAt(rect, { x: 302, y: 198 }, 8)).toBe("se");
    expect(resizeShape(rect, "se", { x: 400, y: 260 }, false)).toMatchObject({ x: 100, y: 100, w: 300, h: 160 });
    expect(resizeShape(rect, "se", { x: 50, y: 50 }, false)).toMatchObject({ x: 50, y: 50, w: 50, h: 50 });
    expect(resizeShape(rect, "se", { x: 400, y: 150 }, true)).toMatchObject({ w: 300, h: 300 });
    expect(resizeShape(arrow, "end", { x: 0, y: 80 }, false)).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 80 });
  });

  it("误点不算对象", () => {
    expect(isTooSmall({ ...rect, w: 1, h: 2 }, 3)).toBe(true);
    expect(isTooSmall(rect, 3)).toBe(false);
    expect(isTooSmall({ id: 4, type: "pen", color: "#000", size: 1, points: [{ x: 0, y: 0 }] }, 3)).toBe(true);
  });

  it("马赛克把每块改成平均色，原来的细节无法还原", () => {
    // 4×2 的区域，左边一块黑白相间，右边一块纯红；2px 一块
    const data = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255,
      255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    ]);
    pixelate(data, 4, 2, 2);
    const pixel = (x: number, y: number) => Array.from(data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) expect(pixel(x, y)).toEqual([128, 128, 128, 255]);
    for (const [x, y] of [[2, 0], [3, 1]]) expect(pixel(x, y)).toEqual([255, 0, 0, 255]);
  });
});
