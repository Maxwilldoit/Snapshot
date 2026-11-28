import clawdHitUrl from "../assets/pet-hit/clawd.png";
import hoop23HitUrl from "../assets/pet-hit/hoop-23.png";
import kuroBladeHitUrl from "../assets/pet-hit/kuro-blade.png";
import makimaHitUrl from "../assets/pet-hit/makima-pixel.png";
import momoHitUrl from "../assets/pet-hit/momo.png";
import nashorV1HitUrl from "../assets/pet-hit/nashor-v1.png";
import nashorV2HitUrl from "../assets/pet-hit/nashor-v2.png";
import yamadaClerkHitUrl from "../assets/pet-hit/yamada-clerk.png";
import yamadaPixelHitUrl from "../assets/pet-hit/yamada-pixel.png";
import type { PetAsset, PetLayout } from "../types";
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

export const BUILTIN_HIT_PREFIX = "__builtin_hit__:";
/** 碰撞结束后受击/眩晕表情持续停留毫秒数。 */
export const HURT_EXPRESSION_MS = 1650;
/** 应用图标受击表情微颤切换间隔（ms）。 */
export const HURT_FRAME_INTERVAL_MS = 130;

interface BuiltinHurtSpriteSpec {
  id: string;
  entry: string;
  url: string;
  alphaUrl?: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  baseWidth: number;
  baseHeight: number;
  bounds: MediaBounds;
}

const BUILTIN_SPECS: Readonly<Record<CatalogSpriteId, BuiltinHurtSpriteSpec>> = {
  "makima-pixel": {
    id: "makima-pixel",
    entry: `${BUILTIN_HIT_PREFIX}makima-pixel`,
    url: makimaHitUrl,
    width: 220,
    height: 304,
    anchorX: 110,
    anchorY: 298,
    baseWidth: 202,
    baseHeight: 292,
    bounds: { left: 0.286364, top: 0.0625, width: 0.427273, height: 0.917763 },
  },
  "yamada-clerk": {
    id: "yamada-clerk",
    entry: `${BUILTIN_HIT_PREFIX}yamada-clerk`,
    url: yamadaClerkHitUrl,
    width: 240,
    height: 316,
    anchorX: 120,
    anchorY: 310,
    baseWidth: 208,
    baseHeight: 306,
    bounds: { left: 0.275, top: 0.120253, width: 0.454167, height: 0.860759 },
  },
  "yamada-pixel": {
    id: "yamada-pixel",
    entry: `${BUILTIN_HIT_PREFIX}yamada-pixel`,
    url: yamadaPixelHitUrl,
    width: 220,
    height: 304,
    anchorX: 110,
    anchorY: 298,
    baseWidth: 163,
    baseHeight: 292,
    bounds: { left: 0.236364, top: 0.111842, width: 0.527273, height: 0.868421 },
  },
  clawd: {
    id: "clawd",
    entry: `${BUILTIN_HIT_PREFIX}clawd`,
    url: clawdHitUrl,
    width: 256,
    height: 256,
    anchorX: 128,
    anchorY: 198,
    baseWidth: 256,
    baseHeight: 256,
    bounds: { left: 0.121094, top: 0.101562, width: 0.757812, height: 0.671875 },
  },
  "nashor-v1": {
    id: "nashor-v1",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v1`,
    url: nashorV1HitUrl,
    width: 420,
    height: 420,
    anchorX: 212.5,
    anchorY: 392,
    baseWidth: 420,
    baseHeight: 420,
    bounds: { left: 0.209524, top: 0.088095, width: 0.595238, height: 0.845238 },
  },
  "nashor-v2": {
    id: "nashor-v2",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v2`,
    url: nashorV2HitUrl,
    width: 473,
    height: 473,
    anchorX: 132,
    anchorY: 458,
    baseWidth: 473,
    baseHeight: 473,
    bounds: { left: 0.07611, top: 0.196617, width: 0.408034, height: 0.77167 },
  },
  "hoop-23": {
    id: "hoop-23",
    entry: `${BUILTIN_HIT_PREFIX}hoop-23`,
    url: hoop23HitUrl,
    width: 314,
    height: 324,
    anchorX: 157,
    anchorY: 314,
    baseWidth: 314,
    baseHeight: 314,
    bounds: { left: 0.343949, top: 0.055556, width: 0.308917, height: 0.91358 },
  },
  "kuro-blade": {
    id: "kuro-blade",
    entry: `${BUILTIN_HIT_PREFIX}kuro-blade`,
    url: kuroBladeHitUrl,
    width: 300,
    height: 368,
    anchorX: 150,
    anchorY: 360,
    baseWidth: 220,
    baseHeight: 359,
    bounds: { left: 0.13, top: 0.168478, width: 0.74, height: 0.809783 },
  },
  momo: {
    id: "momo",
    entry: `${BUILTIN_HIT_PREFIX}momo`,
    url: momoHitUrl,
    width: 220,
    height: 224,
    anchorX: 110,
    anchorY: 218,
    baseWidth: 200,
    baseHeight: 206,
    bounds: { left: 0.122727, top: 0.0625, width: 0.754545, height: 0.910714 },
  },
};

/** 识别官方素材库中的 9 款 GIF 宠物（兼容在线安装 source 锚点与本地离线 ZIP 导入）。 */
export function identifyCatalogSprite(
  asset: Pick<PetAsset, "source" | "entry" | "animations"> | null | undefined,
): CatalogSpriteId | null {
  if (!asset) return null;
  const hashIndex = asset.source?.indexOf("#") ?? -1;
  if (hashIndex >= 0 && asset.source) {
    const rawId = asset.source.slice(hashIndex + 1).trim() as CatalogSpriteId;
    if (rawId in BUILTIN_SPECS) return rawId;
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

export function isBuiltinHurtEntry(entry: string | null | undefined): boolean {
  return Boolean(entry?.startsWith(BUILTIN_HIT_PREFIX));
}

export function builtinHurtUrl(entry: string | null | undefined): string | null {
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const id = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "") as CatalogSpriteId;
  return BUILTIN_SPECS[id]?.url ?? null;
}

export function builtinHurtAlphaUrl(entry: string | null | undefined): string | null {
  if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return null;
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const id = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "") as CatalogSpriteId;
  return BUILTIN_SPECS[id]?.alphaUrl ?? null;
}

/** 按碰撞方向、冲击速度与连续碰撞序号挑选紧闭忍痛（wince）或眩晕眼花（dizzy）模式。 */
export function pickPetHurtMode(edge: ContactEdge, speed: number, sequence = 0): PetHurtMode {
  if (edge === "floor" || edge === "ceiling" || speed >= 900) {
    return sequence % 3 === 1 ? "wince" : "dizzy";
  }
  return sequence % 3 === 2 ? "dizzy" : "wince";
}

/**
 * 为素材库中的 9 款 GIF 宠物注入随应用打包的高清受击表情立绘、脚底锚点与透明包围盒：
 * - 不改动磁盘上的原压缩包与 settings.json；
 * - 若压缩包作者已显式声明 pet.hit，则优先尊重包内配置。
 */
export function augmentAssetWithBuiltinHurt(asset: PetAsset | undefined): PetAsset | undefined {
  if (!asset || asset.eventActions?.["pet.hit"]) return asset;
  const spriteId = identifyCatalogSprite(asset);
  if (!spriteId) return asset;
  const spec = BUILTIN_SPECS[spriteId];
  const animations = asset.animations.includes(spec.entry)
    ? asset.animations
    : [...asset.animations, spec.entry];
  const baseLayout: PetLayout = asset.layout ?? {
    baseWidth: spec.baseWidth,
    baseHeight: spec.baseHeight,
    anchorX: spec.anchorX,
    anchorY: spec.anchorY,
    frames: [],
  };
  const frames = baseLayout.frames.some((frame) => frame.entry === spec.entry)
    ? baseLayout.frames
    : [
        ...baseLayout.frames,
        {
          entry: spec.entry,
          width: spec.width,
          height: spec.height,
          anchorX: spec.anchorX,
          anchorY: spec.anchorY,
        },
      ];
  return {
    ...asset,
    animations,
    eventActions: { ...asset.eventActions, "pet.hit": spec.entry },
    layout: { ...baseLayout, frames },
    actionBounds: {
      ...asset.actionBounds,
      [spec.entry]: {
        width: spec.width,
        height: spec.height,
        bounds: spec.bounds,
      },
    },
  };
}
