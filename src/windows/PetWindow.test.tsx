import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import type { PetAsset, PetLayout, Settings } from "../types";
import { petPlacement } from "../lib/petFrame";
import { petWindowSize } from "../lib/petSize";
import { setupTauriMock } from "../test/tauri";
import petStyles from "../styles.css?raw";

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
    petWander: false,
    petRandomActions: false,
    petGravity: false,
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

async function renderPet(
  asset: PetAsset = grok,
  overrides: Partial<Settings> = {},
  initialPosition = { x: 100, y: 100 },
  monitor: Record<string, unknown> | null = null,
  durations: Record<string, number> = {},
) {
  vi.useFakeTimers();
  const calls: string[] = [];
  const position = { ...initialPosition };
  setupTauriMock(
    (command, payload) => {
      calls.push(command);
      if (command === "load_settings") return { ...settingsWith(asset), ...overrides };
      if (command === "get_previous_app") return { id: null, pid: null, name: "", title: "" };
      if (command === "plugin:window|outer_position") return { ...position };
      if (command === "plugin:window|outer_size") return { width: 160, height: 160 };
      if (command === "plugin:window|scale_factor") return 1;
      if (command === "plugin:window|current_monitor") return monitor;
      if (command === "pet_animation_duration") {
        const args = payload as { entry: string };
        return durations[args.entry] ?? 3000;
      }
      if (command === "plugin:window|set_position") {
        const args = payload as { value: { position: { x: number; y: number } } };
        position.x = args.value.position.x;
        position.y = args.value.position.y;
      }
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
  await loadPetImages();
  return { ...view, calls, delay: CLICK_DELAY_MS, position };
}

// JSDOM 不加载图片；显式模拟 WebView 已加载的图片，慢加载用例则自行控制 load/decode。
const loadedImages = new WeakSet<HTMLImageElement>();
async function loadPetImages() {
  await act(async () => {
    for (const image of document.querySelectorAll<HTMLImageElement>(".pet-window img")) {
      if (loadedImages.has(image)) continue;
      loadedImages.add(image);
      fireEvent.load(image);
    }
  });
}

/** 桌宠上看得见的那张图：文件名（解码后）和是否镜像 */
function shown(container: HTMLElement) {
  const visible = [...container.querySelectorAll<HTMLImageElement>(".pet-orb img")].filter((img) => !img.hidden);
  const img = visible.find((item) => item.classList.contains("pet-current")) ?? visible.at(-1);
  if (!img) throw new Error("桌宠没有可见画面");
  return { file: decodeURIComponent(img.src).split("/").pop(), flipped: img.classList.contains("pet-flip"), img };
}

/** 系统拖着窗口走：依次移到这些物理坐标 */
async function moveTo(...points: Array<[number, number]>) {
  for (const [x, y] of points) {
    await act(async () => {
      await emit("tauri://move", { x, y });
    });
    await loadPetImages();
  }
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await loadPetImages();
}

function click(container: HTMLElement) {
  fireEvent.pointerDown(container.querySelector(".pet-window")!, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(window);
}

/** 按下并越过拖动阈值；之后窗口位置由 pointermove 直接驱动。 */
async function startDrag(container: HTMLElement, screenX = 100, screenY = 100) {
  const pet = container.querySelector(".pet-window")!;
  fireEvent.pointerDown(pet, { button: 0, clientX: 10, clientY: 10, screenX, screenY, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 20, clientY: 10, screenX: screenX + 8, screenY, pointerId: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}

async function dragTo(screenX: number, screenY: number, wait = 16) {
  fireEvent.pointerMove(window, { clientX: 20, clientY: 10, screenX, screenY, pointerId: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(wait); });
}

async function endDrag() {
  fireEvent.pointerUp(window, { pointerId: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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

  it("按 GIF 一轮的实际时长回到待机，并用叠化完成最后交接", async () => {
    const { container, delay } = await renderPet(
      grok,
      {},
      { x: 100, y: 100 },
      null,
      { "gifs/grok_jump.gif": 1250 },
    );
    await act(async () => click(container));
    await elapse(delay);
    const action = shown(container).img;
    expect(shown(container).file).toBe("grok_jump.gif");

    await elapse(1249);
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(1);
    expect(shown(container).file).toBe("grok_idle.gif");
    expect(container.querySelector(".pet-crossfade-out")).toBeTruthy();
    expect(action.isConnected).toBe(true);

    await elapse(180);
    expect(container.querySelector(".pet-crossfade-out")).toBeNull();
    expect(action.isConnected).toBe(false);
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
    await loadPetImages();
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(3000);
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
    await loadPetImages();
    expect(shown(container).file).toBe("grok_jump.gif");
    await elapse(3000);
    expect(shown(container).file).toBe("grok_jump.gif");

    await act(async () => {
      await emit("recording-changed", { active: true, target: "Test", startedAt: 1 });
      await emit("settings-changed", { ...settingsWith(asset), shortcutsPaused: false });
    });
    await loadPetImages();
    expect(shown(container).file).toBe("grok_wave.gif");
    await act(async () => {
      await emit("recording-changed", { active: false, target: null, startedAt: null });
    });
    await loadPetImages();
    expect(shown(container).file).toBe("grok_idle.gif");
  });
});

describe("桌宠：重力", () => {
  const monitor = {
    name: "test",
    scaleFactor: 1,
    position: { x: 0, y: 0 },
    size: { width: 1000, height: 800 },
    workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 740 } },
  };

  it("开启后会从悬空位置落回当前屏幕工作区底部", async () => {
    const { position } = await renderPet(grok, { petGravity: true }, { x: 100, y: 100 }, monitor);
    await elapse(1000);
    expect(position).toEqual({ x: 100, y: 580 });
  });

  it("拖起来松手后落回底部，而不是等窗口自己停顿", async () => {
    const { container, position } = await renderPet(grok, { petGravity: true }, { x: 100, y: 580 }, monitor);
    await startDrag(container, 100, 100);
    await dragTo(100, 40);
    expect(position.y).toBeLessThan(580);

    await endDrag();
    await elapse(1000);
    expect(position.y).toBe(580);
  });

  it("关闭后放在哪里就停在哪里", async () => {
    const { position } = await renderPet(grok, { petGravity: false }, { x: 240, y: 210 }, monitor);
    await elapse(1000);
    expect(position).toEqual({ x: 240, y: 210 });
  });

  it("向下拖过任务栏时停在任务栏上沿，不和原生边界来回抢位置", async () => {
    const { container, position } = await renderPet(
      grok,
      { petGravity: false },
      { x: 100, y: 580 },
      monitor,
    );
    await startDrag(container, 100, 100);
    await dragTo(100, 400);
    expect(position.y).toBe(580);

    await endDrag();
    expect(position.y).toBe(580);
  });
});

describe("桌宠：空闲行为", () => {
  it("开启自由走动后，桌面宠物会自己沿当前屏幕移动", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const monitor = {
      name: "test",
      scaleFactor: 1,
      position: { x: 0, y: 0 },
      size: { width: 1000, height: 800 },
      workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 740 } },
    };
    const { position } = await renderPet(
      grok,
      { petWander: true, petRandomActions: false, petGravity: false },
      { x: 100, y: 100 },
      monitor,
    );

    await elapse(7000);
    expect(position.x).toBeGreaterThan(100);
  });
});

describe("桌宠：拖动时走路", () => {
  it("往右拖显示向右走，往左拖显示向左走，松手立即回到原来的动作", async () => {
    const { container } = await renderPet();
    await startDrag(container, 100, 100);
    await dragTo(112, 100);
    expect(shown(container)).toMatchObject({ file: "grok_walk_right.gif", flipped: false });

    await dragTo(104, 100);
    await dragTo(96, 101);
    expect(shown(container)).toMatchObject({ file: "grok_walk_left.gif", flipped: false });

    await endDrag();
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("一直在拖就一直走，不会中途变回去", async () => {
    const { container } = await renderPet();
    await startDrag(container, 0, 0);
    for (let x = 10; x <= 100; x += 10) {
      await dragTo(x, 0, 200);
    }
    expect(shown(container).file).toBe("grok_walk_right.gif");
  });

  it("走路图一开始就藏在同一格里，拖起来直接换上，不重新加载", async () => {
    const { container } = await renderPet();
    const images = [...container.querySelectorAll<HTMLImageElement>(".pet-orb img")];
    const walkRight = images.find((img) => decodeURIComponent(img.src).endsWith("grok_walk_right.gif"));
    expect(walkRight?.hidden).toBe(true);
    expect(decodeURIComponent(walkRight!.src)).toContain("pet-walk/");

    await startDrag(container, 0, 0);
    await dragTo(20, 0);
    expect(shown(container).img).toBe(walkRight);
    expect(container.querySelectorAll(".pet-orb img")).toHaveLength(images.length);
  });

  it("上下拖不算走路", async () => {
    const { container } = await renderPet();
    const pet = container.querySelector(".pet-window")!;
    fireEvent.pointerDown(pet, { button: 0, clientX: 10, clientY: 10, screenX: 0, screenY: 0, pointerId: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await dragTo(2, 30);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("只有向右走的图时，往左拖把它镜像过来", async () => {
    const { container } = await renderPet({
      ...grok,
      animations: ["gifs/grok_idle.gif", "gifs/grok_walk_right.gif"],
    });
    await startDrag(container, 50, 0);
    await dragTo(40, 0);
    expect(shown(container)).toMatchObject({ file: "grok_walk_right.gif", flipped: true });
  });

  it("包里没有走路动作时拖动照常显示原来的动作", async () => {
    const { container } = await renderPet({
      ...grok,
      animations: ["gifs/grok_idle.gif", "gifs/grok_wave.gif"],
    });
    await startDrag(container, 0, 0);
    await dragTo(20, 0);
    expect(shown(container).file).toBe("grok_idle.gif");
  });
});

describe("桌宠：动作画面交接", () => {
  it("等待解码和交接时不移动已挂载的 GIF 节点，避免 WebView 重置动画", async () => {
    const { container, delay } = await renderPet();
    const mounted = new Set(container.querySelectorAll("img"));
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(container, { childList: true, subtree: true });
    try {
      await act(async () => click(container));
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      // 新动作尚未解码时，旧图和预加载的走路图都必须留在原来的 DOM 位置。
      expect(removed.filter((node) => mounted.has(node as HTMLImageElement))).toEqual([]);

      const next = container.querySelector<HTMLImageElement>("img.pet-action[hidden]")!;
      removed.length = 0;
      await loadPetImages();
      expect(shown(container).img).toBe(next);
      expect(removed).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });

  it("首帧和新动作始终不透明，只让覆盖在上层的旧画面淡出", async () => {
    render(<style>{petStyles}</style>);
    const { container, delay } = await renderPet();
    const idle = shown(container).img;
    expect(getComputedStyle(idle).animation).toBe("none");
    expect(getComputedStyle(idle).opacity).toBe("1");

    await act(async () => click(container));
    await elapse(delay);
    const next = shown(container).img;
    expect(getComputedStyle(next).animation).toBe("none");
    expect(getComputedStyle(next).opacity).toBe("1");
    expect(Number(getComputedStyle(idle).zIndex)).toBeGreaterThan(Number(getComputedStyle(next).zIndex));
    expect(getComputedStyle(idle).animation).toContain("pet-crossfade-out");
  });

  it("连续事件打断交接时保留不透明的新图，旧定时器不会提前结束下一次交接", async () => {
    render(<style>{petStyles}</style>);
    const asset = { ...grok, eventActions: {
      "capture.success": "gifs/grok_jump.gif",
      "capture.failure": "gifs/grok_wave.gif",
    } } satisfies PetAsset;
    const { container } = await renderPet(asset);
    await act(async () => { await emit("pet-event", "capture.success"); });
    await loadPetImages();
    const first = shown(container).img;
    await elapse(90);

    await act(async () => { await emit("pet-event", "capture.failure"); });
    expect(shown(container).img).toBe(first);
    expect(getComputedStyle(first).opacity).toBe("1");
    await loadPetImages();
    const next = shown(container).img;
    expect(shown(container).file).toBe("grok_wave.gif");
    expect(getComputedStyle(next).opacity).toBe("1");
    expect(getComputedStyle(next).animation).toBe("none");

    await elapse(90);
    expect(first.isConnected).toBe(true);
    expect(first.classList.contains("pet-crossfade-out")).toBe(true);
    await elapse(90);
    expect(first.isConnected).toBe(false);
    expect(shown(container).img).toBe(next);
  });

  it("新动作解码前保留旧节点，准备好后直接显示已加载的节点，返回待机时也不留空白", async () => {
    const { container, delay } = await renderPet();
    const idle = shown(container).img;
    await act(async () => click(container));
    await act(async () => { await vi.advanceTimersByTimeAsync(delay); });

    const next = container.querySelector<HTMLImageElement>("img.pet-action[hidden]")!;
    expect(decodeURIComponent(next.src)).toContain("grok_jump.gif");
    let finishDecode!: () => void;
    next.decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    await act(async () => { fireEvent.load(next); });
    expect(shown(container).img).toBe(idle);
    expect(next.hidden).toBe(true);

    await act(async () => { finishDecode(); });
    expect(shown(container).img).toBe(next);
    expect(idle.isConnected).toBe(true);
    expect(idle.classList.contains("pet-crossfade-out")).toBe(true);
    expect(next.classList.contains("pet-current")).toBe(true);
    expect(container.querySelectorAll("img").length).toBeLessThanOrEqual(4);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(shown(container).img).toBe(next);
    await loadPetImages();
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("新动作读取失败时保留当前画面，后续动作仍可正常切换", async () => {
    const { container, delay } = await renderPet();
    const idle = shown(container).img;
    await act(async () => click(container));
    await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    const failed = container.querySelector<HTMLImageElement>("img.pet-action[hidden]")!;
    fireEvent.error(failed);
    expect(shown(container).img).toBe(idle);
    expect(failed.hidden).toBe(true);

    await act(async () => click(container));
    await elapse(delay);
    expect(shown(container).file).toBe("grok_wave.gif");
    expect(failed.isConnected).toBe(false);
  });

  it("重复事件重新准备画面，过期解码不能覆盖后来动作，也不会累积隐藏图片", async () => {
    const asset = { ...grok, eventActions: { "capture.success": "gifs/grok_jump.gif" } } satisfies PetAsset;
    const { container } = await renderPet(asset);
    const idle = shown(container).img;
    await act(async () => { await emit("pet-event", "capture.success"); });
    const stale = container.querySelector<HTMLImageElement>("img.pet-action[hidden]")!;
    let finishStale!: () => void;
    stale.decode = vi.fn(() => new Promise<void>((resolve) => { finishStale = resolve; }));
    await act(async () => { fireEvent.load(stale); });

    await act(async () => { await emit("pet-event", "capture.success"); });
    expect(stale.isConnected).toBe(false);
    await act(async () => { finishStale(); });
    expect(shown(container).img).toBe(idle);
    await loadPetImages();
    expect(shown(container).file).toBe("grok_jump.gif");

    for (let count = 0; count < 5; count += 1) {
      const previous = shown(container).img;
      await act(async () => { await emit("pet-event", "capture.success"); });
      expect(shown(container).img).toBe(previous);
      expect(container.querySelectorAll("img").length).toBeLessThanOrEqual(5);
      await loadPetImages();
      expect(shown(container).img).not.toBe(previous);
      expect(previous.classList.contains("pet-crossfade-out")).toBe(true);
      await elapse(180);
      expect(previous.isConnected).toBe(false);
    }
  });
});

describe("桌宠：应用图标和自定义宠物的大小", () => {
  it("同一缩放下切换宠物会放大，移动和换屏缩放保留当前外观，切回图标恢复原大小", async () => {
    const screenWidth = vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1000);
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(1200);
    const iconSettings = { ...settingsWith(grok), selectedAppearanceId: "app-icon", petScale: 150 };
    const sizes: Array<{ width: number; height: number }> = [];

    vi.useFakeTimers();
    setupTauriMock(
      (command, payload) => {
        if (command === "load_settings") return iconSettings;
        if (command === "get_previous_app") return { id: null, pid: null, name: "", title: "" };
        if (command === "plugin:window|current_monitor") return null;
        if (command === "plugin:window|set_size") {
          const args = payload as { value: { size: { width: number; height: number } } };
          sizes.push({ width: args.value.size.width, height: args.value.size.height });
        }
        return undefined;
      },
      { currentWindow: "pet", shouldMockEvents: true },
    );
    vi.resetModules();
    const { PetWindow } = await import("./PetWindow");
    const { container } = render(<PetWindow />);
    await elapse(0);

    const expectSize = (side: number) => {
      expect(sizes.at(-1)).toEqual({ width: side, height: side });
      const petWindow = container.querySelector<HTMLElement>(".pet-window")!;
      expect(petWindow.style.getPropertyValue("--pet-icon-size")).toBe(`${side - 4}px`);
    };

    expect(container.querySelector(".pet-window.app-icon")).not.toBeNull();
    expectSize(120);

    await act(async () => {
      await emit("settings-changed", { ...iconSettings, selectedAppearanceId: grok.id });
    });
    await loadPetImages();
    expect(shown(container).file).toBe("grok_idle.gif");
    expectSize(285);

    screenWidth.mockReturnValue(800);
    await moveTo([100, 100]);
    expectSize(228);

    screenWidth.mockReturnValue(1000);
    await act(async () => {
      await emit("tauri://scale-change", { scaleFactor: 2, size: { width: 480, height: 480 } });
    });
    expectSize(285);

    await act(async () => {
      await emit("settings-changed", iconSettings);
    });
    expect(container.querySelector(".pet-window.app-icon")).not.toBeNull();
    expectSize(120);
  });
});

describe("桌宠：超出基准画布时把窗口撑大", () => {
  it("平时仍是方窗，扣篮时窗口变大且脚留在原地，结束后缩回去", async () => {
    render(<style>{petStyles}</style>);
    const shortEdge = 340;
    const side = petWindowSize(shortEdge, 100, "pet");
    const idle = { entry: "gifs/idle.gif", width: 100, height: 100, anchorX: 50, anchorY: 90 };
    const dunk = { entry: "gifs/dunk.gif", width: 200, height: 180, anchorX: 60, anchorY: 170 };
    const layout: PetLayout = { baseWidth: 100, baseHeight: 100, anchorX: 50, anchorY: 90, frames: [idle, dunk] };
    const resting = petPlacement(side, layout, idle)!;
    const grown = petPlacement(side, layout, dunk)!;
    const origin = { x: 400, y: 300 };
    let position = { ...origin };
    const sizes: Array<{ width: number; height: number }> = [];
    const shifts: Array<{ x: number; y: number }> = [];

    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(shortEdge);
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(800);

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
    await loadPetImages();

    const visible = () => {
      const frames = [...container.querySelectorAll<HTMLImageElement>("img.pet-framed")].filter((img) => !img.hidden);
      return frames.filter((img) => img.classList.contains("pet-current"));
    };
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

    // 新动作还未准备好时，旧图、窗口大小和脚底位置都保留。
    expect(visible()[0]).toBe(idleImage);
    expect(sizes.at(-1)).toEqual({ width: side, height: side });
    expect(position).toEqual(origin);
    await loadPetImages();

    const dunkImage = visible()[0];
    expect(decodeURIComponent(dunkImage.src)).toContain("dunk.gif");
    expect(grown.width).toBeGreaterThan(side);
    expect(grown.shiftY).toBeLessThan(0);
    expect(dunkImage.style.left).toBe(`${grown.imageX - grown.shiftX}px`);
    expect(dunkImage.style.top).toBe(`${grown.imageY - grown.shiftY}px`);
    expect(dunkImage.style.width).toBe(`${grown.imageWidth}px`);
    expect(dunkImage.style.height).toBe(`${grown.imageHeight}px`);
    expect(getComputedStyle(dunkImage).opacity).toBe("1");
    expect(getComputedStyle(dunkImage).animation).toBe("none");
    expect(Number(getComputedStyle(idleImage).zIndex)).toBeGreaterThan(Number(getComputedStyle(dunkImage).zIndex));
    expect(sizes.at(-1)).toEqual({ width: grown.width, height: grown.height });
    expect(position).toEqual({ x: origin.x + grown.shiftX, y: origin.y + grown.shiftY });
    expect(shifts.at(-1)).toEqual({ x: grown.shiftX, y: grown.shiftY });
    const feetY = grown.imageY + dunk.anchorY * (grown.imageHeight / dunk.height);
    expect(position.y + (feetY - grown.shiftY)).toBeCloseTo(origin.y + resting.imageY + idle.anchorY * (resting.imageHeight / idle.height));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await loadPetImages();
    expect(decodeURIComponent(visible()[0].src)).toContain("idle.gif");
    expect(sizes.at(-1)).toEqual({ width: side, height: side });
    expect(position).toEqual(origin);
    expect(shifts.at(-1)).toEqual({ x: 0, y: 0 });
  });
});
