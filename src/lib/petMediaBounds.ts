import { petVideoPixels } from "./petVideoAlpha";
import type { MediaBounds } from "./petSize";

/** Share one small canvas between readiness and animation sampling. Read before
 * promoting a decoded frame: a full-canvas fallback can put both crossfade layers
 * outside the still-cropped native window for a frame. */
export function createPetAlphaReader() {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  return (media: HTMLImageElement | HTMLVideoElement): MediaBounds | null => {
    const video = media instanceof HTMLVideoElement;
    if (video ? media.readyState < 2 : !media.complete) return null;
    const sourceWidth = video ? media.videoWidth : media.naturalWidth;
    const sourceHeight = video ? media.videoHeight : media.naturalHeight;
    if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) throw new Error("Pet alpha canvas is unavailable");
    const scale = Math.min(1, 192 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let pixels: Uint8ClampedArray;
    try {
      context.clearRect(0, 0, width, height);
      context.drawImage(video ? petVideoPixels(media) : media, 0, 0, width, height);
      pixels = context.getImageData(0, 0, width, height).data;
    } catch (error) {
      // A cross-origin image must not taint this shared reader for every later clip.
      canvas = null;
      context = null;
      throw error;
    }
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    return right < left || bottom < top ? null : {
      left: left / width, top: top / height,
      width: (right + 1 - left) / width, height: (bottom + 1 - top) / height,
    };
  };
}
