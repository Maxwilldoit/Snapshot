import dshCheekHitAlphaUrl from "../assets/pet-hit/dsh-cheek.alpha.webm";
import dshCheekHitUrl from "../assets/pet-hit/dsh-cheek.webm";
import dshForeheadHitAlphaUrl from "../assets/pet-hit/dsh-forehead.alpha.webm";
import dshForeheadHitUrl from "../assets/pet-hit/dsh-forehead.webm";
import dshHeadtopHitAlphaUrl from "../assets/pet-hit/dsh-headtop.alpha.webm";
import dshHeadtopHitUrl from "../assets/pet-hit/dsh-headtop.webm";
import dshSitHitAlphaUrl from "../assets/pet-hit/dsh-sit.alpha.webm";
import dshSitHitUrl from "../assets/pet-hit/dsh-sit.webm";
import type { PetAsset, PetLayout } from "../types";
import type { MediaBounds } from "./petSize";
import type { ContactEdge } from "./petThrowPhysics";

export type CatalogSpriteId = never;

type BuiltinHitId = "dsh-forehead" | "dsh-cheek" | "dsh-headtop" | "dsh-sit";

export type PetHurtMode = "wince" | "dizzy";

const BUILTIN_HIT_PREFIX = "__builtin_hit__:";
export const DSH_FOREHEAD_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-forehead.webm`;
export const DSH_CHEEK_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-cheek.webm`;
export const DSH_HEADTOP_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-headtop.webm`;
export const DSH_SIT_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-sit.webm`;

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
  "dsh-forehead": {
    id: "dsh-forehead",
    entry: DSH_FOREHEAD_HIT_ENTRY,
    url: dshForeheadHitUrl,
    alphaUrl: dshForeheadHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 8524,
    bounds: { left: 0.317188, top: 0.152778, width: 0.360938, height: 0.769444 },
  },
  "dsh-cheek": {
    id: "dsh-cheek",
    entry: DSH_CHEEK_HIT_ENTRY,
    url: dshCheekHitUrl,
    alphaUrl: dshCheekHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 7857,
    bounds: { left: 0.33125, top: 0.166667, width: 0.353125, height: 0.752778 },
  },
  "dsh-headtop": {
    id: "dsh-headtop",
    entry: DSH_HEADTOP_HIT_ENTRY,
    url: dshHeadtopHitUrl,
    alphaUrl: dshHeadtopHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 8524,
    bounds: { left: 0.33125, top: 0.166667, width: 0.339062, height: 0.752778 },
  },
  "dsh-sit": {
    id: "dsh-sit",
    entry: DSH_SIT_HIT_ENTRY,
    url: dshSitHitUrl,
    alphaUrl: dshSitHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 320,
    anchorY: 330,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 8286,
    bounds: { left: 0.235937, top: 0.094444, width: 0.457813, height: 0.855556 },
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

/** 为大肥鱼（dsh-pet）注入随应用打包的 4 段原色专属碰撞受击透明视频、脚底锚点与透明包围盒。 */
export function augmentAssetWithBuiltinHurt(
  asset: PetAsset | undefined,
  behaviorId?: string | null,
): PetAsset | undefined {
  if (!asset || behaviorId !== "dsh-pet") return asset;
  return appendSpecLayout(asset, [
    BUILTIN_SPECS["dsh-forehead"],
    BUILTIN_SPECS["dsh-cheek"],
    BUILTIN_SPECS["dsh-headtop"],
    BUILTIN_SPECS["dsh-sit"],
  ]);
}
