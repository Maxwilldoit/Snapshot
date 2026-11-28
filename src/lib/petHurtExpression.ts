import dshFloorHitAlphaUrl from "../assets/pet-hit/dsh-floor.alpha.webm";
import dshFloorHitUrl from "../assets/pet-hit/dsh-floor.webm";
import dshWallHitAlphaUrl from "../assets/pet-hit/dsh-wall.alpha.webm";
import dshWallHitUrl from "../assets/pet-hit/dsh-wall.webm";
import type { PetAsset, PetLayout } from "../types";
import type { MediaBounds } from "./petSize";
import type { ContactEdge } from "./petThrowPhysics";

export type CatalogSpriteId = never;

type BuiltinHitId = "dsh-wall" | "dsh-floor";

export type PetHurtMode = "wince" | "dizzy";

const BUILTIN_HIT_PREFIX = "__builtin_hit__:";
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
};

function resolveSpec(entry: string | null | undefined): BuiltinHurtSpriteSpec | null {
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const id = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "") as BuiltinHitId;
  return BUILTIN_SPECS[id] ?? null;
}

/** 当前仅对大肥鱼启用内置受击视频；素材库普通 GIF 角色暂不启用内置受击覆盖。 */
export function identifyCatalogSprite(
  _asset: Pick<PetAsset, "source" | "entry" | "animations"> | null | undefined,
): CatalogSpriteId | null {
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
    layout: { ...baseLayout, frames },
    actionBounds,
  };
}

/** 为大肥鱼（dsh-pet）注入随应用打包的专属碰撞受击透明视频、脚底锚点与透明包围盒。 */
export function augmentAssetWithBuiltinHurt(
  asset: PetAsset | undefined,
  behaviorId?: string | null,
): PetAsset | undefined {
  if (!asset || behaviorId !== "dsh-pet") return asset;
  return appendSpecLayout(asset, [BUILTIN_SPECS["dsh-wall"], BUILTIN_SPECS["dsh-floor"]]);
}
