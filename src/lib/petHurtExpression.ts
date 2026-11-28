import type { PetAsset } from "../types";
import type { MediaBounds } from "./petSize";
import type { ContactEdge } from "./petThrowPhysics";

export type CatalogSpriteId =
  | "makima-pixel"
  | "yamada-clerk"
  | "yamada-pixel"
  | "clawd"
  | "nashor-v1"
  | "nashor-v2"
  | "hoop-23"
  | "kuro-blade"
  | "momo";

export type PetHurtMode = "wince" | "dizzy";

/** 碰撞结束后受击/眩晕表情持续停留毫秒数。 */
export const HURT_EXPRESSION_MS = 1450;
/** 受击表情双帧微颤切换间隔（ms）。 */
export const HURT_FRAME_INTERVAL_MS = 140;

const CATALOG_SPRITE_IDS = new Set<CatalogSpriteId>([
  "makima-pixel",
  "yamada-clerk",
  "yamada-pixel",
  "clawd",
  "nashor-v1",
  "nashor-v2",
  "hoop-23",
  "kuro-blade",
  "momo",
]);

/** 识别官方素材库中的 9 款 GIF 宠物（兼容在线安装 source 锚点与本地离线 ZIP 导入）。 */
export function identifyCatalogSprite(
  asset: Pick<PetAsset, "source" | "entry" | "animations"> | null | undefined,
): CatalogSpriteId | null {
  if (!asset) return null;
  const hashIndex = asset.source?.indexOf("#") ?? -1;
  if (hashIndex >= 0 && asset.source) {
    const rawId = asset.source.slice(hashIndex + 1).trim() as CatalogSpriteId;
    if (CATALOG_SPRITE_IDS.has(rawId)) return rawId;
  }
  const paths = [asset.entry, ...(asset.animations ?? [])]
    .filter(Boolean)
    .map((item) => item.replace(/\\/g, "/").toLowerCase());
  if (!paths.length) return null;
  if (paths.some((p) => p.includes("makima_idle.gif") || p.includes("makima_pixel/"))) return "makima-pixel";
  if (paths.some((p) => p.includes("clerk_idle.gif"))) return "yamada-clerk";
  if (paths.some((p) => p.includes("yamada_pixel/"))) return "yamada-pixel";
  if (paths.some((p) => p.includes("clawd-idle.gif") || p.includes("clawd_gifs/"))) return "clawd";
  if (paths.some((p) => p.includes("nashor_pet_v1/"))) return "nashor-v1";
  if (paths.some((p) => p.includes("nashor_pet_v2/"))) return "nashor-v2";
  if (paths.some((p) => p.includes("hoop-23-idle.gif") || p.startsWith("hoop-23-"))) return "hoop-23";
  if (paths.some((p) => p.includes("kuro-blade-idle.gif") || p.startsWith("kuro-blade-"))) return "kuro-blade";
  if (paths.some((p) => p.includes("momo-idle.gif") || p.startsWith("momo-"))) return "momo";
  return null;
}

/** 按碰撞方向、冲击速度与连续碰撞序号挑选紧闭忍痛（wince）或眩晕眼花（dizzy）表情。 */
export function pickPetHurtMode(edge: ContactEdge, speed: number, sequence = 0): PetHurtMode {
  if (edge === "floor" || edge === "ceiling" || speed >= 900) {
    return sequence % 3 === 1 ? "wince" : "dizzy";
  }
  return sequence % 3 === 2 ? "dizzy" : "wince";
}

type Rgba = readonly [number, number, number, number];

class PixelSurface {
  private readonly buf: Uint8ClampedArray;
  private readonly w: number;
  private readonly h: number;
  private readonly sx: number;
  private readonly sy: number;

  constructor(buf: Uint8ClampedArray, w: number, h: number, baseW: number, baseH: number) {
    this.buf = buf;
    this.w = w;
    this.h = h;
    this.sx = baseW > 0 ? w / baseW : 1;
    this.sy = baseH > 0 ? h / baseH : 1;
  }

  private putRaw(x: number, y: number, color: Rgba, onlyOpaque: boolean) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (onlyOpaque && this.buf[i + 3] < 140) return;
    const sa = color[3] / 255;
    if (sa >= 0.999 || this.buf[i + 3] === 0) {
      this.buf[i] = color[0];
      this.buf[i + 1] = color[1];
      this.buf[i + 2] = color[2];
      this.buf[i + 3] = color[3];
      return;
    }
    const da = this.buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.buf[i] = Math.round((color[0] * sa + this.buf[i] * da * (1 - sa)) / oa);
    this.buf[i + 1] = Math.round((color[1] * sa + this.buf[i + 1] * da * (1 - sa)) / oa);
    this.buf[i + 2] = Math.round((color[2] * sa + this.buf[i + 2] * da * (1 - sa)) / oa);
    this.buf[i + 3] = Math.round(oa * 255);
  }

  px(x: number, y: number, color: Rgba, onlyOpaque = false) {
    this.putRaw(Math.round(x * this.sx), Math.round(y * this.sy), color, onlyOpaque);
  }

  rect(x: number, y: number, rw: number, rh: number, color: Rgba, onlyOpaque = true) {
    const x0 = Math.round(x * this.sx);
    const y0 = Math.round(y * this.sy);
    const x1 = Math.max(x0 + 1, Math.round((x + rw) * this.sx));
    const y1 = Math.max(y0 + 1, Math.round((y + rh) * this.sy));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        this.putRaw(xx, yy, color, onlyOpaque);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: Rgba, onlyOpaque = true) {
    const scx = cx * this.sx;
    const scy = cy * this.sy;
    const srx = Math.max(0.6, rx * this.sx);
    const sry = Math.max(0.6, ry * this.sy);
    const x0 = Math.floor(scx - srx - 1);
    const x1 = Math.ceil(scx + srx + 1);
    const y0 = Math.floor(scy - sry - 1);
    const y1 = Math.ceil(scy + sry + 1);
    for (let yy = y0; yy <= y1; yy += 1) {
      for (let xx = x0; xx <= x1; xx += 1) {
        const dx = (xx - scx) / srx;
        const dy = (yy - scy) / sry;
        if (dx * dx + dy * dy <= 1) this.putRaw(xx, yy, color, onlyOpaque);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Rgba, thick = 1, onlyOpaque = false) {
    const sx0 = x0 * this.sx;
    const sy0 = y0 * this.sy;
    const sx1 = x1 * this.sx;
    const sy1 = y1 * this.sy;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(sx1 - sx0), Math.abs(sy1 - sy0)) * 2));
    const st = Math.max(1, Math.round(thick * ((this.sx + this.sy) * 0.5)));
    const half = Math.floor(st / 2);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const xx = Math.round(sx0 + (sx1 - sx0) * t);
      const yy = Math.round(sy0 + (sy1 - sy0) * t);
      for (let dy = -half; dy < st - half; dy += 1) {
        for (let dx = -half; dx < st - half; dx += 1) {
          this.putRaw(xx + dx, yy + dy, color, onlyOpaque);
        }
      }
    }
  }

  /** 绘制二次元井字青筋 💢 */
  vein(cx: number, cy: number, scale = 1) {
    const red: Rgba = [235, 52, 62, 255];
    const white: Rgba = [255, 245, 245, 225];
    for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      this.line(cx + qx * 2 * scale, cy + qy * 5 * scale, cx + qx * 2 * scale, cy + qy * 2 * scale, white, scale);
      this.line(cx + qx * 2 * scale, cy + qy * 2 * scale, cx + qx * 5 * scale, cy + qy * 2 * scale, white, scale);
      this.line(cx + qx * scale, cy + qy * 4 * scale, cx + qx * scale, cy + qy * scale, red, scale);
      this.line(cx + qx * scale, cy + qy * scale, cx + qx * 4 * scale, cy + qy * scale, red, scale);
    }
  }

  /** 绘制像素冷汗滴 💧 */
  sweat(cx: number, cy: number, scale = 1) {
    const outline: Rgba = [38, 118, 195, 245];
    const fill: Rgba = [145, 224, 255, 255];
    const hi: Rgba = [255, 255, 255, 255];
    for (let dy = -3 * scale; dy <= 4 * scale; dy += 1) {
      let half = Math.max(0, Math.round(((dy + 3 * scale) / (7 * scale)) * 2.6 * scale));
      if (dy > scale) {
        const ratio = (dy - 1.5 * scale) / (2.8 * scale);
        half = Math.max(0, Math.round(2.4 * scale * Math.sqrt(Math.max(0, 1 - ratio * ratio))));
      }
      for (let dx = -half - 1; dx <= half + 1; dx += 1) {
        const edge = Math.abs(dx) >= half || dy === -3 * scale || dy === 4 * scale;
        this.px(cx + dx, cy + dy, edge ? outline : fill, false);
      }
    }
    this.px(cx - Math.max(1, Math.floor(scale / 2)), cy + scale, hi, false);
  }

  /** 绘制像素眩晕四角星 ✨ */
  star(cx: number, cy: number, scale = 1) {
    const gold: Rgba = [255, 214, 58, 255];
    const core: Rgba = [255, 252, 230, 255];
    this.line(cx - 4 * scale, cy, cx + 4 * scale, cy, gold, scale);
    this.line(cx, cy - 4 * scale, cx, cy + 4 * scale, gold, scale);
    this.rect(cx - scale, cy - scale, 2 * scale + 1, 2 * scale + 1, core, false);
  }

  /** 绘制 > < 紧闭眼或 X X 眩晕眼 */
  eyes(
    lx0: number,
    lx1: number,
    ly: number,
    rx0: number,
    rx1: number,
    ry: number,
    halfH: number,
    mode: PetHurtMode,
    color: Rgba,
    thick = 1,
    onlyOpaque = false,
  ) {
    if (mode === "wince") {
      this.line(lx0, ly - halfH, lx1, ly, color, thick, onlyOpaque);
      this.line(lx1, ly, lx0, ly + halfH, color, thick, onlyOpaque);
      this.line(rx1, ry - halfH, rx0, ry, color, thick, onlyOpaque);
      this.line(rx0, ry, rx1, ry + halfH, color, thick, onlyOpaque);
    } else {
      this.line(lx0, ly - halfH, lx1, ly + halfH, color, thick, onlyOpaque);
      this.line(lx1, ly - halfH, lx0, ly + halfH, color, thick, onlyOpaque);
      this.line(rx0, ry - halfH, rx1, ry + halfH, color, thick, onlyOpaque);
      this.line(rx1, ry - halfH, rx0, ry + halfH, color, thick, onlyOpaque);
    }
  }
}

/**
 * 在角色默认待机帧的 RGBA 像素缓冲区上直接绘制与角色面部像素精确对齐的碰撞后表情。
 * phase (0 | 1) 用于碰撞后停留期间的双帧微颤动画（泪珠颤动、青筋跳动、冷汗滑落）。
 */
export function paintHurtSpritePixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  spriteId: CatalogSpriteId | null,
  mode: PetHurtMode,
  phase: 0 | 1,
  bounds?: MediaBounds | null,
): void {
  if (!(width > 0 && height > 0) || rgba.length < width * height * 4) return;

  switch (spriteId) {
    case "makima-pixel": {
      const s = new PixelSurface(rgba, width, height, 202, 292);
      const skin: Rgba = [250, 211, 190, 255];
      const line: Rgba = [58, 26, 22, 255];
      const blush: Rgba = [242, 132, 126, 155];
      s.rect(102, 33, 8, 5, skin);
      s.rect(117, 33, 8, 5, skin);
      s.eyes(103, 108, 35, 118, 123, 35, 2, mode, line, 1);
      s.rect(102, 38, 4, 2, blush);
      s.rect(120, 38, 4, 2, blush);
      s.rect(110, 43, 6, 3, skin);
      if (mode === "wince") {
        s.line(110, 45, 113, 43 + phase, line, 1);
        s.line(113, 43 + phase, 115, 45, line, 1);
        s.vein(126, 22 - phase, 1);
      } else {
        s.ellipse(113, 44, 1.8, 1.8, line);
        s.sweat(126, 24 + phase, 1);
        s.star(98, 20 - phase, 1);
      }
      return;
    }

    case "yamada-clerk": {
      const s = new PixelSurface(rgba, width, height, 208, 306);
      const skin: Rgba = [248, 216, 192, 255];
      const line: Rgba = [62, 32, 28, 255];
      const blush: Rgba = [248, 128, 128, 170];
      const tear: Rgba = [110, 222, 255, 255];
      s.rect(90, 54, 8, 6, skin);
      s.rect(104, 54, 8, 6, skin);
      s.eyes(91, 96, 56.5, 105, 110, 56.5, 2.5, mode, line, 1);
      s.rect(89, 60, 4, 2, blush);
      s.rect(108, 60, 4, 2, blush);
      if (mode === "wince") {
        s.rect(89, 58 + phase, 2, 3, tear, false);
        s.rect(111, 58 + phase, 2, 3, tear, false);
        s.rect(99, 65, 4, 3 + phase, [195, 82, 86, 255]);
        s.px(100, 65, [255, 235, 235, 255]);
        s.sweat(116, 47 + phase, 1);
      } else {
        s.rect(98, 65, 6, 3, skin);
        s.line(98, 66, 100, 65 + phase, line, 1);
        s.line(100, 65 + phase, 103, 67, line, 1);
        s.star(84, 42 - phase, 1);
        s.star(117, 44 + phase, 1);
      }
      return;
    }

    case "yamada-pixel": {
      const s = new PixelSurface(rgba, width, height, 163, 292);
      const skin: Rgba = [246, 216, 199, 255];
      const line: Rgba = [66, 32, 38, 255];
      const blush: Rgba = [244, 126, 132, 165];
      s.rect(83, 53, 7, 5, skin);
      s.rect(96, 54, 5, 5, skin);
      s.eyes(83, 88, 55, 96, 100, 56, 2, mode, line, 1);
      s.rect(82, 58, 4, 2, blush);
      s.rect(97, 59, 3, 2, blush);
      s.rect(91, 63, 4, 3, skin);
      if (mode === "wince") {
        s.line(90, 65, 92, 63 + phase, line, 1);
        s.line(92, 63 + phase, 94, 65, line, 1);
        s.vein(74, 38 - phase, 1);
      } else {
        s.ellipse(92, 64, 1.6, 1.8, line);
        s.sweat(73, 40 + phase, 1);
        s.star(102, 38 - phase, 1);
      }
      return;
    }

    case "clawd": {
      const s = new PixelSurface(rgba, width, height, 256, 256);
      const shell: Rgba = [216, 118, 86, 255];
      const black: Rgba = [12, 10, 10, 255];
      const blush: Rgba = [244, 96, 88, 220];
      s.rect(84, 80, 16, 16, shell, false);
      s.rect(164, 80, 16, 16, shell, false);
      s.rect(72, 98, 12, 6, blush);
      s.rect(180, 98, 12, 6, blush);
      if (mode === "wince") {
        for (const [dx, dy] of [[0, 0], [4, 4], [8, 6], [4, 8], [0, 12]] as const) {
          const w = dx === 8 ? 8 : 6;
          s.rect(84 + dx, 80 + dy, w, 4, black, false);
          s.rect(174 - dx, 80 + dy, w, 4, black, false);
        }
        const yShift = phase * 2;
        for (const [mx, my] of [[116, 106], [122, 102 + yShift], [128, 106], [134, 102 + yShift], [140, 106]] as const) {
          s.rect(mx, my, 6, 4, black);
        }
        s.sweat(194, 72 + phase * 2, 2);
      } else {
        for (const d of [0, 4, 8, 12] as const) {
          s.rect(84 + d, 80 + d, 4, 4, black, false);
          s.rect(96 - d, 80 + d, 4, 4, black, false);
          s.rect(164 + d, 80 + d, 4, 4, black, false);
          s.rect(176 - d, 80 + d, 4, 4, black, false);
        }
        s.rect(122, 100, 12, 12, black);
        s.rect(126, 104, 4, 4, [255, 168, 152, 255]);
        s.star(76, 60 - phase * 2, 2);
        s.vein(190, 68 + phase * 2, 2);
      }
      return;
    }

    case "nashor-v1": {
      const s = new PixelSurface(rgba, width, height, 420, 420);
      const dark: Rgba = [48, 24, 78, 255];
      const glow: Rgba = mode === "wince" ? [255, 92, 245, 255] : [255, 210, 72, 255];
      const core: Rgba = [255, 248, 255, 255];
      s.ellipse(222, 223, 6, 5, dark);
      s.ellipse(250, 223, 6, 5, dark);
      s.eyes(217, 226, 223, 245, 254, 223, 4.5, mode, glow, 2);
      s.eyes(218, 225, 223, 246, 253, 223, 4, mode, core, 1);
      s.line(231, 222, 239, 230, core, 2);
      s.line(239, 222, 231, 230, core, 2);
      if (mode === "wince") {
        s.vein(260, 195 - phase * 2, 2);
      } else {
        s.star(206, 192 - phase * 2, 2);
        s.star(264, 190 + phase * 2, 2);
      }
      return;
    }

    case "nashor-v2": {
      const s = new PixelSurface(rgba, width, height, 473, 473);
      const dark: Rgba = [42, 20, 72, 255];
      const glow: Rgba = mode === "wince" ? [255, 88, 242, 255] : [255, 212, 68, 255];
      const core: Rgba = [255, 248, 255, 255];
      s.ellipse(120, 255, 6, 5, dark);
      s.ellipse(140, 255, 6, 5, dark);
      s.eyes(115, 124, 255, 136, 145, 255, 4, mode, glow, 2);
      s.eyes(116, 123, 255, 137, 144, 255, 3.5, mode, core, 1);
      // 两侧副头同步切换受击/眩晕发光眼
      s.eyes(74, 79, 252, 86, 91, 252, 3, mode, glow, 2);
      s.eyes(169, 174, 252, 181, 186, 252, 3, mode, glow, 2);
      if (mode === "wince") {
        s.vein(158, 224 - phase * 2, 2);
      } else {
        s.star(98, 218 - phase * 2, 2);
        s.star(162, 220 + phase * 2, 2);
      }
      return;
    }

    case "hoop-23": {
      const s = new PixelSurface(rgba, width, height, 314, 314);
      const skin: Rgba = [156, 84, 50, 255];
      const line: Rgba = [34, 14, 10, 255];
      const teeth: Rgba = [250, 246, 242, 255];
      s.rect(160, 31, 8, 5, skin, true);
      s.rect(173, 31, 6, 5, skin, true);
      s.eyes(161, 166, 33, 173, 178, 33, 2, mode, line, 1, true);
      if (mode === "wince") {
        s.rect(167, 43, 8, 4, line, true);
        s.rect(168, 44, 6, 2, teeth, true);
        s.sweat(152, 24 + phase, 1);
      } else {
        s.ellipse(171, 45, 2.5, 2.5, line, true);
        s.vein(153, 22 - phase, 1);
        s.star(182, 18 + phase, 1);
      }
      return;
    }

    case "kuro-blade": {
      const s = new PixelSurface(rgba, width, height, 220, 359);
      const skin: Rgba = [244, 216, 203, 255];
      const line: Rgba = [42, 28, 30, 255];
      const blush: Rgba = [238, 120, 124, 155];
      s.rect(107, 91, 7, 5, skin, true);
      s.rect(120, 91, 7, 5, skin, true);
      s.eyes(108, 113, 93, 120, 125, 93, 2, mode, line, 1);
      s.rect(107, 96, 4, 2, blush, true);
      s.rect(122, 96, 4, 2, blush, true);
      s.rect(114, 101, 5, 3, skin, true);
      if (mode === "wince") {
        s.line(114, 103, 116, 101 + phase, line, 1);
        s.line(116, 101 + phase, 118, 103, line, 1);
        s.vein(126, 79 - phase, 1);
      } else {
        s.ellipse(116, 102, 1.5, 1.5, line, true);
        s.sweat(128, 82 + phase, 1);
        s.star(102, 78 - phase, 1);
      }
      return;
    }

    case "momo": {
      const s = new PixelSurface(rgba, width, height, 200, 206);
      const fur: Rgba = [44, 49, 54, 255];
      const muzzle: Rgba = [230, 228, 225, 255];
      const dark: Rgba = [14, 16, 20, 255];
      const white: Rgba = [248, 252, 255, 255];
      const tear: Rgba = [96, 224, 255, 255];
      const blush: Rgba = [255, 132, 152, 195];
      s.ellipse(61, 82, 12.5, 11.5, fur, true);
      s.ellipse(103, 88, 14.5, 12, fur, true);
      s.eyes(52, 68, 82.5, 98, 115, 87.5, 6.5, mode, dark, 4, true);
      s.eyes(53, 67, 82.5, 99, 114, 87.5, 6, mode, white, 2, true);
      s.ellipse(58, 95, 5, 2.5, blush, true);
      s.ellipse(104, 100, 5, 2.5, blush, true);
      s.ellipse(79, 101, 11, 4.5, muzzle, true);
      s.line(81, 97, 81, 99, dark, 1, true);
      if (mode === "wince") {
        s.ellipse(48, 88 + phase, 3.2, 4.2, tear, false);
        s.px(47, 87 + phase, white);
        s.ellipse(118, 93 + phase, 3.2, 4.2, tear, false);
        s.px(117, 92 + phase, white);
        s.ellipse(81, 103, 4.5, 3.5 + phase * 0.5, dark, true);
        s.ellipse(81, 103, 3.5, 2.5 + phase * 0.5, [228, 96, 116, 255], true);
        s.ellipse(81, 101, 2.5, 1, [255, 215, 224, 255], true);
      } else {
        s.ellipse(81, 103, 3.5, 3.5, dark, true);
        s.ellipse(81, 103, 2.2, 2.2, [228, 96, 116, 255], true);
        s.sweat(124, 72 + phase, 2);
        s.star(46, 62 - phase, 2);
      }
      return;
    }

    default: {
      const box = bounds && bounds.width > 0 && bounds.height > 0
        ? bounds
        : { left: 0.2, top: 0.12, width: 0.6, height: 0.8 };
      const s = new PixelSurface(rgba, width, height, width, height);
      const scale = Math.max(1, Math.round(Math.min(width, height) / 140));
      const hx = Math.round((box.left + box.width * 0.76) * width);
      const hy = Math.round((box.top + box.height * 0.14) * height);
      if (mode === "wince") {
        s.vein(hx, hy - phase * scale, scale);
      } else {
        s.sweat(hx, hy + phase * scale, scale);
        s.star(Math.round((box.left + box.width * 0.24) * width), hy - phase * scale, scale);
      }
    }
  }
}

export type HurtSpriteFrames = Record<PetHurtMode, [HTMLCanvasElement, HTMLCanvasElement]>;

/** 从已解码的待机静帧生成 4 张（wince/dizzy × 双帧微颤）离屏受击表情画布。 */
export function buildHurtSpriteFrames(
  image: HTMLImageElement,
  spriteId: CatalogSpriteId | null,
  bounds?: MediaBounds | null,
): HurtSpriteFrames | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!(width > 0 && height > 0) || typeof document === "undefined") return null;
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx) return null;
  let base: ImageData;
  try {
    sourceCtx.drawImage(image, 0, 0, width, height);
    base = sourceCtx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }

  const make = (mode: PetHurtMode, phase: 0 | 1): HTMLCanvasElement | null => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx || typeof ctx.putImageData !== "function") return null;
      const pixels = new Uint8ClampedArray(base.data);
      paintHurtSpritePixels(pixels, width, height, spriteId, mode, phase, bounds);
      const out = typeof ctx.createImageData === "function"
        ? ctx.createImageData(width, height)
        : typeof ImageData !== "undefined"
          ? new ImageData(width, height)
          : null;
      if (!out) return null;
      out.data.set(pixels);
      ctx.putImageData(out, 0, 0);
      return canvas;
    } catch {
      return null;
    }
  };

  const w0 = make("wince", 0);
  const w1 = make("wince", 1);
  const d0 = make("dizzy", 0);
  const d1 = make("dizzy", 1);
  if (!w0 || !w1 || !d0 || !d1) return null;
  return { wince: [w0, w1], dizzy: [d0, d1] };
}
