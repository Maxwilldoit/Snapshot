import clawdHitUrl from "../assets/pet-hit/clawd.gif";
import dshFloorHitAlphaUrl from "../assets/pet-hit/dsh-floor.alpha.webm";
import dshFloorHitUrl from "../assets/pet-hit/dsh-floor.webm";
import dshWallHitAlphaUrl from "../assets/pet-hit/dsh-wall.alpha.webm";
import dshWallHitUrl from "../assets/pet-hit/dsh-wall.webm";
import hoop23HitUrl from "../assets/pet-hit/hoop-23.gif";
import kuroBladeHitUrl from "../assets/pet-hit/kuro-blade.gif";
import makimaHitUrl from "../assets/pet-hit/makima-pixel.gif";
import momoHitUrl from "../assets/pet-hit/momo.gif";
import nashorV1HitUrl from "../assets/pet-hit/nashor-v1.gif";
import nashorV2HitUrl from "../assets/pet-hit/nashor-v2.gif";
import yamadaClerkHitUrl from "../assets/pet-hit/yamada-clerk.gif";
import yamadaPixelHitUrl from "../assets/pet-hit/yamada-pixel.gif";
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

type BuiltinHitId = CatalogSpriteId | "dsh-wall" | "dsh-floor";

export type PetHurtMode = "wince" | "dizzy";

export const BUILTIN_HIT_PREFIX = "__builtin_hit__:";
export const DSH_WALL_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-wall.webm`;
export const DSH_FLOOR_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-floor.webm`;

/** 应用图标碰撞受击表情持续停留毫秒数。 */
export const HURT_EXPRESSION_MS = 1650;
/** 应用图标受击表情微颤切换间隔（ms）。 */
export const HURT_FRAME_INTERVAL_MS = 130;

interface BuiltinHurtSpriteSpec {
  id: BuiltinHitId;
  entry: string;
  url: string;
  alphaUrl?: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  baseWidth: number;
  baseHeight: number;
  durationMs: number;
  bounds: MediaBounds;
}

const BUILTIN_SPECS: Readonly<Record<BuiltinHitId, BuiltinHurtSpriteSpec>> = {
  "dsh-wall": {
    id: "dsh-wall",
    entry: DSH_WALL_HIT_ENTRY,
    url: dshWallHitUrl,
    alphaUrl: dshWallHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 4375,
    bounds: { left: 0.292187, top: 0.155556, width: 0.404687, height: 0.788889 },
  },
  "dsh-floor": {
    id: "dsh-floor",
    entry: DSH_FLOOR_HIT_ENTRY,
    url: dshFloorHitUrl,
    alphaUrl: dshFloorHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 4375,
    bounds: { left: 0.096875, top: 0.175, width: 0.821875, height: 0.8 },
  },
  "makima-pixel": {
    id: "makima-pixel",
    entry: `${BUILTIN_HIT_PREFIX}makima-pixel`,
    url: makimaHitUrl,
    width: 220,
    height: 292,
    anchorX: 116.5,
    anchorY: 287,
    baseWidth: 202,
    baseHeight: 292,
    durationMs: 4400,
    bounds: { left: 0.063636, top: 0.027397, width: 0.913636, height: 0.958904 },
  },
  "yamada-clerk": {
    id: "yamada-clerk",
    entry: `${BUILTIN_HIT_PREFIX}yamada-clerk`,
    url: yamadaClerkHitUrl,
    width: 208,
    height: 308,
    anchorX: 102,
    anchorY: 302,
    baseWidth: 208,
    baseHeight: 306,
    durationMs: 4400,
    bounds: { left: 0.033654, top: 0.064935, width: 0.879808, height: 0.915584 },
  },
  "yamada-pixel": {
    id: "yamada-pixel",
    entry: `${BUILTIN_HIT_PREFIX}yamada-pixel`,
    url: yamadaPixelHitUrl,
    width: 202,
    height: 294,
    anchorX: 87.5,
    anchorY: 288,
    baseWidth: 163,
    baseHeight: 292,
    durationMs: 4400,
    bounds: { left: 0.108911, top: 0.098639, width: 0.866337, height: 0.887755 },
  },
  clawd: {
    id: "clawd",
    entry: `${BUILTIN_HIT_PREFIX}clawd`,
    url: clawdHitUrl,
    width: 284,
    height: 256,
    anchorX: 137.1,
    anchorY: 184,
    baseWidth: 256,
    baseHeight: 256,
    durationMs: 4400,
    bounds: { left: 0.014085, top: 0.109375, width: 0.96831, height: 0.722656 },
  },
  "nashor-v1": {
    id: "nashor-v1",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v1`,
    url: nashorV1HitUrl,
    width: 804,
    height: 482,
    anchorX: 461.2,
    anchorY: 440.5,
    baseWidth: 420,
    baseHeight: 420,
    durationMs: 4400,
    bounds: { left: 0.004975, top: 0.008299, width: 0.99005, height: 0.981328 },
  },
  "nashor-v2": {
    id: "nashor-v2",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v2`,
    url: nashorV2HitUrl,
    width: 696,
    height: 488,
    anchorX: 350.9,
    anchorY: 458,
    baseWidth: 473,
    baseHeight: 473,
    durationMs: 4400,
    bounds: { left: 0.00431, top: 0.036885, width: 0.903736, height: 0.952869 },
  },
  "hoop-23": {
    id: "hoop-23",
    entry: `${BUILTIN_HIT_PREFIX}hoop-23`,
    url: hoop23HitUrl,
    width: 320,
    height: 392,
    anchorX: 174.5,
    anchorY: 380.2,
    baseWidth: 314,
    baseHeight: 314,
    durationMs: 4400,
    bounds: { left: 0.190625, top: 0.010204, width: 0.790625, height: 0.964286 },
  },
  "kuro-blade": {
    id: "kuro-blade",
    entry: `${BUILTIN_HIT_PREFIX}kuro-blade`,
    url: kuroBladeHitUrl,
    width: 406,
    height: 386,
    anchorX: 219.6,
    anchorY: 380.2,
    baseWidth: 220,
    baseHeight: 359,
    durationMs: 4400,
    bounds: { left: 0.007389, top: 0.010363, width: 0.980296, height: 0.976684 },
  },
  momo: {
    id: "momo",
    entry: `${BUILTIN_HIT_PREFIX}momo`,
    url: momoHitUrl,
    width: 264,
    height: 224,
    anchorX: 141,
    anchorY: 217.4,
    baseWidth: 200,
    baseHeight: 206,
    durationMs: 4400,
    bounds: { left: 0.011364, top: 0.017857, width: 0.973485, height: 0.959821 },
  },
};

function resolveSpec(entry: string | null | undefined): BuiltinHurtSpriteSpec | null {
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const id = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "") as BuiltinHitId;
  return BUILTIN_SPECS[id] ?? null;
}

/** 识别官方素材库中的 9 款 GIF 宠物（兼容在线安装 source 锚点与本地离线 ZIP 导入）。 */
export function identifyCatalogSprite(
  asset: Pick<PetAsset, "source" | "entry" | "animations"> | null | undefined,
): CatalogSpriteId | null {
  if (!asset) return null;
  const hashIndex = asset.source?.indexOf("#") ?? -1;
  if (hashIndex >= 0 && asset.source) {
    const rawId = asset.source.slice(hashIndex + 1).trim();
    if (rawId in BUILTIN_SPECS && rawId !== "dsh-wall" && rawId !== "dsh-floor") {
      return rawId as CatalogSpriteId;
    }
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
  return resolveSpec(entry)?.url ?? null;
}

export function builtinHurtAlphaUrl(entry: string | null | undefined): string | null {
  if (!/Macintosh|Mac OS X/.test(navigator.userAgent) || /jsdom/i.test(navigator.userAgent)) return null;
  return resolveSpec(entry)?.alphaUrl ?? null;
}

export function builtinHurtDurationMs(entry: string | null | undefined): number | null {
  return resolveSpec(entry)?.durationMs ?? null;
}

/** 按碰撞方向、冲击速度与连续碰撞序号挑选紧闭忍痛（wince）或眩晕眼花（dizzy）模式。 */
export function pickPetHurtMode(edge: ContactEdge, speed: number, sequence = 0): PetHurtMode {
  if (edge === "floor" || edge === "ceiling" || speed >= 900) {
    return sequence % 3 === 1 ? "wince" : "dizzy";
  }
  return sequence % 3 === 2 ? "dizzy" : "wince";
}

function appendSpecLayout(
  asset: PetAsset,
  specs: readonly BuiltinHurtSpriteSpec[],
  registerEventHit: boolean,
): PetAsset {
  let animations = asset.animations;
  for (const spec of specs) {
    if (!animations.includes(spec.entry)) animations = [...animations, spec.entry];
  }
  const first = specs[0];
  const baseLayout: PetLayout = asset.layout ?? {
    baseWidth: first.baseWidth,
    baseHeight: first.baseHeight,
    anchorX: first.anchorX,
    anchorY: first.anchorY,
    frames: [],
  };
  let frames = baseLayout.frames;
  const actionBounds = { ...asset.actionBounds };
  for (const spec of specs) {
    if (!frames.some((frame) => frame.entry === spec.entry)) {
      frames = [
        ...frames,
        {
          entry: spec.entry,
          width: spec.width,
          height: spec.height,
          anchorX: spec.anchorX,
          anchorY: spec.anchorY,
        },
      ];
    }
    actionBounds[spec.entry] = {
      width: spec.width,
      height: spec.height,
      bounds: spec.bounds,
    };
  }
  return {
    ...asset,
    animations,
    ...(registerEventHit ? { eventActions: { ...asset.eventActions, "pet.hit": first.entry } } : {}),
    layout: { ...baseLayout, frames },
    actionBounds,
  };
}

/**
 * 为大肥鱼（dsh-pet）与素材库 9 款 GIF 宠物注入随应用打包的零前摇受击动作动画、脚底锚点与透明包围盒：
 * - 不改动磁盘上的原压缩包与 settings.json；
 * - 若压缩包作者已显式声明 pet.hit，则优先尊重包内配置。
 */
export function augmentAssetWithBuiltinHurt(
  asset: PetAsset | undefined,
  behaviorId?: string | null,
): PetAsset | undefined {
  if (!asset) return asset;
  if (behaviorId === "dsh-pet") {
    return appendSpecLayout(asset, [BUILTIN_SPECS["dsh-wall"], BUILTIN_SPECS["dsh-floor"]], false);
  }
  if (asset.eventActions?.["pet.hit"]) return asset;
  const spriteId = identifyCatalogSprite(asset);
  if (!spriteId) return asset;
  return appendSpecLayout(asset, [BUILTIN_SPECS[spriteId]], true);
}
