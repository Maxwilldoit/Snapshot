import { describe, expect, it, vi } from "vitest";
import { createPetAlphaReader, unionMediaBounds } from "./petMediaBounds";
import { registerPetAlpha } from "./petVideoAlpha";

function decoded<T extends HTMLImageElement | HTMLVideoElement>(media: T, width = 384, height = 192): T {
  const values = media instanceof HTMLVideoElement
    ? { readyState: 2, videoWidth: width, videoHeight: height }
    : { complete: true, naturalWidth: width, naturalHeight: height };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(media, key, { configurable: true, value });
  return media;
}

function pixels() {
  const data = new Uint8ClampedArray(192 * 96 * 4);
  for (let y = 12; y < 84; y++) {
    for (let x = 64; x < 128; x++) data[(y * 192 + x) * 4 + 3] = 255;
  }
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return { context, getContext, data };
}

describe("pet first-frame alpha bounds", () => {
  it("unions brief action extremes instead of shrinking to the latest frame", () => {
    const first = { left: .4, top: .2, width: .2, height: .3 };
    const second = { left: .1, top: .1, width: .25, height: .5 };
    const third = { left: .65, top: .4, width: .3, height: .2 };
    const union = unionMediaBounds(unionMediaBounds(first, second), third);
    expect(union.left).toBeCloseTo(.1);
    expect(union.top).toBeCloseTo(.1);
    expect(union.width).toBeCloseTo(.85);
    expect(union.height).toBeCloseTo(.5);
    expect(unionMediaBounds(null, first)).toBe(first);
  });

  it("measures decoded images before display and reuses a downsampled canvas", () => {
    const { context, getContext } = pixels();
    const read = createPetAlphaReader();
    const image = decoded(document.createElement("img"));
    expect(read(image)).toEqual({ left: 1 / 3, top: 1 / 8, width: 1 / 3, height: 3 / 4 });
    const canvas = getContext.mock.instances[0] as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([192, 96]);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 192, 96);
    read(decoded(document.createElement("img")));
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it("reads macOS composited pixels, not the opaque video colour plane", () => {
    const { context } = pixels();
    const colour = decoded(document.createElement("video"));
    const canvas = document.createElement("canvas");
    const release = registerPetAlpha(colour, canvas);
    try {
      expect(createPetAlphaReader()(colour)).toEqual({ left: 1 / 3, top: 1 / 8, width: 1 / 3, height: 3 / 4 });
      expect(context.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 192, 96);
    } finally { release(); }
  });

  it("does not treat an undecoded frame as opaque or allocate a canvas for it", () => {
    const { getContext } = pixels();
    const read = createPetAlphaReader();
    expect(read(document.createElement("video"))).toBeNull();
    expect(read(document.createElement("img"))).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("ignores nearly transparent pixels and leaves empty frames unmeasured", () => {
    const { data } = pixels();
    data[3] = 8;
    const read = createPetAlphaReader();
    const image = decoded(document.createElement("img"));
    expect(read(image)?.left).toBe(1 / 3);
    data.fill(0);
    expect(read(image)).toBeNull();
  });

  it("allows callers to fall back when canvas access is unsupported or tainted", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const read = createPetAlphaReader();
    expect(() => read(decoded(document.createElement("img")))).toThrow("unavailable");
    const { context } = pixels();
    context.getImageData.mockImplementation(() => { throw new DOMException("Tainted canvas", "SecurityError"); });
    expect(() => createPetAlphaReader()(decoded(document.createElement("img")))).toThrow("Tainted canvas");
  });

  it("replaces a tainted canvas instead of breaking alpha reads for all later actions", () => {
    const { context, getContext } = pixels();
    context.getImageData.mockImplementationOnce(() => { throw new DOMException("Tainted canvas", "SecurityError"); });
    const read = createPetAlphaReader();
    expect(() => read(decoded(document.createElement("img")))).toThrow("Tainted canvas");
    expect(read(decoded(document.createElement("img")))?.left).toBe(1 / 3);
    expect(getContext).toHaveBeenCalledTimes(2);
  });
});
