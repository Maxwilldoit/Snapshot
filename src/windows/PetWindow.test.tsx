import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import type { PetAsset, PetLayout, Settings } from "../types";
import { petPlacement } from "../lib/petFrame";
import { petWindowSize } from "../lib/petSize";
import { setupTauriMock } from "../test/tauri";
import petStyles from "../styles.css?raw";

vi.mock("../lib/petAutoScale", () => ({ measurePetScale: vi.fn().mockResolvedValue(null) }));

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
  geometry: {
    scale?: number;
    size?: { width: number; height: number };
    monitors?: Array<Record<string, unknown>>;
    readMonitor?: () => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  } = {},
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
      if (command === "plugin:window|outer_size") return geometry.size ?? { width: 160, height: 160 };
      if (command === "plugin:window|scale_factor") return geometry.scale ?? 1;
      if (command === "plugin:window|current_monitor") return geometry.readMonitor ? geometry.readMonitor() : monitor;
      if (command === "plugin:window|available_monitors") return geometry.monitors ?? (monitor ? [monitor] : []);
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
  it("非方形宠物的可视底边贴住窗口底部，拖到任务栏时脚不会被透明留白悬空", async () => {
    render(<style>{petStyles}</style>);
    const { container } = await renderPet();
    expect(getComputedStyle(shown(container).img).objectPosition).toBe("center bottom");
  });

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

describe("桌宠：左右屏幕边界", () => {
  const monitor = {
    name: "test", scaleFactor: 1,
    position: { x: 0, y: 0 }, size: { width: 1000, height: 900 },
    workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 840 } },
  };

  function mediaBox() {
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1000);
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(840);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 160, 160));
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(80);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(160);
  }

  it.each([false, true])("可见内容在拖动时贴齐左右边缘，松手不再按透明方窗回弹（重力 %s）", async (petGravity) => {
    mediaBox();
    const { container, position } = await renderPet(grok, { petGravity }, { x: 100, y: 680 }, monitor);
    await elapse(32);
    await startDrag(container);
    await dragTo(-1000, 100);
    expect(position.x).toBe(-40);
    await endDrag();
    await elapse(1000);
    expect(position).toEqual({ x: -40, y: 680 });

    await startDrag(container);
    await dragTo(2000, 100);
    expect(position.x).toBe(880);
    await endDrag();
    await elapse(1000);
    expect(position).toEqual({ x: 880, y: 680 });
  });

  it("200% DPI 下使用物理边界，负原点屏幕的透明留白可以越界", async () => {
    mediaBox();
    const left = {
      ...monitor, scaleFactor: 2,
      position: { x: -2000, y: 0 }, size: { width: 2000, height: 1800 },
      workArea: { position: { x: -2000, y: 0 }, size: { width: 2000, height: 1680 } },
    };
    const { container, position } = await renderPet(grok, {}, { x: -1000, y: 200 }, left, {}, {
      scale: 2, size: { width: 320, height: 320 },
    });
    await elapse(32);
    await startDrag(container);
    await dragTo(-2000, 100);
    expect(position.x).toBe(-2080);
    await endDrag();
    expect(position.x).toBe(-2080);
    await startDrag(container);
    await dragTo(2000, 100);
    expect(position.x).toBe(-240);
    await endDrag();
    expect(position.x).toBe(-240);
  });

  it("恢复屏幕外旧坐标后，下落不会继续写入校准前的横坐标", async () => {
    mediaBox();
    const { position } = await renderPet(grok, { petGravity: true }, { x: -200, y: 100 }, monitor);
    await elapse(1000);
    expect(position).toEqual({ x: -40, y: 680 });
  });

  it("上一轮松手的边界查询晚到时，不会打断新一轮拖拽", async () => {
    mediaBox();
    let delayed: Promise<typeof monitor> | undefined;
    let release!: (value: typeof monitor) => void;
    const { container, position } = await renderPet(grok, {}, { x: 100, y: 100 }, monitor, {}, {
      readMonitor: () => {
        const result = delayed ?? monitor;
        delayed = undefined;
        return result;
      },
    });
    await elapse(32);
    await startDrag(container);
    await dragTo(150, 100);
    delayed = new Promise((resolve) => { release = resolve; });
    await endDrag();

    await startDrag(container);
    await dragTo(100, -100);
    expect(position.y).toBe(-100);
    await act(async () => { release(monitor); });
    expect(position.y).toBe(-100);
    await endDrag();
    expect(position.y).toBe(0);
  });

  it("相邻显示器接缝允许跨过，直到整个桌面的右侧边缘才停止", async () => {
    mediaBox();
    const right = { ...monitor, position: { x: 1000, y: 0 },
      workArea: { ...monitor.workArea, position: { x: 1000, y: 0 } } };
    const { container, position } = await renderPet(grok, {}, { x: 800, y: 100 }, monitor, {}, { monitors: [monitor, right] });
    await elapse(32);
    await startDrag(container);
    await dragTo(400, 100);
    expect(position.x).toBe(1100);
    await endDrag();
    expect(position.x).toBe(1100);
    await startDrag(container);
    await dragTo(3000, 100);
    expect(position.x).toBe(1880);
    await endDrag();
    expect(position.x).toBe(1880);
  });

  it("靠边后切换尺寸不同的锚点动作，返回待机时仍保留角色的横向基准", async () => {
    mediaBox();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(parseFloat(this.style.left), parseFloat(this.style.top), parseFloat(this.style.width), parseFloat(this.style.height));
    });
    const asset = { ...grok, layout: { baseWidth: 100, baseHeight: 200, anchorX: 50, anchorY: 190,
      frames: [
        { entry: grok.entry, width: 100, height: 200, anchorX: 50, anchorY: 190 },
        { entry: grok.animations[1], width: 200, height: 360, anchorX: 60, anchorY: 350 },
      ] } };
    const { container, position, delay } = await renderPet(asset, {}, { x: 0, y: 100 }, monitor);
    await elapse(32);
    await startDrag(container);
    await dragTo(-1000, 100);
    await endDrag();
    const edgeX = position.x;
    expect(edgeX).toBeLessThan(0);
    await act(async () => click(container));
    await elapse(delay);
    await elapse(3000);
    expect(position.x).toBe(edgeX);
  });

  it("带 pet.json 的透明 WebM 也按 alpha 可见范围贴边", async () => {
    mediaBox();
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(96);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(96);
    vi.spyOn(HTMLVideoElement.prototype, "readyState", "get").mockReturnValue(2);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const data = new Uint8ClampedArray(96 * 96 * 4);
    for (let y = 0; y < 96; y += 1) {
      for (let x = 24; x < 72; x += 1) data[(y * 96 + x) * 4 + 3] = 255;
    }
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data }),
    } as unknown as CanvasRenderingContext2D);
    const asset = { ...grok, entry: "idle.webm", animations: ["idle.webm"],
      layout: { baseWidth: 96, baseHeight: 96, anchorX: 48, anchorY: 96,
        frames: [{ entry: "idle.webm", width: 96, height: 96, anchorX: 48, anchorY: 96 }] } };
    const { container, position } = await renderPet(asset, {}, { x: 100, y: 100 }, monitor);
    await act(async () => { fireEvent.loadedData(container.querySelector("video")!); });
    await elapse(32);
    await startDrag(container);
    await dragTo(-1000, 100);
    expect(position.x).toBe(-40);
    await endDrag();
    expect(position.x).toBe(-40);
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
  it("普通素材首次测量后自动放大，切换和切回沿用各自缓存，不跟随动作反复测量", async () => {
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1000);
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(1200);
    const small = { ...grok, id: "auto-small", name: "任意名字" };
    const normal = { ...grok, id: "auto-normal", name: "任意名字" };
    const { measurePetScale } = await import("../lib/petAutoScale");
    const measured = vi.mocked(measurePetScale).mockImplementation(async (asset) => asset.id === small.id ? 200 : 100);
    measured.mockClear();
    const saved = { ...settingsWith(small), petAssets: [small, normal] };
    const { container, delay } = await renderPet(small, saved);
    const size = () => container.querySelector<HTMLElement>(".pet-window")!.style.getPropertyValue("--pet-icon-size");
    expect(size()).toBe("376px");
    await act(async () => click(container));
    await elapse(delay);
    expect(size()).toBe("376px");
    expect(measured).toHaveBeenCalledTimes(1);
    await act(async () => { await emit("settings-changed", { ...saved, selectedAppearanceId: normal.id }); });
    await elapse(0);
    expect(size()).toBe("186px");
    await act(async () => { await emit("settings-changed", saved); });
    await elapse(0);
    expect(size()).toBe("376px");
    expect(measured).toHaveBeenCalledTimes(2);
    // 同一 id/路径更新素材元数据时重新适配，事件读取的也必须是新素材。
    measured.mockResolvedValue(160);
    await act(async () => {
      await emit("settings-changed", { ...saved, petAssets: [{ ...small, sizeBytes: 42 }, normal] });
    });
    await elapse(0);
    expect(size()).toBe("300px");
    expect(measured).toHaveBeenCalledTimes(3);
    measured.mockResolvedValue(null);
  });

  it("同一缩放下切换宠物会放大，移动和换屏缩放保留当前外观，切回图标恢复原大小", async () => {
    localStorage.setItem("snapshot-pet-base-scales", JSON.stringify({ "pet-enlarged": 200 }));
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

    const enlarged = { ...grok, id: "pet-enlarged" };
    const enlargedSettings = { ...iconSettings, selectedAppearanceId: enlarged.id, petAssets: [grok, enlarged] };
    await act(async () => { await emit("settings-changed", enlargedSettings); });
    await loadPetImages();
    expectSize(570);

    screenWidth.mockReturnValue(800);
    await moveTo([100, 100]);
    expectSize(456);

    screenWidth.mockReturnValue(1000);
    await act(async () => {
      await emit("tauri://scale-change", { scaleFactor: 2, size: { width: 480, height: 480 } });
    });
    expectSize(570);

    // 同一形象收到基准偏好事件时立即缩放；换回同名的普通形象恢复自己的基准。
    const { persistPetBaseScale } = await import("../lib/petScale");
    await act(async () => {
      persistPetBaseScale(enlarged.id, 150);
    });
    expectSize(428);
    await act(async () => {
      await emit("settings-changed", { ...enlargedSettings, selectedAppearanceId: grok.id });
    });
    await loadPetImages();
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

// DSH clip names are adapted from the upstream configuration; see THIRD_PARTY_NOTICES.md.
const whale: PetAsset = {
  id: "renamed-companion", name: "任意显示名称", path: "local.zip", entry: "pack/待机呼吸休闲.webm",
  animations: [
    "待机呼吸休闲", "被鼠标拖拽悬空反馈", "点击回应-开心跃动", "点击回应-害羞惊讶",
    "东张西望", "螃蟹走路", "原地漂浮踏步", "原地左转奔跑", "悠闲哼歌", "原地专心玩魔方",
    "工作状态-忙碌点按", "工作状态-原地踱步张望", "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗",
    "余额-分文不剩", "碎碎念-发呆碎碎念",
  ].map((name) => `pack/${name}.webm`),
};
const loadedVideos = new WeakSet<HTMLVideoElement>();

async function loadPetVideos() {
  await act(async () => {
    for (const video of document.querySelectorAll<HTMLVideoElement>(".pet-window video")) {
      if (loadedVideos.has(video)) continue;
      loadedVideos.add(video);
      fireEvent.loadedData(video);
    }
  });
}

function shownVideo(container: HTMLElement) {
  const media = container.querySelector<HTMLVideoElement>("video.pet-current");
  if (!media) throw new Error("桌宠没有可见视频");
  return { media, file: decodeURIComponent(media.src).split("/").pop() };
}

async function renderWhale(overrides: Partial<Settings> = {}) {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(10);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(360);
  const view = await renderPet(whale, overrides);
  await loadPetVideos();
  return view;
}

describe("桌宠：DSH 动作交互", () => {
  it("单击立即选点击回应，首帧就位后 Q 弹，并等真实 ended 才回待机", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container, calls } = await renderWhale();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
    await act(async () => click(container));
    const incoming = [...container.querySelectorAll<HTMLVideoElement>("video")]
      .find((media) => decodeURIComponent(media.src).endsWith("点击回应-开心跃动.webm"))!;
    expect(incoming).toBeTruthy();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel } as unknown as Animation));
    Object.defineProperty(incoming, "animate", { value: animate });
    expect(animate).not.toHaveBeenCalled();
    await loadPetVideos();
    expect(shownVideo(container).media).toBe(incoming);
    expect(incoming.loop).toBe(false);
    expect(animate).toHaveBeenCalledTimes(1);
    await elapse(3500);
    expect(shownVideo(container).media).toBe(incoming);
    await act(async () => { fireEvent.ended(incoming); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
    expect(calls).not.toContain("show_launchpad");
  });

  it("拖动使用已预加载的悬空动作，松手回待机，不触发点击回应", async () => {
    const { container } = await renderWhale();
    const held = [...container.querySelectorAll<HTMLVideoElement>("video")]
      .find((media) => decodeURIComponent(media.src).endsWith("被鼠标拖拽悬空反馈.webm"))!;
    expect(held.hidden).toBe(true);
    await startDrag(container);
    expect(shownVideo(container).media).toBe(held);
    expect(held.loop).toBe(true);
    await dragTo(160, 100);
    await elapse(12_000);
    expect(shownVideo(container).media).toBe(held);
    await endDrag();
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
    expect(container.querySelectorAll('video[src*="%E7%82%B9%E5%87%BB"]')).toHaveLength(0);
  });

  it("连续点击能重播且避免连抽，上一段迟到的 ended 不会掐断新动作", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container, delay } = await renderWhale();
    await act(async () => click(container));
    await loadPetVideos();
    const first = shownVideo(container).media;
    await elapse(delay);
    await act(async () => click(container));
    await loadPetVideos();
    const second = shownVideo(container).media;
    expect(shownVideo(container).file).toBe("点击回应-害羞惊讶.webm");
    await act(async () => { fireEvent.ended(first); });
    expect(shownVideo(container).media).toBe(second);
    await act(async () => { fireEvent.ended(second); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
  });

  it("工作状态可被点击暂时打断，播完和拖拽松手后都恢复当前状态", async () => {
    const { container } = await renderWhale();
    await act(async () => { await emit("recording-changed", { active: true }); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("工作状态-忙碌点按.webm");
    expect(shownVideo(container).media.loop).toBe(true);
    await act(async () => click(container));
    await loadPetVideos();
    const clicked = shownVideo(container);
    expect(clicked.file).toMatch(/^点击回应-/);
    await act(async () => { fireEvent.ended(clicked.media); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("工作状态-忙碌点按.webm");
    await startDrag(container);
    expect(shownVideo(container).file).toBe("被鼠标拖拽悬空反馈.webm");
    await endDrag();
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("工作状态-忙碌点按.webm");
  });

  it("成功/失败反馈播完恢复持续状态，专用动作不会混入普通点击", async () => {
    const { container } = await renderWhale({ shortcutsPaused: true });
    expect(shownVideo(container).file).toBe("工作状态-原地踱步张望.webm");
    for (const [event, expected] of [
      ["capture.success", "工作状态-雀跃庆祝.webm"],
      ["capture.failure", "工作状态-垂头叹气冒汗.webm"],
    ]) {
      await act(async () => { await emit("pet-event", event); });
      await loadPetVideos();
      expect(shownVideo(container).file).toBe(expected);
      expect(shownVideo(container).media.loop).toBe(false);
      await act(async () => { fireEvent.ended(shownVideo(container).media); });
      await loadPetVideos();
      expect(shownVideo(container).file).toBe("工作状态-原地踱步张望.webm");
    }
  });

  it("新动作加载失败能回到待机，切到其它角色后忽略旧视频的回调", async () => {
    const { container } = await renderWhale();
    await act(async () => click(container));
    const broken = [...container.querySelectorAll<HTMLVideoElement>("video")]
      .find((media) => decodeURIComponent(media.src).includes("点击回应-"))!;
    await act(async () => { fireEvent.error(broken); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
    await act(async () => { await emit("settings-changed", settingsWith(grok)); });
    await loadPetImages();
    await act(async () => { fireEvent.ended(broken); });
    expect(shown(container).file).toBe("grok_idle.gif");
    await elapse(8000);
    expect(shown(container).file).toBe("grok_idle.gif");
  });

  it("保留双击打开启动台，取消第一下正在播放的回应", async () => {
    const { container, calls } = await renderWhale();
    await act(async () => click(container));
    await loadPetVideos();
    await elapse(100);
    await act(async () => click(container));
    await loadPetVideos();
    expect(calls.filter((command) => command === "show_launchpad")).toHaveLength(1);
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
  });

  it("随机动作只从分类池抽取，播完接下一段，关闭开关后恢复待机", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { container } = await renderWhale({ petRandomActions: true });
    expect(shownVideo(container).file).toBe("原地专心玩魔方.webm");
    const first = shownVideo(container).media;
    await elapse(3500);
    expect(shownVideo(container).media).toBe(first);
    await act(async () => { fireEvent.ended(first); });
    await loadPetVideos();
    expect(shownVideo(container).media).not.toBe(first);
    expect(shownVideo(container).file).toBe("原地专心玩魔方.webm");

    await act(async () => { await emit("settings-changed", { ...settingsWith(whale), petRandomActions: false }); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
    const idle = shownVideo(container).media;
    await elapse(30_000);
    expect(shownVideo(container).media).toBe(idle);
    expect(idle.loop).toBe(true);
  });

  it("转身片完整播完才翻转朝向，点击和拖拽沿用新的朝向", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.11);
    const { container } = await renderWhale({ petRandomActions: true });
    expect(shownVideo(container).file).toBe("东张西望.webm");
    expect(shownVideo(container).media.classList.contains("pet-flip")).toBe(false);
    await elapse(3500);
    expect(shownVideo(container).media.classList.contains("pet-flip")).toBe(false);
    await act(async () => { fireEvent.ended(shownVideo(container).media); });
    await loadPetVideos();
    expect(shownVideo(container).media.classList.contains("pet-flip")).toBe(true);
    await act(async () => click(container));
    await loadPetVideos();
    expect(shownVideo(container).file).toMatch(/^点击回应-/);
    expect(shownVideo(container).media.classList.contains("pet-flip")).toBe(true);
    await startDrag(container);
    expect(shownVideo(container).file).toBe("被鼠标拖拽悬空反馈.webm");
    expect(shownVideo(container).media.classList.contains("pet-flip")).toBe(true);
    await endDrag();
  });

  it("右键只打开快捷菜单，保留当前自动动作及进度，播完后动作链继续", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { container, calls } = await renderWhale({ petRandomActions: true });
    expect(shownVideo(container).file).toBe("原地专心玩魔方.webm");
    const current = shownVideo(container).media;
    current.currentTime = 4.25;
    await act(async () => {
      fireEvent.pointerDown(container.querySelector(".pet-window")!, { button: 2 });
      fireEvent.contextMenu(container.querySelector(".pet-window")!, { screenX: 300, screenY: 400 });
    });
    await loadPetVideos();
    expect(calls.filter((command) => command === "show_quick_menu")).toHaveLength(1);
    expect(shownVideo(container).media).toBe(current);
    expect(current.currentTime).toBe(4.25);
    expect(current.loop).toBe(false);
    await act(async () => { fireEvent.ended(current); });
    await elapse(20);
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("原地专心玩魔方.webm");
    expect(shownVideo(container).media).not.toBe(current);
  });

  it("右键不打断正在播放的点击回应，回应完成后照常回待机", async () => {
    const { container } = await renderWhale();
    await act(async () => click(container));
    await loadPetVideos();
    const current = shownVideo(container).media;
    current.currentTime = 3;
    await act(async () => { fireEvent.contextMenu(container.querySelector(".pet-window")!); });
    await loadPetVideos();
    expect(shownVideo(container).media).toBe(current);
    expect(current.currentTime).toBe(3);
    expect(current.loop).toBe(false);
    await act(async () => { fireEvent.ended(current); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("待机呼吸休闲.webm");
  });

  it("右键不清除一次性反馈，反馈结束后仍恢复持续状态", async () => {
    const { container } = await renderWhale({ shortcutsPaused: true });
    await act(async () => { await emit("pet-event", "capture.success"); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("工作状态-雀跃庆祝.webm");
    const current = shownVideo(container).media;
    current.currentTime = 6;
    await act(async () => { fireEvent.contextMenu(container.querySelector(".pet-window")!); });
    await loadPetVideos();
    expect(shownVideo(container).media).toBe(current);
    expect(current.currentTime).toBe(6);
    await act(async () => { fireEvent.ended(current); });
    await loadPetVideos();
    expect(shownVideo(container).file).toBe("工作状态-原地踱步张望.webm");
  });

  it("普通 GIF 角色右键时也保留当前随机动作的节点和正常收尾", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { container, calls } = await renderPet(grok, { petRandomActions: true });
    await elapse(6600);
    expect(shown(container).file).toBe("grok_wave.gif");
    const current = shown(container).img;
    await act(async () => { fireEvent.contextMenu(container.querySelector(".pet-window")!); });
    await loadPetImages();
    expect(calls).toContain("show_quick_menu");
    expect(shown(container).img).toBe(current);
    await elapse(3000);
    expect(shown(container).file).toBe("grok_idle.gif");
  });
});
