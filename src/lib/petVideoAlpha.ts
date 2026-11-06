const alphaCanvases = new WeakMap<HTMLVideoElement, HTMLCanvasElement>();

/** Hit testing must sample the composited canvas, not WebKit's opaque colour decoder. */
export const petVideoPixels = (video: HTMLVideoElement): CanvasImageSource => alphaCanvases.get(video) ?? video;

export function registerPetAlpha(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  alphaCanvases.set(video, canvas);
  return () => alphaCanvases.delete(video);
}

/** Use the encoded opacity, never a black colour key: eyes/outlines stay opaque. */
export function applyPetAlpha(colour: Uint8ClampedArray, mask: Uint8ClampedArray) {
  if (colour.length !== mask.length || colour.length % 4 !== 0) throw new Error("Invalid pet alpha frame");
  for (let index = 3; index < colour.length; index += 4) colour[index] = mask[index - 3];
}
