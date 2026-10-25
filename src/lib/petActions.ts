import type { PetAsset } from "../types";
import { cycleEntries } from "./petWalk";

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
