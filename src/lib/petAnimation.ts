import { petAnimationDuration } from "./backend";

export const PET_ACTION_FALLBACK_MS = 3000;

const durations = new Map<string, Promise<number>>();

/** 一轮 GIF 的时长；同一次运行里每个素材动作只向后端询问一次。 */
export function petActionDuration(assetId: string, entry: string): Promise<number> {
  const key = `${assetId}\0${entry}`;
  const cached = durations.get(key);
  if (cached) return cached;

  const duration = petAnimationDuration(assetId, entry)
    .then((value) => Number.isFinite(value) && value >= 20 ? value : PET_ACTION_FALLBACK_MS)
    .catch(() => PET_ACTION_FALLBACK_MS);
  durations.set(key, duration);
  return duration;
}
