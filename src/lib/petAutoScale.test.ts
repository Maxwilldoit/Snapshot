import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetAsset } from "../types";
import { petUrl } from "./media";
import { adaptivePetScale, measurePetScale } from "./petAutoScale";

vi.mock("./media", async (importOriginal) => ({
  ...await importOriginal<typeof import("./media")>(),
  petUrl: vi.fn((id: string, entry?: string | null) => `https://pets.test/${id}/${entry ?? ""}`),
}));

type Rect = { left: number; top: number; width: number; height: number; alpha?: number };
const full: Rect = { left: 0, top: 0, width: 128, height: 128 };
const half: Rect = { left: 32, top: 48, width: 64, height: 32 };
const asset = (entry = "默认.gif"): PetAsset => ({
  id: "pet-1", name: "任意名字", path: "pet.zip", entry,
  animations: ["不用于测量.webm", entry, "其它动作.gif"],
});

function alphaFrame(width: number, height: number, rectangles: Rect[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const rect of rectangles) {
    for (let y = rect.top; y < Math.min(height, rect.top + rect.height); y += 1) {
      for (let x = rect.left; x < Math.min(width, rect.left + rect.width); x += 1) {
        data[(y * width + x) * 4 + 3] = rect.alpha ?? 255;
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

/** 只模拟媒体事件和像素；不使用 jsdom 的解码器、Canvas 或真实播放时钟。 */
function mediaFixture({
  width = 128, height = 128, duration = 3, frames = [[half]],
}: { width?: number; height?: number; duration?: number; frames?: Rect[][] } = {}) {
  const create = document.createElement.bind(document);
  const image = create("img");
  const video = create("video");
  const canvas = create("canvas");
  Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  Object.defineProperties(video, {
    videoWidth: { value: width }, videoHeight: { value: height }, duration: { value: duration },
    muted: { value: false, writable: true },
  });
  const loadedSources: Array<string | null> = [];
  const load = vi.spyOn(video, "load").mockImplementation(() => { loadedSources.push(video.getAttribute("src")); });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const play = vi.spyOn(video, "play").mockResolvedValue();
  const imageAdded = vi.spyOn(image, "addEventListener");
  const imageRemoved = vi.spyOn(image, "removeEventListener");
  const videoAdded = vi.spyOn(video, "addEventListener");
  const videoRemoved = vi.spyOn(video, "removeEventListener");
  let frame = 0;
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(),
    getImageData: vi.fn((_left: number, _top: number, sampledWidth: number, sampledHeight: number) =>
      alphaFrame(sampledWidth, sampledHeight, frames[Math.min(frame++, frames.length - 1)] ?? [])),
  };
  const getContext = vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    if (tag === "img") return image;
    if (tag === "video") return video;
    if (tag === "canvas") return canvas;
    return create(tag, options);
  });
  return { image, video, canvas, context, getContext, load, pause, play, loadedSources,
    imageAdded, imageRemoved, videoAdded, videoRemoved };
}

function expectReleased(fixture: ReturnType<typeof mediaFixture>, kind: "gif" | "webm") {
  const element = kind === "gif" ? fixture.image : fixture.video;
  const added = kind === "gif" ? fixture.imageAdded : fixture.videoAdded;
  const removed = kind === "gif" ? fixture.imageRemoved : fixture.videoRemoved;
  expect(element.getAttribute("src")).toBeNull();
  for (const [event, listener] of added.mock.calls) expect(removed).toHaveBeenCalledWith(event, listener);
  expect(vi.getTimerCount()).toBe(0);
  if (kind === "webm") {
    expect(fixture.pause).toHaveBeenCalledTimes(1);
    expect(fixture.loadedSources.at(-1)).toBeNull();
    expect(fixture.load).toHaveBeenCalledTimes(2);
  }
}

describe("默认待机动画的自动基准", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe("源像素边界计算", () => {
    it("可见长边占画布长边至少 85% 时保留 100%，不会缩小已有饱满素材", () => {
      expect(adaptivePetScale(200, 100, { left: 15, top: 10, width: 170, height: 80 })).toBe(100);
      expect(adaptivePetScale(128, 128, full)).toBe(100);
    });

    it("横竖画布都用最长边比较，以 85% 为目标按 10 取整并限制到 200%", () => {
      expect(adaptivePetScale(640, 360, { left: 160, top: 90, width: 320, height: 180 })).toBe(170);
      expect(adaptivePetScale(640, 360, { left: 200, top: 30, width: 200, height: 300 })).toBe(180);
      expect(adaptivePetScale(360, 640, { left: 30, top: 200, width: 300, height: 200 })).toBe(180);
      expect(adaptivePetScale(640, 360, { left: 100, top: 100, width: 64, height: 32 })).toBe(200);
    });

    it.each([
      [0, 128, half], [128, -1, half], [Infinity, 128, half], [128, NaN, half],
      [128, 128, { ...half, left: NaN }], [128, 128, { ...half, width: Infinity }],
      [128, 128, { ...half, left: -1 }], [128, 128, { ...half, top: -1 }],
      [128, 128, { ...half, left: 100 }], [128, 128, { ...half, top: 120 }],
      [128, 128, { ...half, width: 0 }], [128, 128, { ...half, height: -1 }],
      [128, 128, { left: 0, top: 0, width: 1, height: 100 }],
      [128, 128, { left: 0, top: 0, width: 3, height: 3 }],
      [1000, 1000, { left: 0, top: 0, width: 20, height: 20 }],
    ] as const)("无效、越界或过小的边界返回 null（%s × %s，%j）", (width, height, bounds) => {
      expect(adaptivePetScale(width, height, bounds)).toBeNull();
    });
  });

  it("GIF 跳过空白首帧，并合并后两帧的 alpha 边界而非逐帧放大", async () => {
    const fixture = mediaFixture({ frames: [[],
      [{ left: 16, top: 48, width: 40, height: 32 }],
      [{ left: 56, top: 40, width: 40, height: 48 }],
    ] });
    const pending = measurePetScale(asset());
    expect(petUrl).toHaveBeenCalledWith("pet-1", "默认.gif");
    expect(fixture.image.crossOrigin).toBe("anonymous");
    expect(fixture.image.getAttribute("src")).toBe("https://pets.test/pet-1/默认.gif");
    fixture.image.dispatchEvent(new Event("load"));
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(360);
    await expect(pending).resolves.toBe(140);
    expect(fixture.context.clearRect).toHaveBeenCalledTimes(3);
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(3);
    expectReleased(fixture, "gif");
  });

  it("缩小到长边 128，并将采样坐标还原为非正方形素材的源像素边界", async () => {
    const fixture = mediaFixture({ width: 640, height: 360,
      frames: [[{ left: 24, top: 18, width: 80, height: 40 }]] });
    const pending = measurePetScale(asset("随便命名.GIF"));
    fixture.image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(360);
    await expect(pending).resolves.toBe(140);
    expect(fixture.canvas.width).toBe(128);
    expect(fixture.canvas.height).toBe(72);
    expect(fixture.context.drawImage).toHaveBeenCalledWith(fixture.image, 0, 0, 128, 72);
    expectReleased(fixture, "gif");
  });

  it("仅 alpha > 8 算可见，小素材不放大采样分辨率", async () => {
    const fixture = mediaFixture({ width: 64, height: 32, frames: [[
      { left: 0, top: 0, width: 64, height: 32, alpha: 8 },
      { left: 16, top: 8, width: 32, height: 16, alpha: 9 },
    ]] });
    const pending = measurePetScale(asset());
    fixture.image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(360);
    await expect(pending).resolves.toBe(170);
    expect(fixture.canvas.width).toBe(64);
    expect(fixture.canvas.height).toBe(32);
    expectReleased(fixture, "gif");
  });

  it.each(["空透明", "重复的零星噪点"])("%s 返回 null，不能只凭包围盒过度放大", async (kind) => {
    const noise = Array.from({ length: 8 }, (_, i) => ({
      left: i * 18, top: i % 2 === 0 ? 0 : 127, width: 1, height: 1,
    }));
    const fixture = mediaFixture({ frames: [kind === "空透明" ? [] : noise] });
    const pending = measurePetScale(asset());
    fixture.image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(360);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "gif");
  });

  it("有限时长 WebM 在不同时间 seek 三帧，使用默认入口且不依赖角色或动作名", async () => {
    const fixture = mediaFixture({ duration: 6, frames: [[],
      [{ left: 16, top: 48, width: 40, height: 32 }],
      [{ left: 56, top: 40, width: 40, height: 48 }],
    ] });
    const pending = measurePetScale({ ...asset("任意目录/自定.WEBM?rev=2"), name: "已改名" });
    expect(petUrl).toHaveBeenCalledWith("pet-1", "任意目录/自定.WEBM?rev=2");
    expect(fixture.video.crossOrigin).toBe("anonymous");
    expect(fixture.video.muted).toBe(true);
    expect(fixture.video.defaultMuted).toBe(true);
    expect(fixture.video.playsInline).toBe(true);
    expect(fixture.video.hidden).toBe(true);
    expect(fixture.video.isConnected).toBe(false);
    fixture.video.dispatchEvent(new Event("loadeddata"));
    expect(fixture.video.currentTime).toBe(2);
    fixture.video.dispatchEvent(new Event("seeked"));
    expect(fixture.video.currentTime).toBe(4);
    fixture.video.dispatchEvent(new Event("seeked"));
    await expect(pending).resolves.toBe(140);
    expect(fixture.play).not.toHaveBeenCalled();
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(3);
    expectReleased(fixture, "webm");
  });

  it.each([Infinity, NaN, 0, -1])("WebM 时长为 %s 时静音短暂播放，有界取三帧", async (duration) => {
    const fixture = mediaFixture({ duration });
    fixture.play.mockImplementation(async () => { expect(fixture.video.muted).toBe(true); });
    const pending = measurePetScale(asset("默认.webm"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(360);
    await expect(pending).resolves.toBe(170);
    expect(fixture.play).toHaveBeenCalledTimes(1);
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(3);
    expectReleased(fixture, "webm");
  });

  it.each(["gif", "webm"] as const)("%s 加载失败回退 null，移除监听并释放 src", async (kind) => {
    const fixture = mediaFixture();
    const pending = measurePetScale(asset(`默认.${kind}`));
    const element = kind === "gif" ? fixture.image : fixture.video;
    element.dispatchEvent(new Event("error"));
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, kind);
    element.dispatchEvent(new Event(kind === "gif" ? "load" : "loadeddata"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.context.getImageData).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["gif", "webm"] as const)("%s 没有加载事件时 2500ms 内回退并清理", async (kind) => {
    const fixture = mediaFixture();
    const pending = measurePetScale(asset(`默认.${kind}`));
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, kind);
  });

  it("加载耗时计入总超时，取了一帧后不能延长任务或返回不完整测量", async () => {
    const fixture = mediaFixture();
    const pending = measurePetScale(asset());
    await vi.advanceTimersByTimeAsync(2450);
    fixture.image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "gif");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(1);
  });

  it("WebM seek 卡住时有总超时，并撤销 seeked 监听", async () => {
    const fixture = mediaFixture();
    const pending = measurePetScale(asset("默认.webm"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "webm");
    fixture.video.dispatchEvent(new Event("seeked"));
    expect(fixture.context.getImageData).toHaveBeenCalledTimes(1);
  });

  it.each(["reject", "throw"])("静音播放 %s 时回退 null 并释放视频", async (mode) => {
    const fixture = mediaFixture({ duration: Infinity });
    if (mode === "reject") fixture.play.mockRejectedValue(new Error("Autoplay denied"));
    else fixture.play.mockImplementation(() => { throw new Error("Playback failed"); });
    const pending = measurePetScale(asset("默认.webm"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    await expect(pending).resolves.toBeNull();
    expect(fixture.context.getImageData).not.toHaveBeenCalled();
    expectReleased(fixture, "webm");
  });

  it("play 永不完成时按总超时释放，晚到的成功不会恢复采样", async () => {
    const fixture = mediaFixture({ duration: Infinity });
    let resume: () => void = () => {};
    fixture.play.mockReturnValue(new Promise<void>((resolve) => { resume = resolve; }));
    const pending = measurePetScale(asset("默认.webm"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "webm");
    resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.context.getImageData).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["gif", "context"], ["gif", "draw"], ["gif", "read"], ["gif", "pixels"], ["gif", "dimensions"],
    ["webm", "context"], ["webm", "draw"], ["webm", "read"], ["webm", "pixels"], ["webm", "dimensions"],
  ] as const)("%s 的 Canvas/媒体 %s 失败不会抛异常或遗留定时器", async (kind, failure) => {
    const fixture = mediaFixture({ width: failure === "dimensions" ? 0 : 128 });
    if (failure === "context") fixture.getContext.mockReturnValueOnce(null);
    if (failure === "draw") fixture.context.drawImage.mockImplementation(() => { throw new Error("Decode failed"); });
    if (failure === "read") fixture.context.getImageData.mockImplementation(() => { throw new Error("SecurityError"); });
    if (failure === "pixels") fixture.context.getImageData.mockReturnValue(alphaFrame(0, 0, []));
    const pending = measurePetScale(asset(`默认.${kind}`));
    const element = kind === "gif" ? fixture.image : fixture.video;
    expect(() => element.dispatchEvent(new Event(kind === "gif" ? "load" : "loadeddata"))).not.toThrow();
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, kind);
  });

  it("中途读取 Canvas 失败时丢弃已采样结果", async () => {
    const fixture = mediaFixture();
    fixture.context.getImageData.mockImplementationOnce(() => alphaFrame(128, 128, [half]))
      .mockImplementation(() => { throw new Error("SecurityError"); });
    const pending = measurePetScale(asset());
    fixture.image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(180);
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "gif");
  });

  it("seek 抛异常时返回 null，即使 pause 失败也继续清 src 和 load", async () => {
    const fixture = mediaFixture();
    Object.defineProperty(fixture.video, "currentTime", { set: () => { throw new Error("Cannot seek"); } });
    fixture.pause.mockImplementation(() => { throw new Error("Cannot pause"); });
    const pending = measurePetScale(asset("默认.webm"));
    fixture.video.dispatchEvent(new Event("loadeddata"));
    await expect(pending).resolves.toBeNull();
    expectReleased(fixture, "webm");
  });

  it("URL 初始化异常也解析为 null 并清理总超时", async () => {
    vi.mocked(petUrl).mockImplementationOnce(() => { throw new Error("Missing media backend"); });
    await expect(measurePetScale(asset())).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("媒体元素创建失败也解析为 null 并清理总超时", async () => {
    vi.spyOn(document, "createElement").mockImplementation(() => { throw new Error("DOM unavailable"); });
    await expect(measurePetScale(asset())).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
