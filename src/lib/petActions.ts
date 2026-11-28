import type { PetAsset } from "../types";
import { identifyCatalogSprite } from "./petHurtExpression";
import { cycleEntries } from "./petWalk";

const HIT_WORDS = new Set([
  "hit", "hurt", "impact", "collide", "collision", "crash", "bonk", "bump",
  "dizzy", "stun", "stunned", "frightened", "shock", "shocked", "ouch", "damage", "damaged", "knockback",
]);
const HIT_CJK = /受击|被撞|撞击|碰撞|挨打|受伤|眩晕|被吓|惊吓/;

/** 动作文件名是否表示碰撞受击反馈（按词切分，避免 white 误中 hit）。 */
function isHitEntry(entry: string): boolean {
  const stem = (entry.split(/[\\/]/).pop() ?? entry).replace(/\.[^.]+$/, "").toLowerCase();
  if (HIT_CJK.test(stem)) return true;
  return stem.split(/[^a-z0-9]+/).some((word) => HIT_WORDS.has(word));
}

/** 优先使用 pet.json 显式绑定的 pet.hit，其次匹配受击命名动作；非内置像素表情适配包回退到失败反馈动画。 */
export function pickHitAnimation(
  asset: Pick<PetAsset, "animations" | "eventActions" | "source" | "entry"> | null | undefined,
  current?: string | null,
  random: () => number = Math.random,
): string | null {
  if (!asset?.animations.length) return null;
  const mapped = asset.eventActions?.["pet.hit"];
  if (mapped && asset.animations.includes(mapped)) return mapped;
  const pool = asset.animations.filter(isHitEntry);
  if (pool.length) {
    const alternatives = pool.filter((entry) => entry !== current);
    const candidates = alternatives.length ? alternatives : pool;
    return candidates[Math.floor(random() * candidates.length)] ?? null;
  }
  if (identifyCatalogSprite(asset)) return null;
  const failure = asset.eventActions?.["capture.failure"];
  if (failure && asset.animations.includes(failure)) return failure;
  return null;
}

/** Animation clips that can be displayed normally; event-only and state clips stay reserved. */
export function ordinaryAnimations(
  asset: Pick<PetAsset, "animations" | "eventActions" | "stateActions"> | null | undefined,
) {
  const reserved = new Set([
    ...Object.values(asset?.eventActions ?? {}),
    ...Object.values(asset?.stateActions ?? {}),
  ]);
  return (asset?.animations ?? []).filter((entry) => !reserved.has(entry));
}

/** Animations available to a normal click; walking clips remain drag-only. */
export function clickableAnimations(
  asset: Pick<PetAsset, "animations" | "eventActions" | "stateActions"> | null | undefined,
) {
  return cycleEntries(ordinaryAnimations(asset));
}
