import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setupTauriMock } from "../test/tauri";
import type { PetWorkArea } from "../lib/petBounds";
import { usePetAutonomy } from "./usePetAutonomy";

const monitor = {
  name: "test",
  scaleFactor: 1,
  position: { x: 0, y: 0 },
  size: { width: 1000, height: 800 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 740 } },
};

async function setup(
  options: Partial<Parameters<typeof usePetAutonomy>[0]> = {},
  environment: {
    initialPosition?: { x: number; y: number };
    areas?: PetWorkArea[] | Error;
    scale?: number;
  } = {},
) {
  vi.useFakeTimers();
  const position = { ...(environment.initialPosition ?? { x: 100, y: 100 }) };
  const placements: Array<{ x: number; y: number }> = [];
  setupTauriMock((command, payload) => {
    if (command === "plugin:window|current_monitor") return monitor;
    if (command === "plugin:window|available_monitors") {
      if (environment.areas instanceof Error) return Promise.reject(environment.areas);
      return environment.areas?.map((workArea) => ({ ...monitor, workArea }));
    }
    if (command === "plugin:window|outer_position") return position;
    if (command === "plugin:window|outer_size") return { width: 160, height: 160 };
    if (command === "plugin:window|scale_factor") return environment.scale ?? 1;
    if (command === "plugin:window|set_position") {
      const args = payload as { value: { position: { x: number; y: number } } };
      position.x = args.value.position.x;
      position.y = args.value.position.y;
      placements.push({ ...position });
    }
    return undefined;
  }, { currentWindow: "pet", shouldMockEvents: true });

  const setWalking = vi.fn();
  const onAction = vi.fn();
  const hook = renderHook(() => usePetAutonomy({
    enabled: true,
    wander: false,
    randomActions: false,
    canWalk: true,
    actions: ["jump"],
    paused: false,
    setWalking,
    onAction,
    actionDuration: async () => 3000,
    ...options,
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { ...hook, position, placements, setWalking, onAction };
}

describe("桌宠空闲行为", () => {
  it("行走时收紧窗口，只改变窗口偏移，不改变角色运动原点", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    let shift = { x: 0, y: 0 };
    const { position, placements } = await setup({ wander: true, frameShift: () => shift });
    await act(async () => { await vi.advanceTimersByTimeAsync(6632); });
    const before = { ...position };
    const count = placements.length;
    shift = { x: 30, y: 45 };
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(placements.length).toBeGreaterThan(count);
    expect(position.x - shift.x - before.x).toBeGreaterThanOrEqual(0);
    expect(position.x - shift.x - before.x).toBeLessThanOrEqual(2);
    expect(position.y - shift.y).toBe(before.y);
  });

  it("开启自由走动后会沿当前屏幕底部移动", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { position, placements, setWalking } = await setup({ wander: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(6600); });
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });

    expect(placements.length).toBeGreaterThan(0);
    expect(position.x).toBeGreaterThan(100);
    expect(position.y).toBe(100);
    expect(setWalking).toHaveBeenCalledWith("right");
  });

  it("可见内容贴左边时保留负窗口 x，不先拉回零", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { position, placements, setWalking } = await setup({
      wander: true,
      contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }),
    }, { initialPosition: { x: -40, y: 100 } });

    await act(async () => { await vi.advanceTimersByTimeAsync(6632); });

    expect(placements.length).toBeGreaterThan(0);
    expect(placements[0].x).toBeGreaterThanOrEqual(-40);
    expect(placements[0].x).toBeLessThan(-35);
    expect(position.x).toBeLessThan(0);
    expect(placements.every(({ x, y }) => x + 40 >= 0 && y === 100)).toBe(true);
    expect(setWalking).toHaveBeenCalledWith("right");
  });

  it("走到右边时按可见内容贴齐，允许窗口右侧透明留白越界", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements, setWalking } = await setup({
      wander: true,
      contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }),
    }, { initialPosition: { x: 700, y: 100 } });

    await act(async () => { await vi.advanceTimersByTimeAsync(9800); });

    expect(placements.some(({ x }) => x === 880)).toBe(true);
    expect(placements.every(({ x, y }) => x + 120 <= 1000 && y === 100)).toBe(true);
    expect(setWalking.mock.calls.filter(([direction]) => direction !== null))
      .toEqual([["right"], ["left"]]);
  });

  it("跨相邻显示器接缝继续行走，不在当前屏幕边缘折返或跳跃", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { position, placements, setWalking } = await setup({
      wander: true,
      contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }),
    }, {
      initialPosition: { x: 800, y: 100 },
      areas: [monitor.workArea, { position: { x: 1000, y: 0 }, size: { width: 1000, height: 740 } }],
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_200); });

    expect(position.x).toBeGreaterThan(1000);
    expect(placements.some(({ x }) => x < 1000)).toBe(true);
    expect(placements.every(({ x, y }, index) => {
      const previousX = index === 0 ? 800 : placements[index - 1].x;
      return x >= previousX && x - previousX <= 2 && y === 100;
    })).toBe(true);
    expect(setWalking.mock.calls).toEqual([["right"]]);
  });

  it("2x DPI 下按可见底边限位，透明下边距不再把行走中的角色抬高", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements } = await setup({
      wander: true,
      contentBounds: () => ({ left: 20, top: 10, width: 40, height: 60 }),
    }, { initialPosition: { x: -40, y: 700 }, scale: 2 });

    await act(async () => { await vi.advanceTimersByTimeAsync(6632); });

    expect(placements.length).toBeGreaterThan(0);
    expect(placements[0].x).toBeGreaterThan(-40);
    expect(placements[0].x).toBeLessThan(-35);
    // 可见底边 = (10 + 60) * 2 = 140，floor = 740 - 140。
    expect(placements.every(({ x, y }) => x + 40 >= 0 && y === 600)).toBe(true);
  });

  it("横向素材脚底贴住任务栏后，自由走动不会按透明方窗向上弹回", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements } = await setup({
      wander: true,
      contentBounds: () => ({ left: 20, top: 35, width: 120, height: 90 }),
      groundY: () => 116.5625,
    }, { initialPosition: { x: 100, y: 623 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(6632); });
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every(({ y }) => y === 623)).toBe(true);
  });

  it.each([
    { name: "空列表", areas: [] },
    { name: "未返回列表", areas: undefined },
    { name: "查询失败", areas: new Error("monitors unavailable") },
  ])("显示器$name时回退到当前显示器工作区", async ({ areas }) => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements } = await setup({ wander: true }, {
      initialPosition: { x: 840, y: 100 }, areas,
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(6632); });

    expect(placements.length).toBeGreaterThan(0);
    expect(placements[0].x).toBeLessThan(840);
    expect(placements[0].x).toBeGreaterThan(835);
    expect(placements.every(({ x, y }) => x >= 0 && x <= 840 && y === 100)).toBe(true);
  });

  it.each([
    { name: "恰好容纳可见内容", width: 80 },
    { name: "比可见内容更窄", width: 60 },
    { name: "无效工作区", width: NaN },
  ])("$name时跳过行走，不反复换向", async ({ width }) => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements, setWalking } = await setup({
      wander: true,
      contentBounds: () => ({ left: 40, top: 20, width: 80, height: 120 }),
    }, { areas: [{ position: { x: 0, y: 0 }, size: { width, height: 740 } }] });

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(placements).toEqual([]);
    expect(setWalking).not.toHaveBeenCalled();
  });

  it("开启随机动作后会播放普通动作并及时回到待机", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const actionDuration = vi.fn(async () => 1250);
    const { onAction } = await setup({ randomActions: true, actionDuration });

    await act(async () => { await vi.advanceTimersByTimeAsync(6600); });
    expect(onAction).toHaveBeenCalledWith("jump");
    expect(actionDuration).toHaveBeenCalledWith("jump");

    await act(async () => { await vi.advanceTimersByTimeAsync(1199); });
    expect(onAction).not.toHaveBeenLastCalledWith(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onAction).toHaveBeenLastCalledWith(null);
  });

  it("正在拖动、录制或暂停快捷键时不会自己动", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { placements, onAction } = await setup({ wander: true, randomActions: true, paused: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(placements).toEqual([]);
    expect(onAction).not.toHaveBeenCalled();
  });
});
