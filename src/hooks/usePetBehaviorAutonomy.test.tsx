import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PetBehavior } from "../lib/petBehavior";
import type { PetWorkArea } from "../lib/petBounds";
import { setupTauriMock } from "../test/tauri";
import { usePetBehaviorAutonomy, type PetBehaviorAutonomyOptions } from "./usePetBehaviorAutonomy";

type Result = "ended" | "cancelled" | "failed";
type Clip = {
  entry: string;
  facing: "left" | "right";
  ready?: (media: HTMLVideoElement) => void;
  finish: (result: Result) => void;
};

function profile(overrides: Partial<PetBehavior> = {}): PetBehavior {
  return {
    id: "profile", idle: ["idle.webm"], clicks: ["click.webm"], drag: ["drag.webm"], turn: ["turn.webm"],
    moves: [{ entry: "move.webm", minDistance: 200, maxDistance: 200, leadMs: 1000, tailMs: 1000 }],
    categories: [{ id: "play", weight: 1, entries: ["action.webm"] }],
    referenceWidth: 200, weights: { idle: 10, turn: 5, move: 5, action: 80 },
    eventActions: { "capture.success": "event.webm" }, stateActions: { recording: "state.webm" },
    ...overrides,
  };
}

const area: PetWorkArea = { position: { x: 0, y: 0 }, size: { width: 1000, height: 740 } };
const moveOnly = () => profile({ weights: { idle: 0, turn: 0, move: 1, action: 0 } });

function video(duration = 6, currentTime = 0) {
  const media = document.createElement("video");
  Object.defineProperty(media, "duration", { configurable: true, value: duration });
  media.currentTime = currentTime;
  return media;
}

async function flush(callback: () => void = () => {}) {
  await act(async () => {
    callback();
    for (let index = 0; index < 12; index++) await Promise.resolve();
  });
}

async function setup(
  options: Partial<PetBehaviorAutonomyOptions> = {},
  environment: {
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    scale?: number;
    areas?: PetWorkArea[] | Error;
    currentArea?: PetWorkArea | null;
    readPosition?: () => unknown;
  } = {},
) {
  vi.useFakeTimers();
  const position = { ...(environment.position ?? { x: 400, y: 200 }) };
  const size = environment.size ?? { width: 200, height: 200 };
  const placements: Array<{ x: number; y: number }> = [];
  const monitor = (workArea: PetWorkArea) => ({
    name: "test", position: workArea.position, size: workArea.size, scaleFactor: environment.scale ?? 1, workArea,
  });
  setupTauriMock((command, payload) => {
    if (command === "plugin:window|current_monitor") {
      if (environment.currentArea === null) return null;
      return monitor(environment.currentArea ?? area);
    }
    if (command === "plugin:window|available_monitors") {
      if (environment.areas instanceof Error) return Promise.reject(environment.areas);
      return environment.areas?.map(monitor);
    }
    if (command === "plugin:window|outer_position") return environment.readPosition?.() ?? { ...position };
    if (command === "plugin:window|outer_size") return { ...size };
    if (command === "plugin:window|scale_factor") return environment.scale ?? 1;
    if (command === "plugin:window|set_position") {
      const args = payload as { value: { position: { x: number; y: number } } };
      position.x = args.value.position.x;
      position.y = args.value.position.y;
      placements.push({ ...position });
    }
    return undefined;
  }, { currentWindow: "pet" });

  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const clips: Clip[] = [];
  const play = vi.fn<PetBehaviorAutonomyOptions["play"]>(options.play ?? ((entry, facing, ready) =>
    new Promise<Result>((finish) => { clips.push({ entry, facing, ready, finish }); })));
  const cancelPlayback = vi.fn(options.cancelPlayback ?? (() => {}));
  let props: PetBehaviorAutonomyOptions = {
    behavior: profile(), enabled: true, paused: false, wander: true, randomActions: true,
    current: () => clips.at(-1)?.entry ?? null,
    ...options, play, cancelPlayback,
  };
  const hook = renderHook((value: PetBehaviorAutonomyOptions) => usePetBehaviorAutonomy(value), { initialProps: props });
  await flush();
  const update = async (patch: Partial<PetBehaviorAutonomyOptions>) => {
    props = { ...props, ...patch };
    await flush(() => hook.rerender(props));
  };
  const frame = async () => {
    await flush(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(performance.now());
    });
  };
  const advance = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };
  return { ...hook, clips, play, cancelPlayback, position, size, placements, frames, update, frame, advance };
}

describe("profile 自主行为选择", () => {
  it.each([
    [0, "idle.webm"], [0.0999, "idle.webm"],
    [0.10, "turn.webm"], [0.1499, "turn.webm"],
    [0.15, "move.webm"], [0.1999, "move.webm"],
    [0.20, "action.webm"], [0.9999, "action.webm"],
  ] as const)("随机数 %s 遵守 idle10/turn5/move5/action80", async (random, entry) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const { clips } = await setup();
    expect(clips.map((clip) => clip.entry)).toEqual([entry]);
  });

  it("真实 ended 后立即接下一段，不等待固定空闲间隔", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    const rig = await setup();
    await rig.advance(6000);
    expect(rig.play).toHaveBeenCalledTimes(1);
    await flush(() => rig.clips[0].finish("ended"));
    expect(rig.play).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turn 播放时仍使用原朝向，ended 后的下一段才换向", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.12);
    const rig = await setup();
    expect(rig.clips[0]).toMatchObject({ entry: "turn.webm", facing: "left" });
    await rig.advance(1000);
    random.mockReturnValue(0.8);
    await flush(() => rig.clips[0].finish("ended"));
    expect(rig.clips[1]).toMatchObject({ entry: "action.webm", facing: "right" });
  });

  it("turn 失败不会改变朝向，动作分类按当前朝向排除 noMirror", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.12);
    const rig = await setup({ behavior: profile({ categories: [{ id: "text", weight: 1, entries: ["text.webm"], noMirror: true }] }) });
    await flush(() => rig.clips[0].finish("failed"));
    random.mockReturnValue(0.8);
    await rig.advance(250);
    expect(rig.clips[1]).toMatchObject({ entry: "text.webm", facing: "left" });
    random.mockReturnValue(0.12);
    await rig.advance(1000);
    await flush(() => rig.clips[1].finish("ended"));
    await rig.advance(1000);
    random.mockReturnValue(0.8);
    await flush(() => rig.clips[2].finish("ended"));
    expect(rig.clips[3]).toMatchObject({ entry: "idle.webm", facing: "right" });
  });

  it.each([
    { enabled: false }, { paused: true }, { wander: false, randomActions: false }, { behavior: null },
  ])("未启用条件 %j 不启动播放或帧循环", async (options) => {
    const rig = await setup(options);
    await rig.advance(10000);
    expect(rig.play).not.toHaveBeenCalled();
    expect(rig.frames.size).toBe(0);
    expect(rig.cancelPlayback).not.toHaveBeenCalled();
  });

  it("wander 关闭时不抽移动，randomActions 关闭时不抽 turn/action", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    const rig = await setup({ wander: false });
    expect(rig.clips[0].entry).toBe("action.webm");
    await rig.update({ wander: true, randomActions: false });
    expect(rig.clips[1].entry).toBe("move.webm");
    await rig.update({ wander: false });
    const count = rig.play.mock.calls.length;
    await rig.advance(1000);
    expect(rig.play).toHaveBeenCalledTimes(count);
    expect(rig.frames.size).toBe(0);
  });
});

describe("profile 视频同步移动", () => {
  it("等待 onReady，按 currentTime 走完整个 lead/移动/tail；卡帧不随墙钟前进", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const media = video();
    await rig.advance(5000);
    await rig.frame();
    expect(rig.placements).toEqual([]);

    await flush(() => rig.clips[0].ready?.(media));
    media.currentTime = 0.9;
    await rig.frame();
    media.currentTime = 1;
    await rig.frame();
    expect(rig.placements).toEqual([]);
    media.currentTime = 2;
    await rig.frame();
    expect(rig.position).toEqual({ x: 350, y: 200 });
    await rig.advance(5000);
    await rig.frame();
    expect(rig.position.x).toBe(350);
    media.currentTime = 3;
    await rig.frame();
    expect(rig.position.x).toBe(300);
    media.currentTime = 5;
    await rig.frame();
    expect(rig.position.x).toBe(200);
    const count = rig.placements.length;
    media.currentTime = 5.9;
    await rig.frame();
    expect(rig.placements).toHaveLength(count);
    expect(rig.play).toHaveBeenCalledTimes(1);
    await flush(() => rig.clips[0].finish("ended"));
    expect(rig.play).toHaveBeenCalledTimes(2);
  });

  it("用 onReady 后的 native width / scale / referenceWidth 缩放距离，再换物理像素", async () => {
    const rig = await setup({ behavior: moveOnly() }, { scale: 1.5 });
    // 播放器切到前台时原生窗口已经完成改尺寸；不使用早先规划时的宽度。
    rig.size.width = 300;
    const media = video(6, 5);
    await flush(() => rig.clips[0].ready?.(media));
    await rig.frame();
    expect(rig.position).toEqual({ x: 100, y: 200 });
  });

  it("结束回执采样末帧，但不会伪造未播放的视频进度", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const media = video(6, 2);
    await flush(() => rig.clips[0].ready?.(media));
    await rig.frame();
    media.currentTime = 3;
    await rig.advance(1000);
    await flush(() => rig.clips[0].finish("ended"));
    expect(rig.position.x).toBe(300);
  });

  it.each([NaN, Infinity, 0, 1.5])("时长 %s 不足以扣除 lead/tail 时保持原地", async (duration) => {
    const rig = await setup({ behavior: moveOnly() });
    await flush(() => rig.clips[0].ready?.(video(duration, 100)));
    await rig.frame();
    expect(rig.placements).toEqual([]);
  });
});

describe("profile 边界和工作区", () => {
  it("沿负坐标显示器移动，可见内容边界允许透明外圈越界", async () => {
    const negativeArea = { position: { x: -1000, y: -800 }, size: { width: 1000, height: 740 } };
    const rig = await setup({ behavior: moveOnly(), contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }) }, {
      position: { x: -800, y: -500 }, currentArea: negativeArea, areas: [negativeArea],
    });
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.position).toEqual({ x: -1000, y: -500 });
    expect(rig.position.x + 40).toBeGreaterThanOrEqual(-1000);
  });

  it("相邻屏幕接缝继续走，保持方向和原纵向位置", async () => {
    const rig = await setup({ behavior: moveOnly() }, {
      position: { x: 1050, y: 200 },
      areas: [area, { position: { x: 1000, y: 0 }, size: { width: 1000, height: 740 } }],
    });
    const media = video(6, 2);
    await flush(() => rig.clips[0].ready?.(media));
    await rig.frame();
    expect(rig.position.x).toBe(1000);
    media.currentTime = 3;
    await rig.frame();
    expect(rig.position).toEqual({ x: 950, y: 200 });
    expect(rig.clips[0].facing).toBe("left");
  });

  it.each([undefined, [], new Error("monitors unavailable")])("availableMonitors %s 回退 currentMonitor", async (areas) => {
    const rig = await setup({ behavior: moveOnly() }, { areas });
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.position).toEqual({ x: 200, y: 200 });
  });

  it("2x DPI 使用物理工作区底线，保留可见范围允许的负窗口坐标", async () => {
    const behavior = moveOnly();
    behavior.moves[0] = { ...behavior.moves[0], minDistance: 40, maxDistance: 40 };
    const rig = await setup({ behavior, contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }) }, {
      scale: 2, position: { x: -40, y: 700 },
    });
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.position).toEqual({ x: -80, y: 540 });
  });

  it("小数 DPI 的像素取整不会把可见内容推过边界", async () => {
    const behavior = moveOnly();
    behavior.moves[0] = { ...behavior.moves[0], minDistance: 72.6, maxDistance: 72.6 };
    const rig = await setup({ behavior, contentBounds: () => ({ left: 50.2, top: 10, width: 80, height: 100 }) }, {
      scale: 1.25, position: { x: 10, y: 200 },
    });
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.position.x).toBe(-62);
    expect(rig.position.x + 50.2 * 1.25).toBeGreaterThanOrEqual(0);
  });

  it("朝外且规划越界时先播 turn，完成后再向内移动，边缘不即时反弹", async () => {
    const rig = await setup({ behavior: moveOnly() }, { position: { x: 10, y: 200 } });
    expect(rig.clips[0]).toMatchObject({ entry: "turn.webm", facing: "left" });
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.placements).toEqual([]);
    await rig.advance(1000);
    await flush(() => rig.clips[0].finish("ended"));
    expect(rig.clips[1]).toMatchObject({ entry: "move.webm", facing: "right" });
    await flush(() => rig.clips[1].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.position).toEqual({ x: 210, y: 200 });
  });

  it("只开自由走动也能从边缘向内走，起步前不位移且不抽随机 turn/action", async () => {
    const rig = await setup({ behavior: moveOnly(), randomActions: false }, { position: { x: 10, y: 200 } });
    expect(rig.clips[0]).toMatchObject({ entry: "move.webm", facing: "right" });
    const media = video(6, 0);
    await flush(() => rig.clips[0].ready?.(media));
    await rig.frame();
    expect(rig.placements).toEqual([]);
    media.currentTime = 3;
    await rig.frame();
    expect(rig.position).toEqual({ x: 110, y: 200 });
  });

  it.each([0, 100, NaN])("工作区宽度 %s 无可行路径时不反复校准位置", async (width) => {
    const rig = await setup({ behavior: moveOnly() }, { areas: [{ ...area, size: { width, height: 740 } }] });
    expect(rig.clips[0].entry).toBe("action.webm");
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.placements).toEqual([]);
  });
});

describe("profile 取消和异常时序", () => {
  it("仅回调身份改变不重启 effect，下一段和后续取消读取最新回调", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rig = await setup();
    const nextCurrent = vi.fn(() => "manual.webm");
    const nextPlay = vi.fn<PetBehaviorAutonomyOptions["play"]>(() => new Promise(() => {}));
    const nextCancel = vi.fn();
    await rig.update({
      current: nextCurrent, play: nextPlay, contentBounds: () => null, cancelPlayback: nextCancel,
    });
    expect(rig.cancelPlayback).not.toHaveBeenCalled();
    expect(nextPlay).not.toHaveBeenCalled();
    await rig.advance(1000);
    await flush(() => rig.clips[0].finish("ended"));
    expect(nextCurrent).toHaveBeenCalled();
    expect(nextPlay).toHaveBeenCalledTimes(1);
    await flush(() => rig.result.current.cancel());
    expect(nextCancel).toHaveBeenCalledTimes(1);
  });

  it("两个开关都关后取消已就绪的移动，旧帧和回执绝不写位置或启动新播放", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const media = video(6, 2);
    await flush(() => rig.clips[0].ready?.(media));
    const staleFrame = [...rig.frames.values()][0];
    await rig.update({ wander: false, randomActions: false });
    await flush(() => {
      media.currentTime = 5;
      staleFrame(performance.now());
      rig.clips[0].finish("ended");
    });
    await rig.advance(10000);
    expect(rig.placements).toEqual([]);
    expect(rig.play).toHaveBeenCalledTimes(1);
    expect(rig.frames.size).toBe(0);
  });

  it("暂停立即取消 rAF；迟到 onReady/ended 不影响恢复后的新片段", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const old = rig.clips[0];
    await flush(() => old.ready?.(video(6, 2)));
    const staleFrame = [...rig.frames.values()][0];
    await rig.update({ paused: true });
    expect(rig.cancelPlayback).toHaveBeenCalledTimes(1);
    expect(rig.frames.size).toBe(0);
    await rig.update({ paused: false });
    const current = rig.clips[1];
    await flush(() => {
      old.ready?.(video(6, 5));
      old.finish("ended");
      staleFrame(performance.now());
    });
    expect(rig.placements).toEqual([]);
    expect(rig.clips).toHaveLength(2);
    await flush(() => current.ready?.(video(6, 3)));
    await rig.frame();
    expect(rig.position.x).toBe(300);
  });

  it("手动 cancel 连续调用幂等，停止当前链且不在下一帧夺回播放", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const old = rig.clips[0];
    await flush(() => {
      rig.result.current.cancel();
      rig.result.current.cancel();
      old.ready?.(video(6, 5));
      old.finish("ended");
    });
    await rig.advance(10000);
    await rig.frame();
    expect(rig.cancelPlayback).toHaveBeenCalledTimes(1);
    expect(rig.play).toHaveBeenCalledTimes(1);
    expect(rig.placements).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("切角色（即使 profile id 相同）使旧回调失效，卸载也释放新链", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const old = rig.clips[0];
    const nextBehavior = moveOnly();
    nextBehavior.moves[0].entry = "other-move.webm";
    await rig.update({ behavior: nextBehavior });
    expect(rig.clips[1].entry).toBe("other-move.webm");
    await flush(() => {
      old.ready?.(video(6, 5));
      old.finish("ended");
      rig.clips[1].ready?.(video(6, 2));
    });
    expect(rig.placements).toEqual([]);
    expect(rig.frames.size).toBe(1);
    rig.unmount();
    expect(rig.frames.size).toBe(0);
    await flush(() => rig.clips[1].finish("ended"));
    expect(rig.cancelPlayback).toHaveBeenCalledTimes(2);
    expect(rig.clips).toHaveLength(2);
  });

  it("原生几何查询未返回时也能取消，之后返回不会开始旧播放", async () => {
    let resolve!: (position: { x: number; y: number }) => void;
    const pending = new Promise<{ x: number; y: number }>((finish) => { resolve = finish; });
    const rig = await setup({ behavior: moveOnly() }, { readPosition: () => pending });
    expect(rig.play).not.toHaveBeenCalled();
    await flush(() => rig.result.current.cancel());
    await flush(() => resolve({ x: 400, y: 200 }));
    expect(rig.play).not.toHaveBeenCalled();
    expect(rig.frames.size).toBe(0);
  });

  it("onReady 同步调用且 Promise 立即 ended 时仍有界，不残留帧或忙循环", async () => {
    const rig = await setup({
      behavior: moveOnly(),
      play: (_entry, _facing, ready) => { ready?.(video(6, 5)); return Promise.resolve("ended"); },
    });
    expect(rig.play).toHaveBeenCalledTimes(1);
    expect(rig.frames.size).toBe(0);
    expect(rig.placements).toEqual([]);
    await rig.advance(1000);
    expect(rig.play.mock.calls.length).toBeGreaterThan(1);
    expect(rig.play.mock.calls.length).toBeLessThanOrEqual(64);
    await flush(() => rig.result.current.cancel());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("同步 onReady 内取消，未完成的几何回调不遗留 RAF", async () => {
    let cancel = () => {};
    const rig = await setup({
      enabled: false, behavior: moveOnly(),
      play: (_entry, _facing, ready) => {
        ready?.(video(6, 5));
        cancel();
        return Promise.resolve("ended");
      },
    });
    cancel = rig.result.current.cancel;
    await rig.update({ enabled: true });
    await rig.advance(1000);
    expect(rig.cancelPlayback).toHaveBeenCalledTimes(1);
    expect(rig.play).toHaveBeenCalledTimes(1);
    expect(rig.frames.size).toBe(0);
    expect(rig.placements).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("重复 onReady 不创建第二个移动循环，旧视频也不能接管位移", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const media = video(6, 2);
    await flush(() => {
      rig.clips[0].ready?.(media);
      rig.clips[0].ready?.(video(6, 5));
    });
    expect(rig.frames.size).toBe(1);
    await rig.frame();
    expect(rig.position.x).toBe(350);
  });

  it("播放回执先于 onReady 时也能接下一段，迟到 ready 不移动", async () => {
    const rig = await setup({ behavior: moveOnly() });
    const old = rig.clips[0];
    await rig.advance(1000);
    await flush(() => old.finish("ended"));
    expect(rig.clips).toHaveLength(2);
    await flush(() => old.ready?.(video(6, 5)));
    await rig.frame();
    expect(rig.placements).toEqual([]);
    expect(rig.frames.size).toBe(0);
  });

  it("原生几何查询失败也短退避，取消后不再重试", async () => {
    const readPosition = vi.fn(() => Promise.reject(new Error("window unavailable")));
    const rig = await setup({ behavior: moveOnly() }, { readPosition });
    expect(readPosition).toHaveBeenCalledTimes(1);
    await rig.advance(249);
    expect(readPosition).toHaveBeenCalledTimes(1);
    await rig.advance(1);
    expect(readPosition).toHaveBeenCalledTimes(2);
    await flush(() => rig.result.current.cancel());
    await rig.advance(10000);
    expect(readPosition).toHaveBeenCalledTimes(2);
    expect(rig.play).not.toHaveBeenCalled();
  });

  it.each(["failed", "reject", "throw"])("播放 %s 后短退避，取消时清掉退避定时器", async (failure) => {
    const rig = await setup({
      play: () => {
        if (failure === "throw") throw new Error("play failed");
        if (failure === "reject") return Promise.reject(new Error("play failed"));
        return Promise.resolve("failed");
      },
    });
    await rig.advance(249);
    expect(rig.play).toHaveBeenCalledTimes(1);
    await rig.advance(1);
    expect(rig.play).toHaveBeenCalledTimes(2);
    await rig.update({ paused: true });
    await rig.advance(10000);
    expect(rig.play).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelled 回执结束当前链，即使迟到 onReady 也不移动", async () => {
    const rig = await setup({ behavior: moveOnly() });
    await flush(() => rig.clips[0].finish("cancelled"));
    await flush(() => rig.clips[0].ready?.(video(6, 5)));
    await rig.advance(10000);
    await rig.frame();
    expect(rig.play).toHaveBeenCalledTimes(1);
    expect(rig.placements).toEqual([]);
  });
});
