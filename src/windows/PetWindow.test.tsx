import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import type { PetAsset, PetLayout, Settings } from "../types";
import { petPlacement } from "../lib/petFrame";
import { petWindowSize } from "../lib/petSize";
import { setupTauriMock } from "../test/tauri";

const grok: PetAsset = {
  id: "pet-grok",
  name: "grok_pixel",
  path: "",
  entry: "gifs/grok_idle.gif",
  animations: [
    "gifs/grok_idle.gif",
    "gifs/grok_jump.gif",
    "gifs/grok_walk_left.gif",
    "gifs/grok_walk_right.gif",
    "gifs/grok_wave.gif",
  ],
};

function settingsWith(asset: PetAsset) {
  return {
    baseUrl: "",
    model: "",
    hasApiKey: false,
    templates: [{ id: "builtin-default", name: "默认", content: "x", builtin: true }],
    activeTemplateId: "builtin-default",
    selectedAppearanceId: asset.id,
    petAssets: [asset],
    petScale: 100,
    shortcuts: [],
    clipboardAutoClear: "60s",
    snapshotFormat: "png",
    saveDir: "",
    recordingDir: "",
    shutterSound: "crisp",
    customSoundPath: null,
    flashOnCapture: true,
    hideAfterCopy: false,
    autoSaveLocal: true,
    launchOnBoot: false,
    includeCursor: false,
    recordSystemAudio: false,
    recordMicrophone: false,
    afterCapture: "clipboard",
  } as Settings;
}

async function renderPet(asset: PetAsset = grok) {
  vi.useFakeTimers();
  const calls: string[] = [];
  setupTauriMock(
    (command) => {
      calls.push(command);
      if (command === "load_settings") return settingsWith(asset);
      if (command === "get_previous_app") return { id: null, pid: null, name: "", title: "" };
      return undefined;
    },
    { currentWindow: "pet", shouldMockEvents: true },
  );
  // petSync 在模块加载时判断是不是 Tauri 环境，要在装好 mock 之后再加载
  vi.resetModules();
  const { PetWindow, CLICK_DELAY_MS } = await import("./PetWindow");
  const view = render(<PetWindow />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { ...view, calls, delay: CLICK_DELAY_MS };
}

/** 桌宠上看得见的那张图：文件名（解码后）和是否镜像 */
function shown(container: HTMLElement) {
  const visible = [...container.querySelectorAll<HTMLImageElement>(".pet-orb img")].filter((img) => !img.hidden);
  expect(visible).toHaveLength(1);
  const [img] = visible;
  return { file: decodeURIComponent(img.src).split("/").pop(), flipped: img.classList.contains("pet-flip"), img };
}

/** 系统拖着窗口走：依次移到这些物理坐标 */
async function moveTo(...points: Array<[number, number]>) {
  for (const [x, y] of points) {
    await act(async () => {
      await emit("tauri://move", { x, y });
    });
  }
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function click(container: HTMLElement) {
  fireEvent.pointerDown(container.querySelector(".pet-window")!, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(window);
}

describe("桌宠：点击切换，平时停在待机", () => {
  it("不会自己换动作", async () => {
    const { container } = await renderPet();
    await elapse(8000);
    expect(shown(container).file).toBe("grok_idle.gif");
    await elapse(8000);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("点一下换到下一个非走路动作，3 秒后回到待机，再点换到再下一个", async () => {
    const { container, calls, delay } = await renderPet();
    expect(shown(container).file).toBe("grok_idle.gif");

    await act(async () => click(container));
    expect(shown(container).file).toBe("grok_idle.gif");
    await elapse(delay);
    expect(shown(container).file).toBe("grok_jump.gif");
    expect(calls).not.toContain("show_launchpad");
    await elapse(2999);
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(1);
    expect(shown(container).file).toBe("grok_idle.gif");

    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_wave.gif");
    await elapse(3000);
    expect(shown(container).file).toBe("grok_idle.gif");

    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_jump.gif");
  });

  it("3 秒内再点一下会换到下一个，并重新计算回待机的时间", async () => {
    const { container, delay } = await renderPet();
    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(2000);
    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_wave.gif");
    await elapse(2000);
    expect(shown(container).file).toBe("grok_wave.gif");
    await elapse(1000);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("双击打开启动台，动作留在待机，下一次单击仍从下一个动作开始", async () => {
    const { container, calls, delay } = await renderPet();
    await act(async () => click(container));
    await elapse(120);
    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_idle.gif");
    expect(calls).toContain("show_launchpad");

    calls.length = 0;
    await act(async () => click(container));
    await elapse(delay);
    expect(calls).not.toContain("show_launchpad");
    expect(shown(container).file).toBe("grok_jump.gif");
  });

  it("除了待机没有别的可切换动作时，点击仍停在待机", async () => {
    const { container, delay } = await renderPet({
      ...grok,
      animations: ["gifs/grok_idle.gif", "gifs/grok_walk_left.gif", "gifs/grok_walk_right.gif"],
    });
    await act(async () => click(container));
    await elapse(delay + 3000);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("plays a mapped event briefly, then returns to the current action", async () => {
    const asset = { ...grok, eventActions: { "capture.success": "gifs/grok_jump.gif" } } satisfies PetAsset;
    const { container } = await renderPet(asset);

    await act(async () => {
      await emit("pet-event", "capture.success");
    });
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(2600);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("does not put event-only animations into the click cycle", async () => {
    const asset = { ...grok, eventActions: { "capture.success": "gifs/grok_jump.gif" } } satisfies PetAsset;
    const { container, delay } = await renderPet(asset);

    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_wave.gif");
  });

  it("keeps manual-pause and recording states above one-shot event animations", async () => {
    const asset = {
      ...grok,
      eventActions: { "capture.success": "gifs/grok_wave.gif" },
      stateActions: { "shortcuts-paused": "gifs/grok_jump.gif", recording: "gifs/grok_wave.gif" },
    } satisfies PetAsset;
    const { container } = await renderPet(asset);

    await act(async () => {
      await emit("settings-changed", { ...settingsWith(asset), shortcutsPaused: true });
      await emit("pet-event", "capture.success");
    });
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(2600);
    expect(shown(container).file).toBe("grok_jump.gif");

    await act(async () => {
      await emit("recording-changed", { active: true, target: "Test", startedAt: 1 });
      await emit("settings-changed", { ...settingsWith(asset), shortcutsPaused: false });
    });
    expect(shown(container).file).toBe("grok_wave.gif");
    await act(async () => {
      await emit("recording-changed", { active: false, target: null, startedAt: null });
    });
    expect(shown(container).file).toBe("grok_idle.gif");
  });
});

describe("桌宠：拖动时走路", () => {
  it("往右拖显示向右走，往左拖显示向左走，停 0.25 秒回到原来的动作", async () => {
    const { container } = await renderPet();
    await moveTo([100, 100], [106, 101], [112, 100]);
    expect(shown(container)).toMatchObject({ file: "grok_walk_right.gif", flipped: false });

    await moveTo([104, 100], [96, 101]);
    expect(shown(container)).toMatchObject({ file: "grok_walk_left.gif", flipped: false });

    await elapse(200);
    expect(shown(container).file).toBe("grok_walk_left.gif");
    await elapse(100);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("一直在拖就一直走，不会中途变回去", async () => {
    const { container } = await renderPet();
    await moveTo([0, 0]);
    for (let x = 5; x <= 50; x += 5) {
      await elapse(200);
      await moveTo([x, 0]);
    }
    expect(shown(container).file).toBe("grok_walk_right.gif");
  });

  it("走路图一开始就藏在同一格里，拖起来直接换上，不重新加载", async () => {
    const { container } = await renderPet();
    const images = [...container.querySelectorAll<HTMLImageElement>(".pet-orb img")];
    const walkRight = images.find((img) => decodeURIComponent(img.src).endsWith("grok_walk_right.gif"));
    expect(walkRight?.hidden).toBe(true);
    expect(decodeURIComponent(walkRight!.src)).toContain("pet-walk/");

    await moveTo([0, 0], [8, 0]);
    expect(shown(container).img).toBe(walkRight);
    expect(container.querySelectorAll(".pet-orb img")).toHaveLength(images.length);
  });

  it("上下拖不算走路", async () => {
    const { container } = await renderPet();
    await moveTo([0, 0], [1, 12], [2, 30]);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("只有向右走的图时，往左拖把它镜像过来", async () => {
    const { container } = await renderPet({
      ...grok,
      animations: ["gifs/grok_idle.gif", "gifs/grok_walk_right.gif"],
    });
    await moveTo([50, 0], [40, 0]);
    expect(shown(container)).toMatchObject({ file: "grok_walk_right.gif", flipped: true });
  });

  it("包里没有走路动作时拖动照常显示原来的动作", async () => {
    const { container } = await renderPet({
      ...grok,
      animations: ["gifs/grok_idle.gif", "gifs/grok_wave.gif"],
    });
    await moveTo([0, 0], [20, 0]);
    expect(shown(container).file).toBe("grok_idle.gif");
  });
});

describe("桌宠：超出基准画布时把窗口撑大", () => {
  it("平时仍是方窗，扣篮时窗口变大且脚留在原地，结束后缩回去", async () => {
    const shortEdge = 340;
    const side = petWindowSize(shortEdge, 100);
    const idle = { entry: "gifs/idle.gif", width: 100, height: 100, anchorX: 50, anchorY: 90 };
    const dunk = { entry: "gifs/dunk.gif", width: 200, height: 180, anchorX: 60, anchorY: 170 };
    const layout: PetLayout = { baseWidth: 100, baseHeight: 100, anchorX: 50, anchorY: 90, frames: [idle, dunk] };
    const resting = petPlacement(side, layout, idle)!;
    const grown = petPlacement(side, layout, dunk)!;
    const origin = { x: 400, y: 300 };
    let position = { ...origin };
    const sizes: Array<{ width: number; height: number }> = [];
    const shifts: Array<{ x: number; y: number }> = [];

    Object.defineProperty(window.screen, "availWidth", { configurable: true, value: shortEdge });
    Object.defineProperty(window.screen, "availHeight", { configurable: true, value: 800 });

    vi.useFakeTimers();
    setupTauriMock(
      (command, payload) => {
        const args = (payload ?? {}) as {
          value?: { size?: { width: number; height: number }; position?: { x: number; y: number } };
          x?: number;
          y?: number;
        };
        if (command === "load_settings") {
          return settingsWith({
            id: "pet-hoop",
            name: "hoop",
            path: "",
            entry: idle.entry,
            animations: [idle.entry, dunk.entry],
            layout,
          });
        }
        if (command === "get_previous_app") return { id: null, pid: null, name: "", title: "" };
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_position") return position;
        if (command === "plugin:window|current_monitor") return null;
        if (command === "plugin:window|set_size" && args.value?.size) {
          sizes.push({ width: args.value.size.width, height: args.value.size.height });
        }
        if (command === "plugin:window|set_position" && args.value?.position) {
          position = { x: args.value.position.x, y: args.value.position.y };
        }
        if (command === "set_pet_frame_shift" && args.x != null && args.y != null) {
          shifts.push({ x: args.x, y: args.y });
        }
        return undefined;
      },
      { currentWindow: "pet", shouldMockEvents: true },
    );
    vi.resetModules();
    const { PetWindow, CLICK_DELAY_MS } = await import("./PetWindow");
    const { container } = render(<PetWindow />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const visible = () => [...container.querySelectorAll<HTMLImageElement>("img.pet-framed")].filter((img) => !img.hidden);
    const idleImage = visible()[0];
    expect(decodeURIComponent(idleImage.src)).toContain("idle.gif");
    expect(idleImage.style.left).toBe(`${resting.imageX}px`);
    expect(idleImage.style.top).toBe(`${resting.imageY}px`);
    expect(idleImage.style.width).toBe(`${resting.imageWidth}px`);
    expect(sizes.at(-1)).toEqual({ width: side, height: side });
    expect(shifts).toEqual([]);
    expect(container.querySelector(".pet-orb")).toBeNull();

    await act(async () => click(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLICK_DELAY_MS);
    });

    const dunkImage = visible()[0];
    expect(decodeURIComponent(dunkImage.src)).toContain("dunk.gif");
    expect(grown.width).toBeGreaterThan(side);
    expect(grown.shiftY).toBeLessThan(0);
    expect(dunkImage.style.left).toBe(`${grown.imageX - grown.shiftX}px`);
    expect(dunkImage.style.top).toBe(`${grown.imageY - grown.shiftY}px`);
    expect(dunkImage.style.width).toBe(`${grown.imageWidth}px`);
    expect(dunkImage.style.height).toBe(`${grown.imageHeight}px`);
    expect(sizes.at(-1)).toEqual({ width: grown.width, height: grown.height });
    expect(position).toEqual({ x: origin.x + grown.shiftX, y: origin.y + grown.shiftY });
    expect(shifts.at(-1)).toEqual({ x: grown.shiftX, y: grown.shiftY });
    const feetY = grown.imageY + dunk.anchorY * (grown.imageHeight / dunk.height);
    expect(position.y + (feetY - grown.shiftY)).toBeCloseTo(origin.y + resting.imageY + idle.anchorY * (resting.imageHeight / idle.height));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(decodeURIComponent(visible()[0].src)).toContain("idle.gif");
    expect(sizes.at(-1)).toEqual({ width: side, height: side });
    expect(position).toEqual(origin);
    expect(shifts.at(-1)).toEqual({ x: 0, y: 0 });
  });
});
