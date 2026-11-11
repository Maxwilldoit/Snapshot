/**
 * 标注的对象模型：每一笔都是可再编辑的对象，坐标是原图像素。
 * 画布只在显示和导出时把它们画出来（render.ts），原图像素从不被改写。
 */

export type Tool = "select" | "arrow" | "rect" | "ellipse" | "pen" | "highlight" | "text" | "step" | "mosaic";
export type DrawTool = Exclude<Tool, "select">;
export type Size = 0 | 1 | 2;
export type Point = { x: number; y: number };

type Base = { id: number; color: string; size: Size };
export type BoxShape = Base & { type: "rect" | "ellipse" | "mosaic"; x: number; y: number; w: number; h: number };
export type ArrowShape = Base & { type: "arrow"; x1: number; y1: number; x2: number; y2: number };
export type StrokeShape = Base & { type: "pen" | "highlight"; points: Point[] };
export type TextShape = Base & { type: "text"; x: number; y: number; text: string };
export type StepShape = Base & { type: "step"; x: number; y: number; n: number };
export type Shape = BoxShape | ArrowShape | StrokeShape | TextShape | StepShape;

export type Handle = "nw" | "ne" | "sw" | "se" | "start" | "end";
export type Rect = { x: number; y: number; w: number; h: number };

/** 6 个预设色，红色默认；白色给深色截图用 */
export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#007aff", "#1d1d1f", "#ffffff"] as const;

/** 各尺寸的逻辑点数（乘以截图的像素密度得到原图像素） */
const STROKE_PT = [2, 4, 7];
const HIGHLIGHT_PT = [12, 20, 32];
const TEXT_PT = [14, 20, 30];
const STEP_RADIUS_PT = [10, 14, 19];
const MOSAIC_PT = [6, 10, 16];

export const strokeWidth = (size: Size, ratio: number) => STROKE_PT[size] * ratio;
export const highlightWidth = (size: Size, ratio: number) => HIGHLIGHT_PT[size] * ratio;
export const fontSize = (size: Size, ratio: number) => TEXT_PT[size] * ratio;
export const stepRadius = (size: Size, ratio: number) => STEP_RADIUS_PT[size] * ratio;
export const mosaicBlock = (size: Size, ratio: number) => Math.max(4, Math.round(MOSAIC_PT[size] * ratio));
export const lineHeight = (size: Size, ratio: number) => fontSize(size, ratio) * 1.25;

export const isBox = (shape: Shape): shape is BoxShape => shape.type === "rect" || shape.type === "ellipse" || shape.type === "mosaic";

/** 下一个步骤编号：现有最大号 + 1（删掉中间的不会重号） */
export const nextStep = (shapes: Shape[]) =>
  shapes.reduce((max, shape) => (shape.type === "step" ? Math.max(max, shape.n) : max), 0) + 1;

export const normalize = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

/** ⇧：矩形/椭圆/马赛克变成正方形 */
export function squareFrom(anchor: Point, point: Point): Point {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: anchor.x + Math.sign(dx || 1) * side, y: anchor.y + Math.sign(dy || 1) * side };
}

/** ⇧：直线/箭头吸附到 45° 的倍数 */
export function snapAngle(anchor: Point, point: Point): Point {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
}

/** 文字的行；空行也占一行 */
export const textLines = (text: string) => text.split("\n");

/**
 * 对象的外框（原图像素）。文字需要量宽度，交给调用方传 measure（画布 measureText）；
 * 没有时按每字一个字号估算。
 */
export function bounds(shape: Shape, ratio: number, measure?: (shape: TextShape, line: string) => number): Rect {
  switch (shape.type) {
    case "rect":
    case "ellipse":
    case "mosaic":
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case "arrow":
      return normalize({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 });
    case "pen":
    case "highlight": {
      const xs = shape.points.map((point) => point.x);
      const ys = shape.points.map((point) => point.y);
      const half = (shape.type === "pen" ? strokeWidth(shape.size, ratio) : highlightWidth(shape.size, ratio)) / 2;
      return { x: Math.min(...xs) - half, y: Math.min(...ys) - half, w: Math.max(...xs) - Math.min(...xs) + half * 2, h: Math.max(...ys) - Math.min(...ys) + half * 2 };
    }
    case "text": {
      const lines = textLines(shape.text);
      const width = Math.max(...lines.map((line) => (measure ? measure(shape, line) : line.length * fontSize(shape.size, ratio))));
      return { x: shape.x, y: shape.y, w: width, h: lines.length * lineHeight(shape.size, ratio) };
    }
    case "step": {
      const radius = stepRadius(shape.size, ratio);
      return { x: shape.x - radius, y: shape.y - radius, w: radius * 2, h: radius * 2 };
    }
  }
}

function distanceToSegment(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

const inside = (point: Point, rect: Rect, pad = 0) =>
  point.x >= rect.x - pad && point.x <= rect.x + rect.w + pad && point.y >= rect.y - pad && point.y <= rect.y + rect.h + pad;

/**
 * 点中了这个对象没有。空心的矩形/椭圆只认边线附近，里面留给继续画；
 * 马赛克、文字、编号认整块。`tolerance` 是原图像素。
 */
export function hits(shape: Shape, point: Point, tolerance: number, ratio: number, measure?: (shape: TextShape, line: string) => number) {
  switch (shape.type) {
    case "mosaic":
    case "text":
    case "step":
      return inside(point, bounds(shape, ratio, measure), tolerance / 2);
    case "rect": {
      const reach = tolerance + strokeWidth(shape.size, ratio) / 2;
      return inside(point, shape, reach) && !inside(point, { x: shape.x + reach, y: shape.y + reach, w: shape.w - reach * 2, h: shape.h - reach * 2 });
    }
    case "ellipse": {
      const rx = shape.w / 2;
      const ry = shape.h / 2;
      if (rx < 1 || ry < 1) return inside(point, shape, tolerance);
      const nx = (point.x - (shape.x + rx)) / rx;
      const ny = (point.y - (shape.y + ry)) / ry;
      const reach = (tolerance + strokeWidth(shape.size, ratio) / 2) / Math.min(rx, ry);
      return Math.abs(Math.hypot(nx, ny) - 1) <= reach;
    }
    case "arrow":
      return distanceToSegment(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= tolerance + strokeWidth(shape.size, ratio);
    case "pen":
    case "highlight": {
      const reach = tolerance + (shape.type === "pen" ? strokeWidth(shape.size, ratio) : highlightWidth(shape.size, ratio)) / 2;
      if (shape.points.length === 1) return Math.hypot(point.x - shape.points[0].x, point.y - shape.points[0].y) <= reach;
      return shape.points.some((p, index) => index > 0 && distanceToSegment(point, shape.points[index - 1], p) <= reach);
    }
  }
}

/** 最上面那个被点中的对象 */
export function topHit(shapes: Shape[], point: Point, tolerance: number, ratio: number, measure?: (shape: TextShape, line: string) => number) {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    if (hits(shapes[index], point, tolerance, ratio, measure)) return shapes[index];
  }
  return null;
}

/** 可拖的把手：方框类四个角，箭头两端；文字、编号、笔迹只能整体移动（大小用 S/M/L） */
export function handles(shape: Shape): Array<{ handle: Handle; point: Point }> {
  if (isBox(shape)) {
    return [
      { handle: "nw", point: { x: shape.x, y: shape.y } },
      { handle: "ne", point: { x: shape.x + shape.w, y: shape.y } },
      { handle: "sw", point: { x: shape.x, y: shape.y + shape.h } },
      { handle: "se", point: { x: shape.x + shape.w, y: shape.y + shape.h } },
    ];
  }
  if (shape.type === "arrow") {
    return [
      { handle: "start", point: { x: shape.x1, y: shape.y1 } },
      { handle: "end", point: { x: shape.x2, y: shape.y2 } },
    ];
  }
  return [];
}

export function handleAt(shape: Shape, point: Point, reach: number): Handle | null {
  return handles(shape).find((item) => Math.hypot(item.point.x - point.x, item.point.y - point.y) <= reach)?.handle ?? null;
}

export function moveShape<T extends Shape>(shape: T, dx: number, dy: number): T {
  switch (shape.type) {
    case "arrow":
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
    case "pen":
    case "highlight":
      return { ...shape, points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    default:
      return { ...shape, x: (shape as BoxShape).x + dx, y: (shape as BoxShape).y + dy };
  }
}

/** 拖把手：方框类以对角为锚点（⇧ 保持正方形），箭头拖一端（⇧ 吸附 45°） */
export function resizeShape<T extends Shape>(shape: T, handle: Handle, point: Point, constrain: boolean): T {
  if (shape.type === "arrow") {
    if (handle === "start") {
      const next = constrain ? snapAngle({ x: shape.x2, y: shape.y2 }, point) : point;
      return { ...shape, x1: next.x, y1: next.y };
    }
    const next = constrain ? snapAngle({ x: shape.x1, y: shape.y1 }, point) : point;
    return { ...shape, x2: next.x, y2: next.y };
  }
  if (!isBox(shape)) return shape;
  const anchor = {
    x: handle === "nw" || handle === "sw" ? shape.x + shape.w : shape.x,
    y: handle === "nw" || handle === "ne" ? shape.y + shape.h : shape.y,
  };
  return { ...shape, ...normalize(anchor, constrain ? squareFrom(anchor, point) : point) };
}

/** 太小的拖拽（基本是误点）不算一个对象；文字和编号是点一下就放 */
export function isTooSmall(shape: Shape, minimum: number) {
  // 方框任一边太窄就是一条细缝，多半是点歪了；笔迹要真的移动过一段才算
  if (isBox(shape)) return Math.min(shape.w, shape.h) < minimum;
  if (shape.type === "arrow") return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < minimum;
  if (shape.type === "pen" || shape.type === "highlight") {
    if (shape.points.length < 2) return true;
    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < minimum;
  }
  return false;
}

/**
 * 原地打马赛克：每块取平均色填满整块。导出时作用在原图像素上，原来的内容无法还原。
 * `data` 是 RGBA，宽高为区域大小。
 */
export function pixelate(data: Uint8ClampedArray, width: number, height: number, block: number) {
  const size = Math.max(1, Math.round(block));
  for (let top = 0; top < height; top += size) {
    for (let left = 0; left < width; left += size) {
      const bottom = Math.min(height, top + size);
      const right = Math.min(width, left + size);
      let r = 0, g = 0, b = 0, a = 0;
      const count = (bottom - top) * (right - left);
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const index = (y * width + x) * 4;
          r += data[index]; g += data[index + 1]; b += data[index + 2]; a += data[index + 3];
        }
      }
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count); a = Math.round(a / count);
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const index = (y * width + x) * 4;
          data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a;
        }
      }
    }
  }
}
