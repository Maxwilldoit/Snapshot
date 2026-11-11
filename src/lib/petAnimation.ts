import { petAnimationDuration } from "./backend";
import { isWebmEntry, petUrl } from "./media";
import { acquireMediaUrl } from "./mediaBlob";

const PET_ACTION_FALLBACK_MS = 3000;

const durations = new Map<string, Promise<number>>();

/** WebM 的时长由 WebView 读取元数据；GIF 仍由 Rust 逐帧累计。 */
function webmDuration(src: string): Promise<number> {
  const media = acquireMediaUrl(src);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      media.release();
      resolve(value);
    };
    const fromMetadata = () => {
      const millis = video.duration * 1000;
      if (Number.isFinite(millis) && millis >= 20) finish(millis);
    };
    const timer = window.setTimeout(() => finish(PET_ACTION_FALLBACK_MS), 2000);
    video.preload = "metadata";
    video.muted = true;
    video.addEventListener("loadedmetadata", fromMetadata, { once: true });
    video.addEventListener("durationchange", fromMetadata);
    video.addEventListener("error", () => finish(PET_ACTION_FALLBACK_MS), { once: true });
    const load = (url: string) => {
      if (settled) return;
      video.src = url;
      video.load();
    };
    if (media.direct) load(src);
    else void media.url.then(load);
  });
}

/** 一轮动作的时长；同一次运行里每个素材动作只询问一次。 */
export function petActionDuration(assetId: string, entry: string): Promise<number> {
  const key = `${assetId}\0${entry}`;
  const cached = durations.get(key);
  if (cached) return cached;

  const measured = isWebmEntry(entry)
    ? webmDuration(petUrl(assetId, entry))
    : petAnimationDuration(assetId, entry);
  const duration = measured
    .then((value) => Number.isFinite(value) && value >= 20 ? value : PET_ACTION_FALLBACK_MS)
    .catch(() => PET_ACTION_FALLBACK_MS);
  durations.set(key, duration);
  return duration;
}
