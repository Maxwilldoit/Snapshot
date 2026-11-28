import dshCheekHitAlphaUrl from "../assets/pet-hit/dsh-cheek.alpha.webm";
import dshCheekHitUrl from "../assets/pet-hit/dsh-cheek.webm";
import dshForeheadHitAlphaUrl from "../assets/pet-hit/dsh-forehead.alpha.webm";
import dshForeheadHitUrl from "../assets/pet-hit/dsh-forehead.webm";
import dshHeadtopHitAlphaUrl from "../assets/pet-hit/dsh-headtop.alpha.webm";
import dshHeadtopHitUrl from "../assets/pet-hit/dsh-headtop.webm";
import dshOuchHitAlphaUrl from "../assets/pet-hit/dsh-ouch.alpha.webm";
import dshOuchHitUrl from "../assets/pet-hit/dsh-ouch.webm";
import type { PetAsset, PetLayout } from "../types";
import type { MediaBounds } from "./petSize";
import type { ContactEdge } from "./petThrowPhysics";

export type CatalogSpriteId = never;

type BuiltinHitId = "dsh-ouch" | "dsh-forehead" | "dsh-cheek" | "dsh-headtop";

export type PetHurtMode = "wince" | "dizzy";

const BUILTIN_HIT_PREFIX = "__builtin_hit__:";
export const DSH_OUCH_ACTION_FILE = "碰撞回应-吃痛抚头.webm";
export const DSH_OUCH_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}${DSH_OUCH_ACTION_FILE}`;
export const DSH_FOREHEAD_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-forehead.webm`;
export const DSH_CHEEK_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-cheek.webm`;
export const DSH_HEADTOP_HIT_ENTRY = `${BUILTIN_HIT_PREFIX}dsh-headtop.webm`;

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
  "dsh-ouch": {
    id: "dsh-ouch",
    entry: DSH_OUCH_HIT_ENTRY,
    url: dshOuchHitUrl,
    alphaUrl: dshOuchHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 319,
    anchorY: 329,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 7875,
    bounds: { left: 0.315625, top: 0.169444, width: 0.382812, height: 0.747222 },
  },
  "dsh-forehead": {
    id: "dsh-forehead",
    entry: DSH_FOREHEAD_HIT_ENTRY,
    url: dshForeheadHitUrl,
    alphaUrl: dshForeheadHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 319,
    anchorY: 329,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 7958,
    bounds: { left: 0.315625, top: 0.169444, width: 0.360938, height: 0.747222 },
  },
  "dsh-cheek": {
    id: "dsh-cheek",
    entry: DSH_CHEEK_HIT_ENTRY,
    url: dshCheekHitUrl,
    alphaUrl: dshCheekHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 319,
    anchorY: 329,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 7833,
    bounds: { left: 0.315625, top: 0.169444, width: 0.35625, height: 0.747222 },
  },
  "dsh-headtop": {
    id: "dsh-headtop",
    entry: DSH_HEADTOP_HIT_ENTRY,
    url: dshHeadtopHitUrl,
    alphaUrl: dshHeadtopHitAlphaUrl,
    width: 640,
    height: 360,
    anchorX: 319,
    anchorY: 329,
    baseWidth: 640,
    baseHeight: 360,
    durationMs: 7833,
    bounds: { left: 0.325, top: 0.172222, width: 0.354687, height: 0.744444 },
  },
};

function resolveSpec(entry: string | null | undefined): BuiltinHurtSpriteSpec | null {
  if (!entry || !entry.startsWith(BUILTIN_HIT_PREFIX)) return null;
  const stem = entry.slice(BUILTIN_HIT_PREFIX.length).replace(/\.webm$/i, "");
  if (stem === "碰撞回应-吃痛抚头" || stem === "dsh-ouch") return BUILTIN_SPECS["dsh-ouch"];
  return BUILTIN_SPECS[stem as BuiltinHitId] ?? null;
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

function hasZipOuchEntry(animations: readonly string[]): boolean {
  return animations.some(
    (entry) => !isBuiltinHurtEntry(entry) && /(?:^|[\\/])碰撞回应-吃痛抚头\.webm$/i.test(entry),
  );
}

/** 为伴侣页动作列表补齐已采纳的「碰撞回应-吃痛抚头」；若素材包已含同名文件则不重复追加。 */
export function augmentAssetWithAdoptedHit(
  asset: PetAsset | undefined,
  behaviorId?: string | null,
): PetAsset | undefined {
  if (!asset || behaviorId !== "dsh-pet" || hasZipOuchEntry(asset.animations)) return asset;
  return appendSpecLayout(asset, [BUILTIN_SPECS["dsh-ouch"]]);
}

/** 为大肥鱼（dsh-pet）注入随应用打包的 4 段站立抚头碰撞透明视频、脚底锚点与透明包围盒。 */
export function augmentAssetWithBuiltinHurt(
  asset: PetAsset | undefined,
  behaviorId?: string | null,
): PetAsset | undefined {
  if (!asset || behaviorId !== "dsh-pet") return asset;
  const specs: BuiltinHurtSpriteSpec[] = [
    ...(hasZipOuchEntry(asset.animations) ? [] : [BUILTIN_SPECS["dsh-ouch"]]),
    BUILTIN_SPECS["dsh-forehead"],
    BUILTIN_SPECS["dsh-cheek"],
    BUILTIN_SPECS["dsh-headtop"],
  ];
  return appendSpecLayout(asset, specs);
}
