import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setupTauriMock } from "../test/tauri";
import { usePetAutonomy } from "./usePetAutonomy";

const monitor = {
  name: "test",
  scaleFactor: 1,
  position: { x: 0, y: 0 },
  size: { width: 1000, height: 800 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 740 } },
};

async function setup(options: Partial<Parameters<typeof usePetAutonomy>[0]> = {}) {
  vi.useFakeTimers();
  const position = { x: 100, y: 100 };
  const placements: Array<{ x: number; y: number }> = [];
  setupTauriMock((command, payload) => {
    if (command === "plugin:window|current_monitor") return monitor;
    if (command === "plugin:window|outer_position") return position;
    if (command === "plugin:window|outer_size") return { width: 160, height: 160 };
    if (command === "plugin:window|scale_factor") return 1;
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
