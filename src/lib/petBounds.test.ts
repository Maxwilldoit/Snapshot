import { describe, expect, it } from "vitest";
import { clampPetPixelX, clampPetX, petFloorY, petHorizontalLimits, type PetWorkArea } from "./petBounds";
import type { MediaBounds } from "./petSize";

const area = (x = 0, y = 0, width = 1000, height = 800): PetWorkArea => ({
  position: { x, y }, size: { width, height },
});
const windowSize = { width: 200, height: 200 };
const content: MediaBounds = { left: 50, top: 100, width: 100, height: 80 };

describe("桌宠脚底的竖向边界", () => {
  it("透明下边距不占用下拉空间，按可见内容落地", () => {
    expect(petFloorY(area(), 200, content, 1)).toBe(620);
    expect(petFloorY(area(), 200, null, 1)).toBe(600);
  });

  it("宽屏素材按脚底锚点落地，不随动画可见高度变化", () => {
    expect(petFloorY(area(), 200, content, 1, 145)).toBe(655);
    expect(petFloorY(area(), 200, { ...content, height: 20 }, 1, 145)).toBe(655);
  });

  it("Retina 与负原点屏幕使用物理像素，只缩放脚底一次", () => {
    expect(petFloorY(area(-2000, -1000, 2000, 1600), 400, content, 2, 145)).toBe(310);
    expect(petFloorY(area(), 250, content, 1.25, 145)).toBe(618);
  });

  it.each([NaN, Infinity, -10, 0, 300])("无效锚点 %s 回退到可见底边", (anchor) => {
    expect(petFloorY(area(), 200, content, 1, anchor)).toBe(620);
  });

  it("缺少或无效可见矩形时保留原有方窗边界", () => {
    for (const invalid of [null, { ...content, top: NaN }, { ...content, height: 0 },
      { ...content, height: Infinity }, { ...content, top: -300 }, { ...content, height: 300 }]) {
      expect(petFloorY(area(), 200, invalid, 1)).toBe(600);
    }
    expect(petFloorY(area(0, 0, 1000, 100), 200, null, 1)).toBe(-100);
  });

  it("无效工作区、缩放和窗口高度不产生非有限坐标", () => {
    expect(petFloorY(area(0, NaN), 200, content, 1)).toBeNull();
    expect(petFloorY(area(0, 0, 1000, 0), 200, content, 1)).toBeNull();
    expect(petFloorY(area(0, Number.MAX_VALUE, 1000, Number.MAX_VALUE), 200, content, 1)).toBeNull();
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(petFloorY(area(), invalid, content, 1)).toBeNull();
      expect(petFloorY(area(), 200, content, invalid)).toBeNull();
    }
  });
});

describe("桌宠可见矩形的横向边界", () => {
  it("允许透明外圈越过左边，并让可见内容贴齐右边", () => {
    const limits = petHorizontalLimits([area()], { x: 0, y: 0 }, windowSize, content, 1);
    expect(limits).toEqual({ minX: -50, maxX: 850 });
    const leftX = clampPetX(-200, limits);
    const rightX = clampPetX(1000, limits);
    expect(leftX).toBe(-50);
    expect(leftX + content.left).toBe(0);
    expect(rightX + content.left + content.width).toBe(1000);
    expect(rightX + windowSize.width).toBeGreaterThan(1000);
  });

  it("2x DPI 只缩放逻辑 content，物理窗口和工作区不再缩放", () => {
    const limits = petHorizontalLimits([area()], { x: 0, y: 0 },
      { width: 400, height: 400 }, content, 2);
    expect(limits).toEqual({ minX: -100, maxX: 700 });
    expect(clampPetX(900, limits) + (content.left + content.width) * 2).toBe(1000);
  });

  it("保留小数 DPI 的精度", () => {
    expect(petHorizontalLimits([area()], { x: 0, y: 0 }, windowSize, content, 1.25))
      .toEqual({ minX: -62.5, maxX: 812.5 });
  });

  it("支持位于负坐标的显示器工作区", () => {
    expect(petHorizontalLimits([area(-1200, -900, 1200, 900)],
      { x: -600, y: -300 }, windowSize, content, 1)).toEqual({ minX: -1250, maxX: -150 });
  });

  it("先合并相邻屏幕，跨接缝时不跳跃", () => {
    const areas = [area(1000), area()];
    for (const x of [849, 850, 900, 950, 999, 1000, 1001]) {
      const limits = petHorizontalLimits(areas, { x, y: 0 }, windowSize, content, 1);
      expect(limits).toEqual({ minX: -50, maxX: 1850 });
      expect(clampPetX(x, limits)).toBe(x);
    }
  });

  it("合并重叠区间及传递相连的区间", () => {
    expect(petHorizontalLimits([area(1500), area(), area(700)],
      { x: 1600, y: 0 }, windowSize, content, 1)).toEqual({ minX: -50, maxX: 2350 });
  });

  it("不连接的屏幕按窗口 x 的实际投影距离选择，不把空隙视作可用区域", () => {
    const areas = [area(1400), area()];
    const left = petHorizontalLimits(areas, { x: 1000, y: 0 }, windowSize, content, 1);
    const right = petHorizontalLimits(areas, { x: 1250, y: 0 }, windowSize, content, 1);
    expect(left).toEqual({ minX: -50, maxX: 850 });
    expect(clampPetX(1000, left)).toBe(850);
    expect(right).toEqual({ minX: 1350, maxX: 2250 });
    expect(clampPetX(1250, right)).toBe(1350);
    expect(petHorizontalLimits(areas, { x: 1100, y: 0 }, windowSize, content, 1)).toEqual(left);
    expect(petHorizontalLimits([...areas].reverse(), { x: 1100, y: 0 }, windowSize, content, 1)).toEqual(left);
  });

  it("按可见 body 中心 y 筛选所有工作区，而非窗口中心", () => {
    // 窗口中心 y=100；2x 下 body 中心 y=280，只有下方两个工作区参与。
    expect(petHorizontalLimits([area(0, 0, 500, 200), area(500, 200, 500, 300), area(0, 200, 500, 300)],
      { x: 0, y: 0 }, windowSize, content, 2)).toEqual({ minX: -100, maxX: 700 });
  });

  it("没有匹配 y 时选择竖向最近的工作区", () => {
    const areas = [area(0, 0, 500, 100), area(1000, 300, 500, 100)];
    expect(petHorizontalLimits(areas, { x: 1000, y: 20 }, windowSize, content, 1))
      .toEqual({ minX: -50, maxX: 350 });
    expect(petHorizontalLimits(areas, { x: 0, y: 120 }, windowSize, content, 1))
      .toEqual({ minX: 950, maxX: 1350 });
  });

  it("竖向最近区域等距时保留全部候选，再按横向投影选择", () => {
    const areas = [area(0, 0, 500, 100), area(1000, 300, 500, 100)];
    expect(petHorizontalLimits(areas, { x: 1000, y: 60 }, windowSize, content, 1))
      .toEqual({ minX: 950, maxX: 1350 });
  });

  it("可见中心恰好位于工作区竖向边缘时也参与匹配", () => {
    expect(petHorizontalLimits([area(0, 0, 500, 140), area(500, 140, 500, 300)],
      { x: 400, y: 0 }, windowSize, content, 1)).toEqual({ minX: -50, maxX: 850 });
  });

  it("可见内容 oversized 时收敛到有限的居中位置，重复校准保持稳定", () => {
    const areas = [area(0, 0, 60, 800)];
    const limits = petHorizontalLimits(areas, { x: 500, y: 0 }, windowSize, content, 1);
    expect(limits).toEqual({ minX: -70, maxX: -70 });
    const x = clampPetX(500, limits);
    expect(x + content.left + content.width / 2).toBe(30);
    expect(petHorizontalLimits(areas, { x, y: 0 }, windowSize, content, 1)).toEqual(limits);
    expect(clampPetX(x, limits)).toBe(x);
  });

  it("oversized 的不相连区间仍按收敛后移动距离选择", () => {
    expect(petHorizontalLimits([area(0, 0, 60), area(200, 0, 60)],
      { x: 100, y: 0 }, windowSize, content, 1)).toEqual({ minX: 130, maxX: 130 });
  });

  it.each<MediaBounds | null>([
    null,
    { ...content, width: 0 },
    { ...content, height: -1 },
    { ...content, left: NaN },
    { ...content, top: Infinity },
    { ...content, width: Infinity },
    { ...content, height: NaN },
    { ...content, left: Number.MAX_VALUE, width: Number.MAX_VALUE },
  ])("content 无效时回退到整个物理窗口：%j", (invalidContent) => {
    expect(petHorizontalLimits([area()], { x: 0, y: 0 }, windowSize, invalidContent, 2))
      .toEqual({ minX: 0, maxX: 800 });
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("拒绝无效 scale：%s", (scale) => {
    expect(petHorizontalLimits([area()], { x: 0, y: 0 }, windowSize, content, scale)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("拒绝无效窗口尺寸：%s", (size) => {
    expect(petHorizontalLimits([area()], { x: 0, y: 0 }, { width: size, height: 200 }, content, 1)).toBeNull();
    expect(petHorizontalLimits([area()], { x: 0, y: 0 }, { width: 200, height: size }, content, 1)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])("拒绝无效窗口位置：%s", (coordinate) => {
    expect(petHorizontalLimits([area()], { x: coordinate, y: 0 }, windowSize, content, 1)).toBeNull();
    expect(petHorizontalLimits([area()], { x: 0, y: coordinate }, windowSize, content, 1)).toBeNull();
  });

  it("没有有效工作区时返回 null，混合列表中跳过无效工作区", () => {
    const invalid = [area(0, 0, 0), area(0, 0, -1), area(0, 0, 1000, 0),
      area(NaN), area(0, Infinity), area(0, 0, Infinity), area(Number.MAX_VALUE, 0, Number.MAX_VALUE)];
    expect(petHorizontalLimits([], { x: 0, y: 0 }, windowSize, content, 1)).toBeNull();
    expect(petHorizontalLimits(invalid, { x: 0, y: 0 }, windowSize, content, 1)).toBeNull();
    expect(petHorizontalLimits([...invalid, area()], { x: 0, y: 0 }, windowSize, content, 1))
      .toEqual({ minX: -50, maxX: 850 });
  });

  it("有限输入运算溢出时返回 null，不泄漏非有限边界", () => {
    expect(petHorizontalLimits([area()], { x: 0, y: Number.MAX_VALUE },
      { width: 200, height: Number.MAX_VALUE }, null, 1)).toBeNull();
    expect(petHorizontalLimits([area(-Number.MAX_VALUE, 0, Number.MAX_VALUE)], { x: 0, y: 0 },
      windowSize, { left: Number.MAX_VALUE / 2, top: 0, width: 1e293, height: 1 }, 1)).toBeNull();
  });
});

describe("clampPetX", () => {
  it("null 原样保留 x，区间内保留 x，区间外贴齐两端", () => {
    expect(clampPetX(-123.5, null)).toBe(-123.5);
    const limits = { minX: -50, maxX: 850 };
    expect(clampPetX(12.5, limits)).toBe(12.5);
    expect(clampPetX(-100, limits)).toBe(-50);
    expect(clampPetX(1000, limits)).toBe(850);
    expect(clampPetX(-50, limits)).toBe(-50);
    expect(clampPetX(850, limits)).toBe(850);
  });
});

describe("clampPetPixelX", () => {
  it("写回窗口的 x 总是整数，向内取整不越过工作区", () => {
    // 1920 宽的工作区里，可见内容右缘在窗口内 191.8125px：上限 1728.1875 → 1728
    const limits = { minX: -4.5, maxX: 1728.1875 };
    expect(clampPetPixelX(1810, limits)).toBe(1728);
    expect(clampPetPixelX(-20, limits)).toBe(-4);
    expect(clampPetPixelX(600, limits)).toBe(600);
    expect(clampPetPixelX(600.4, null)).toBe(600);
    // 内容比工作区还宽、范围缩成一点时取最近的整数
    expect(clampPetPixelX(0, { minX: 10.6, maxX: 10.6 })).toBe(11);
    for (const x of [-1e4, -4.5, 0, 1728.5, 1e4]) expect(Number.isInteger(clampPetPixelX(x, limits))).toBe(true);
  });
});
