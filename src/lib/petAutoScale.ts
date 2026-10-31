import type { PetAsset } from "../types";
import { isWebmEntry, petUrl } from "./media";

type Bounds = { left: number; top: number; width: number; height: number };

const TARGET_OCCUPANCY = 0.85;
const SAMPLE_SIDE = 128;
const SAMPLE_INTERVAL_MS = 180;
const TIMEOUT_MS = 2500;

/** 源像素中的可见长边与画布长边相比，补足透明留白；太小的边界不作自动校准。 */
export function adaptivePetScale(width: number, height: number, bounds: Bounds): number | null {
  if (
    ![width, height, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) ||
    width <= 0 || height <= 0 || bounds.left < 0 || bounds.top < 0 ||
    bounds.width < 2 || bounds.height < 2 || bounds.width * bounds.height < 16 ||
    bounds.width > width - bounds.left + 1e-6 || bounds.height > height - bounds.top + 1e-6
  ) return null;

  const occupancy = Math.max(bounds.width, bounds.height) / Math.max(width, height);
  if (occupancy < 0.05) return null;
  if (occupancy >= TARGET_OCCUPANCY) return 100;
  return Math.max(100, Math.min(200, Math.round(TARGET_OCCUPANCY / occupancy * 10) * 10));
}

/** 三帧共用像素 union；既保留呼吸动作的外沿，也避免把同一个噪点重复计数。 */
function alphaSampler(source: CanvasImageSource, width: number, height: number) {
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("Invalid pet dimensions");
  }
  const ratio = Math.min(1, SAMPLE_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas unavailable");

  const sampledWidth = canvas.width;
  const sampledHeight = canvas.height;
  const pixels = new Uint8Array(sampledWidth * sampledHeight);
  let visible = 0;
  let left = sampledWidth;
  let top = sampledHeight;
  let right = -1;
  let bottom = -1;

  return {
    sample() {
      context.clearRect(0, 0, sampledWidth, sampledHeight);
      context.drawImage(source, 0, 0, sampledWidth, sampledHeight);
      const { data } = context.getImageData(0, 0, sampledWidth, sampledHeight);
      if (data.length !== pixels.length * 4) throw new Error("Invalid pixel data");
      for (let index = 0; index < pixels.length; index += 1) {
        if (data[index * 4 + 3] <= 8 || pixels[index]) continue;
        pixels[index] = 1;
        visible += 1;
        const x = index % sampledWidth;
        const y = Math.floor(index / sampledWidth);
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    },
    scale() {
      if (visible < Math.max(8, Math.ceil(pixels.length * 0.001))) return null;
      return adaptivePetScale(width, height, {
        left: left / sampledWidth * width,
        top: top / sampledHeight * height,
        width: (right - left + 1) / sampledWidth * width,
        height: (bottom - top + 1) / sampledHeight * height,
      });
    },
  };
}

/** 只测 asset.entry 的默认待机动画；缓存、作者布局及其它动作由调用方处理。 */
export function measurePetScale(asset: PetAsset): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const listeners: Array<() => void> = [];
    const releases: Array<() => void> = [];

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // 先拆监听，避免释放 src 时产生的媒体事件重新启动采样。
      for (const cleanup of [...listeners, ...releases]) {
        try { cleanup(); } catch { /* 一项释放失败仍继续释放其余资源。 */ }
      }
      resolve(value);
    };
    const guarded = (action: () => void) => () => {
      if (settled) return;
      try { action(); } catch { finish(null); }
    };
    const later = (action: () => void, delay: number) => {
      if (settled) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        guarded(action)();
      }, delay);
      timers.add(timer);
    };
    const on = (target: EventTarget, event: string, action: () => void, once = false) => {
      const listener = guarded(action);
      target.addEventListener(event, listener, { once });
      listeners.push(() => target.removeEventListener(event, listener));
    };
    const sampleOverTime = (sampler: ReturnType<typeof alphaSampler>) => {
      sampler.sample();
      later(() => {
        sampler.sample();
        later(() => {
          sampler.sample();
          finish(sampler.scale());
        }, SAMPLE_INTERVAL_MS);
      }, SAMPLE_INTERVAL_MS);
    };

    try {
      later(() => finish(null), TIMEOUT_MS);
      const src = petUrl(asset.id, asset.entry);
      if (isWebmEntry(asset.entry)) {
        const video = document.createElement("video");
        releases.push(() => video.pause(), () => video.removeAttribute("src"), () => video.load());
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.hidden = true;
        video.preload = "auto";
        on(video, "error", () => finish(null));
        on(video, "loadeddata", () => {
          const sampler = alphaSampler(video, video.videoWidth, video.videoHeight);
          const duration = video.duration;
          if (Number.isFinite(duration) && duration > 0) {
            // 已有首帧；其余两帧在时长的 1/3、2/3 处，避开结尾的空帧。
            let sampled = 1;
            sampler.sample();
            on(video, "seeked", () => {
              sampler.sample();
              sampled += 1;
              if (sampled === 3) finish(sampler.scale());
              else video.currentTime = duration * 2 / 3;
            });
            video.currentTime = duration / 3;
          } else {
            // 部分 WebM 没有时长元数据，按静音 autoplay 规则短暂播放后取样。
            void video.play().then(guarded(() => sampleOverTime(sampler)), () => finish(null));
          }
        }, true);
        video.src = src;
        if (!settled) video.load();
      } else {
        const image = document.createElement("img");
        releases.push(() => image.removeAttribute("src"));
        image.crossOrigin = "anonymous";
        on(image, "error", () => finish(null));
        on(image, "load", () => {
          sampleOverTime(alphaSampler(image, image.naturalWidth, image.naturalHeight));
        }, true);
        image.src = src;
      }
    } catch {
      finish(null);
    }
  });
}
