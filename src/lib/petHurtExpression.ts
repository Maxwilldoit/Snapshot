import clawdHitAlphaUrl from "../assets/pet-hit/clawd.alpha.webm";
import clawdHitUrl from "../assets/pet-hit/clawd.webm";
import dshFloorHitAlphaUrl from "../assets/pet-hit/dsh-floor.alpha.webm";
import dshFloorHitUrl from "../assets/pet-hit/dsh-floor.webm";
import dshWallHitAlphaUrl from "../assets/pet-hit/dsh-wall.alpha.webm";
import dshWallHitUrl from "../assets/pet-hit/dsh-wall.webm";
import hoop23HitAlphaUrl from "../assets/pet-hit/hoop-23.alpha.webm";
import hoop23HitUrl from "../assets/pet-hit/hoop-23.webm";
import makimaHitAlphaUrl from "../assets/pet-hit/makima-pixel.alpha.webm";
import makimaHitUrl from "../assets/pet-hit/makima-pixel.webm";
import nashorV1HitAlphaUrl from "../assets/pet-hit/nashor-v1.alpha.webm";
import nashorV1HitUrl from "../assets/pet-hit/nashor-v1.webm";
import nashorV2HitAlphaUrl from "../assets/pet-hit/nashor-v2.alpha.webm";
import nashorV2HitUrl from "../assets/pet-hit/nashor-v2.webm";
import yamadaClerkHitAlphaUrl from "../assets/pet-hit/yamada-clerk.alpha.webm";
import yamadaClerkHitUrl from "../assets/pet-hit/yamada-clerk.webm";
import yamadaPixelHitAlphaUrl from "../assets/pet-hit/yamada-pixel.alpha.webm";
import yamadaPixelHitUrl from "../assets/pet-hit/yamada-pixel.webm";
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
  | "hoop-23";

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
  alphaUrl: string;
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
    durationMs: 8571,
    bounds: { left: 0.334375, top: 0.166667, width: 0.359375, height: 0.786111 },
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
    durationMs: 8762,
    bounds: { left: 0.321875, top: 0, width: 0.36875, height: 0.955556 },
  },
  "makima-pixel": {
    id: "makima-pixel",
    entry: `${BUILTIN_HIT_PREFIX}makima-pixel.webm`,
    url: makimaHitUrl,
    alphaUrl: makimaHitAlphaUrl,
    width: 232,
    height: 292,
    anchorX: 116.5,
    anchorY: 287,
    baseWidth: 202,
    baseHeight: 292,
    durationMs: 8810,
    bounds: { left: 0.172414, top: 0.027397, width: 0.806034, height: 0.958904 },
  },
  "yamada-clerk": {
    id: "yamada-clerk",
    entry: `${BUILTIN_HIT_PREFIX}yamada-clerk.webm`,
    url: yamadaClerkHitUrl,
    alphaUrl: yamadaClerkHitAlphaUrl,
    width: 208,
    height: 308,
    anchorX: 102,
    anchorY: 302,
    baseWidth: 208,
    baseHeight: 306,
    durationMs: 8476,
    bounds: { left: 0.259615, top: 0.107143, width: 0.480769, height: 0.876623 },
  },
  "yamada-pixel": {
    id: "yamada-pixel",
    entry: `${BUILTIN_HIT_PREFIX}yamada-pixel.webm`,
    url: yamadaPixelHitUrl,
    alphaUrl: yamadaPixelHitAlphaUrl,
    width: 168,
    height: 294,
    anchorX: 87.5,
    anchorY: 288,
    baseWidth: 163,
    baseHeight: 292,
    durationMs: 8619,
    bounds: { left: 0.172619, top: 0.095238, width: 0.803571, height: 0.887755 },
  },
  clawd: {
    id: "clawd",
    entry: `${BUILTIN_HIT_PREFIX}clawd.webm`,
    url: clawdHitUrl,
    alphaUrl: clawdHitAlphaUrl,
    width: 256,
    height: 256,
    anchorX: 128,
    anchorY: 184,
    baseWidth: 256,
    baseHeight: 256,
    durationMs: 8714,
    bounds: { left: 0.046875, top: 0.191406, width: 0.9375, height: 0.53125 },
  },
  "nashor-v1": {
    id: "nashor-v1",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v1.webm`,
    url: nashorV1HitUrl,
    alphaUrl: nashorV1HitAlphaUrl,
    width: 554,
    height: 432,
    anchorX: 346.8,
    anchorY: 402.4,
    baseWidth: 420,
    baseHeight: 420,
    durationMs: 9048,
    bounds: { left: 0.005415, top: 0.006944, width: 0.962094, height: 0.958333 },
  },
  "nashor-v2": {
    id: "nashor-v2",
    entry: `${BUILTIN_HIT_PREFIX}nashor-v2.webm`,
    url: nashorV2HitUrl,
    alphaUrl: nashorV2HitAlphaUrl,
    width: 578,
    height: 546,
    anchorX: 232.9,
    anchorY: 458,
    baseWidth: 473,
    baseHeight: 473,
    durationMs: 9000,
    bounds: { left: 0.00692, top: 0.177656, width: 0.795848, height: 0.815018 },
  },
  "hoop-23": {
    id: "hoop-23",
    entry: `${BUILTIN_HIT_PREFIX}hoop-23.webm`,
    url: hoop23HitUrl,
    alphaUrl: hoop23HitAlphaUrl,
    width: 314,
    height: 314,
    anchorX: 174.5,
    anchorY: 303,
    baseWidth: 314,
    baseHeight: 314,
    durationMs: 9048,
    bounds: { left: 0.219745, top: 0.035032, width: 0.538217, height: 0.936306 },
  },
};

function resolveSpec(entry: string | null | undefined): BuiltinHurtSpriteSpec | null {
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const id = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "") as BuiltinHitId;
  return BUILTIN_SPECS[id] ?? null;
}

/** 识别已适配内置受击透明视频的素材库 GIF 宠物（兼容在线安装 source 锚点与本地离线 ZIP 导入）。 */
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
 * 为大肥鱼（dsh-pet）与已适配的 7 款素材库角色注入随应用打包的丝滑全长透明受击视频、脚底锚点与包围盒：
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
