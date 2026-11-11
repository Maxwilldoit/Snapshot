import {
  bounds,
  fontSize,
  handles,
  highlightWidth,
  lineHeight,
  mosaicBlock,
  pixelate,
  stepRadius,
  strokeWidth,
  textLines,
  type Shape,
  type TextShape,
} from "./model";

// macOS / Windows 的系统字体在前；Linux 上落到 Noto / 思源 / 文泉驿，再到系统默认无衬线
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei UI", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", Cantarell, Ubuntu, system-ui, sans-serif';
const SELECTION = "#007aff";
const HOVER = "rgba(0, 122, 255, 0.55)";

export const textFont = (shape: Pick<TextShape, "size">, ratio: number) => `600 ${fontSize(shape.size, ratio)}px ${FONT_FAMILY}`;

/** 黄、白这类浅色上要配深色描边/数字，其余配白色 */
export const isLightColor = (color: string) => {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
};

export function textMeasurer(ctx: CanvasRenderingContext2D, ratio: number) {
  return (shape: TextShape, line: string) => {
    ctx.font = textFont(shape, ratio);
    return ctx.measureText(line || " ").width;
  };
}

export type Scene = {
  image: CanvasImageSource;
  width: number;
  height: number;
  shapes: Shape[];
  /** 截图的像素密度：标注的粗细、字号按逻辑点换算到原图像素 */
  ratio: number;
  /** 只在屏幕上显示：选中框和把手。导出时不传 */
  selectedId?: number | null;
  /** 正在输入的文字由输入框显示，画布上先不画 */
  hiddenId?: number | null;
  /** 一个屏幕像素对应多少原图像素：选中框和把手在任何缩放下都保持同样粗细 */
  pixelsPerScreenPixel?: number;
  /** 以下只在屏幕上用的动效，导出时不传 */
  /** 鼠标下的对象：细蓝框提示「点得中」 */
  hoverId?: number | null;
  /** 刚出现 / 撤销恢复的对象淡入（0–1） */
  alpha?: Map<number, number>;
  /** 刚放下的编号从小到大落定 */
  scale?: Map<number, number>;
  /** 刚删掉 / 撤销掉的对象，按原来的层级淡出 */
  ghosts?: Array<{ shape: Shape; index: number; alpha: number }>;
  /** 选中框和把手出现的进度（0–1） */
  selectionProgress?: number;
};

function strokePath(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    ctx.lineTo(points[0].x + 0.01, points[0].y);
  } else {
    // 用中点做二次曲线，手写线条不会有折角
    for (let index = 1; index < points.length - 1; index += 1) {
      const mid = { x: (points[index].x + points[index + 1].x) / 2, y: (points[index].y + points[index + 1].y) / 2 };
      ctx.quadraticCurveTo(points[index].x, points[index].y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: Extract<Shape, { type: "arrow" }>, ratio: number) {
  const width = strokeWidth(shape.size, ratio);
  const dx = shape.x2 - shape.x1;
  const dy = shape.y2 - shape.y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return;
  const head = Math.min(length * 0.6, Math.max(width * 3.6, 11 * ratio));
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  const base = { x: shape.x2 - Math.cos(angle) * head * 0.82, y: shape.y2 - Math.sin(angle) * head * 0.82 };
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(shape.x1, shape.y1);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(shape.x2, shape.y2);
  ctx.lineTo(shape.x2 - Math.cos(angle - spread) * head, shape.y2 - Math.sin(angle - spread) * head);
  ctx.lineTo(shape.x2 - Math.cos(angle + spread) * head, shape.y2 - Math.sin(angle + spread) * head);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, width * 0.5);
  ctx.fill();
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, scene: Scene, alpha = 1, scale = 1) {
  const { ratio } = scene;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (scale !== 1 && shape.type === "step") {
    ctx.translate(shape.x, shape.y);
    ctx.scale(scale, scale);
    ctx.translate(-shape.x, -shape.y);
  }
  switch (shape.type) {
    case "mosaic": {
      const x = Math.max(0, Math.floor(shape.x));
      const y = Math.max(0, Math.floor(shape.y));
      const right = Math.min(scene.width, Math.ceil(shape.x + shape.w));
      const bottom = Math.min(scene.height, Math.ceil(shape.y + shape.h));
      if (right - x < 1 || bottom - y < 1) break;
      // 真正改写这块像素（取的是已经画好的画面），导出的图里看不出原来的内容
      const region = ctx.getImageData(x, y, right - x, bottom - y);
      pixelate(region.data, region.width, region.height, mosaicBlock(shape.size, ratio));
      if (alpha >= 1 || typeof document === "undefined") {
        ctx.putImageData(region, x, y);
        break;
      }
      // putImageData 不认透明度：淡入淡出时先放到小画布上再按透明度贴回来
      const layer = document.createElement("canvas");
      layer.width = region.width;
      layer.height = region.height;
      const layerCtx = layer.getContext("2d");
      if (!layerCtx) break;
      layerCtx.putImageData(region, 0, 0);
      ctx.drawImage(layer, x, y);
      break;
    }
    case "rect":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = strokeWidth(shape.size, ratio);
      ctx.lineJoin = "round";
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      break;
    case "ellipse":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = strokeWidth(shape.size, ratio);
      ctx.beginPath();
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.max(0.5, shape.w / 2), Math.max(0.5, shape.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "arrow":
      drawArrow(ctx, shape, ratio);
      break;
    case "pen":
    case "highlight":
      if (!shape.points.length) break;
      ctx.strokeStyle = shape.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (shape.type === "highlight") {
        // 荧光笔：正片叠底，压在文字上文字仍然清楚
        ctx.globalAlpha = 0.4 * alpha;
        ctx.globalCompositeOperation = "multiply";
        ctx.lineWidth = highlightWidth(shape.size, ratio);
      } else {
        ctx.lineWidth = strokeWidth(shape.size, ratio);
      }
      strokePath(ctx, shape.points);
      break;
    case "text": {
      if (shape.id === scene.hiddenId) break;
      const size = fontSize(shape.size, ratio);
      const lineGap = lineHeight(shape.size, ratio);
      ctx.font = textFont(shape, ratio);
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      // 描一圈反色边，任何底色上都看得清
      ctx.strokeStyle = isLightColor(shape.color) ? "rgba(0, 0, 0, 0.85)" : "#ffffff";
      ctx.lineWidth = Math.max(2, size * 0.2);
      ctx.fillStyle = shape.color;
      textLines(shape.text).forEach((line, index) => {
        const y = shape.y + index * lineGap + (lineGap - size) / 2;
        ctx.strokeText(line, shape.x, y);
        ctx.fillText(line, shape.x, y);
      });
      break;
    }
    case "step": {
      const radius = stepRadius(shape.size, ratio);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = shape.color;
      ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
      ctx.shadowBlur = radius * 0.3;
      ctx.shadowOffsetY = radius * 0.08;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = Math.max(1.5, radius * 0.12);
      ctx.strokeStyle = isLightColor(shape.color) ? "rgba(0, 0, 0, 0.25)" : "#ffffff";
      ctx.stroke();
      ctx.fillStyle = isLightColor(shape.color) ? "#1d1d1f" : "#ffffff";
      ctx.font = `700 ${radius * (shape.n > 9 ? 1 : 1.2)}px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(shape.n), shape.x, shape.y + radius * 0.06);
      break;
    }
  }
  ctx.restore();
}

function drawHover(ctx: CanvasRenderingContext2D, shape: Shape, scene: Scene) {
  const unit = scene.pixelsPerScreenPixel ?? 1;
  const box = bounds(shape, scene.ratio, textMeasurer(ctx, scene.ratio));
  const pad = 4 * unit;
  ctx.save();
  ctx.strokeStyle = HOVER;
  ctx.lineWidth = unit;
  ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, scene: Scene) {
  const unit = scene.pixelsPerScreenPixel ?? 1;
  const box = bounds(shape, scene.ratio, textMeasurer(ctx, scene.ratio));
  const pad = 4 * unit;
  const progress = Math.max(0, Math.min(1, scene.selectionProgress ?? 1));
  ctx.save();
  ctx.globalAlpha = progress;
  ctx.strokeStyle = SELECTION;
  ctx.lineWidth = unit;
  ctx.setLineDash([4 * unit, 3 * unit]);
  if (shape.type !== "arrow") ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
  ctx.setLineDash([]);
  for (const { point } of handles(shape)) {
    ctx.beginPath();
    // 把手从小圆点长到原大小，跟着框一起淡入
    ctx.arc(point.x, point.y, 4.5 * unit * (0.55 + 0.45 * progress), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.5 * unit;
    ctx.stroke();
  }
  ctx.restore();
}

/** 画一帧：原图 + 按顺序的所有标注（+ 屏幕上才有的选中框） */
export function renderScene(ctx: CanvasRenderingContext2D, scene: Scene) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.drawImage(scene.image, 0, 0);
  const layers: Array<{ shape: Shape; alpha: number }> = scene.shapes.map((shape) => ({ shape, alpha: scene.alpha?.get(shape.id) ?? 1 }));
  // 淡出的对象插回原来的层级，盖在它上面的马赛克等不会跟着跳
  for (const ghost of [...(scene.ghosts ?? [])].sort((a, b) => a.index - b.index)) {
    layers.splice(Math.min(ghost.index, layers.length), 0, { shape: ghost.shape, alpha: ghost.alpha });
  }
  for (const { shape, alpha } of layers) drawShape(ctx, shape, scene, alpha, scene.scale?.get(shape.id) ?? 1);
  const hovered = scene.hoverId == null || scene.hoverId === scene.selectedId ? null : scene.shapes.find((shape) => shape.id === scene.hoverId);
  if (hovered && hovered.id !== scene.hiddenId) drawHover(ctx, hovered, scene);
  const selected = scene.selectedId == null ? null : scene.shapes.find((shape) => shape.id === scene.selectedId);
  if (selected && selected.id !== scene.hiddenId) drawSelection(ctx, selected, scene);
}
