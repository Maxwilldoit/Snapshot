import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoViewer } from "./PhotoViewer";
import { setupTauriMock, invokeArgs } from "../test/tauri";
import type { MediaItem } from "../lib/mediaTimeline";

const records: MediaItem[] = ["first", "second", "third"].map((id) => ({
  id, kind: "snapshot" as const, appName: id, fileName: `${id}.png`, width: 200, height: 100, sizeBytes: 1000, createdAt: 1,
}));

/** 固定 rAF 时钟：手动逐帧推进物理引擎，断言不依赖真实时间 */
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 0;
let clock = 0;

function pump(frames: number, stepMs = 16) {
  for (let i = 0; i < frames; i++) {
    clock += stepMs;
    const due = rafQueue;
    rafQueue = [];
    act(() => { for (const item of due) item.cb(clock); });
  }
}

beforeEach(() => {
  rafQueue = [];
  rafId = 0;
  clock = 0;
  vi.stubGlobal("performance", { now: () => clock });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push({ id: ++rafId, cb });
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue = rafQueue.filter((item) => item.id !== id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("photo-stage")) return new DOMRect(100, 50, 800, 600);
    if (this.hasAttribute("data-thumb-id")) return new DOMRect(140, 400, 160, 80);
    return new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

function renderViewer(startId = "first", onClose = () => {}) {
  setupTauriMock();
  render(
    <>
      <button data-thumb-id={startId}>缩略图</button>
      <PhotoViewer records={records} startId={startId} onClose={onClose} />
    </>,
  );
  return document.querySelector<HTMLElement>(".photo-stage")!;
}

function media(): HTMLElement {
  return document.querySelector<HTMLElement>(".photo-pane:not([aria-hidden]) .photo-media")!;
}

function transformOf(el: HTMLElement): { scale: number; tx: number; ty: number } {
  const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0px\) scale\(([-\d.]+)\)/.exec(el.style.transform);
  if (!match) throw new Error(`no transform: ${el.style.transform}`);
  return { tx: Number(match[1]), ty: Number(match[2]), scale: Number(match[3]) };
}

function wheel(stage: HTMLElement, init: Partial<WheelEvent> & { deltaY: number }) {
  const event = new Event("wheel", { cancelable: true, bubbles: true }) as WheelEvent;
  Object.defineProperties(event, {
    deltaX: { value: init.deltaX ?? 0 },
    deltaY: { value: init.deltaY },
    deltaMode: { value: init.deltaMode ?? 0 },
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
    clientX: { value: init.clientX ?? 500 },
    clientY: { value: init.clientY ?? 350 },
  });
  act(() => { stage.dispatchEvent(event); });
  return event;
}

describe("Quick Look 原位进退场与手势接管", () => {
  it("打开时从居中 95% 原位轻快微缩放渐显至 100%，关闭时原位轻缩淡出", () => {
    const onClose = vi.fn();
    renderViewer("first", onClose);
    const start = transformOf(media());
    // 原位居中微缩放（95%），不做跨屏飞行
    expect(start.scale).toBeCloseTo(0.95, 5);
    expect(Number(media().style.opacity)).toBe(0);
    pump(15); // > 160ms
    const settled = transformOf(media());
    expect(settled.scale).toBe(1);
    expect(settled.tx).toBe(300);
    expect(settled.ty).toBe(250);
    expect(media().style.opacity).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    pump(3);
    expect(onClose).not.toHaveBeenCalled();
    expect(transformOf(media()).scale).toBeLessThan(1);
    pump(15); // > 140ms
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("进场动画进行到一半时捏合输入立即接管，无跳变且不残留半透明", () => {
    const stage = renderViewer();
    pump(4);
    const mid = transformOf(media());
    expect(mid.scale).toBeGreaterThan(0.95);
    expect(mid.scale).toBeLessThan(1);
    wheel(stage, { deltaY: -10, ctrlKey: true });
    const after = transformOf(media());
    expect(media().style.opacity).toBe("");
    expect(after.scale).toBeGreaterThan(mid.scale);
    expect(after.scale).toBeLessThan(mid.scale * 1.5);
    pump(200);
  });

  it("macOS WKWebView 原生 GestureEvent 双指捏合可连续放大并在松手时立即结算", () => {
    const stage = renderViewer();
    pump(20);
    const startEvt = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.defineProperty(startEvt, "scale", { value: 1 });
    act(() => { stage.dispatchEvent(startEvt); });

    const changeEvt = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.defineProperties(changeEvt, { scale: { value: 1.8 }, clientX: { value: 500 }, clientY: { value: 350 } });
    act(() => { stage.dispatchEvent(changeEvt); });
    expect(transformOf(media()).scale).toBeCloseTo(1.8, 3);

    act(() => { stage.dispatchEvent(new Event("gestureend", { bubbles: true, cancelable: true })); });
    pump(50);
    expect(transformOf(media()).scale).toBeCloseTo(1.8, 2);
  });

  it("Esc 原位淡出完成后调用 onClose", async () => {
    const onClose = vi.fn();
    renderViewer("first", onClose);
    pump(20);
    await userEvent.setup().keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    pump(20);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("捏合缩放", () => {
  it("ctrl+wheel 以光标为锚指数放大，未触边时锚点像素精确不动", () => {
    const stage = renderViewer();
    pump(120);
    const before = transformOf(media());
    const cx = 400; // 图中心（clientX 500）
    const cy = 300; // 图中心（clientY 350）
    const contentX = (cx - before.tx) / before.scale;
    const contentY = (cy - before.ty) / before.scale;
    wheel(stage, { deltaY: -6, ctrlKey: true, clientX: 500, clientY: 350 });
    const after = transformOf(media());
    expect(after.scale).toBeGreaterThan(1);
    expect(after.tx + contentX * after.scale).toBeCloseTo(cx, 6);
    expect(after.ty + contentY * after.scale).toBeCloseTo(cy, 6);
    pump(300);
    const settled = transformOf(media());
    expect(settled.scale).toBeGreaterThanOrEqual(1);
    expect(settled.scale).toBeLessThanOrEqual(8);
  });

  it("普通滚轮在放大态平移，越界后弹簧收回界内", () => {
    const stage = renderViewer();
    pump(120);
    // 先放大到 2x 以上
    for (let i = 0; i < 12; i++) wheel(stage, { deltaY: -12, ctrlKey: true });
    pump(200);
    const zoomed = transformOf(media());
    expect(zoomed.scale).toBeGreaterThan(1.5);
    // 平移
    wheel(stage, { deltaY: 30 });
    const moved = transformOf(media());
    expect(moved.ty).not.toBe(zoomed.ty);
    // 松手（时间推进超过空闲阈值）→ 惯性/弹簧 → 最终合法
    pump(400);
    const settled = transformOf(media());
    const scaledW = 200 * settled.scale;
    const scaledH = 100 * settled.scale;
    expect(settled.tx).toBeGreaterThanOrEqual(Math.min(0, 800 - scaledW) - 0.5);
    expect(settled.tx).toBeLessThanOrEqual(Math.max(0, (800 - scaledW) / 2) + 0.5);
    expect(settled.ty).toBeGreaterThanOrEqual(Math.min(0, 600 - scaledH) - 0.5);
    expect(settled.ty).toBeLessThanOrEqual(Math.max(0, (600 - scaledH) / 2) + 0.5);
  });

  it("捏到 1x 以下松手弹回 1x；捏过退场阈值直接关闭", () => {
    const onClose = vi.fn();
    const stage = renderViewer("first", onClose);
    pump(120);
    // 小幅内捏 → 弹回
    wheel(stage, { deltaY: 12, ctrlKey: true });
    expect(transformOf(media()).scale).toBeLessThan(1);
    pump(300);
    expect(transformOf(media()).scale).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    // 连续大幅内捏到 0.82 以下 → 松手关闭
    for (let i = 0; i < 8; i++) wheel(stage, { deltaY: 14, ctrlKey: true });
    expect(transformOf(media()).scale).toBeLessThan(0.82);
    pump(300);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("离散鼠标滚轮缩放单次不超过 ±15%", () => {
    const stage = renderViewer();
    pump(120);
    wheel(stage, { deltaY: -240, ctrlKey: true, deltaMode: 0 });
    const after = transformOf(media());
    expect(after.scale).toBeLessThanOrEqual(1.15 + 1e-6);
    pump(300);
  });
});

describe("双击直线放大", () => {
  it("双击角落放大到 2.5x，再双击复位；轨迹为直线", () => {
    const stage = renderViewer();
    pump(120);
    const start = transformOf(media());
    const anchorClient = { clientX: 100 + 790, clientY: 50 + 590 }; // 视口右下角
    const anchor = { x: 790, y: 590 };
    const positions: Array<{ x: number; y: number }> = [];
    fireEvent.doubleClick(stage, anchorClient);
    for (let i = 0; i < 40; i++) {
      pump(1);
      const frame = transformOf(media());
      positions.push({
        x: frame.tx + ((anchor.x - start.tx) / start.scale) * frame.scale,
        y: frame.ty + ((anchor.y - start.ty) / start.scale) * frame.scale,
      });
    }
    pump(200);
    const zoomed = transformOf(media());
    expect(zoomed.scale).toBeCloseTo(2.5, 3);
    // 共线性：所有帧的锚点像素都在起点→终点直线上（叉积≈0）
    const end = positions[positions.length - 1];
    for (const p of positions) {
      const cross = (p.x - anchor.x) * (end.y - anchor.y) - (p.y - anchor.y) * (end.x - anchor.x);
      expect(Math.abs(cross)).toBeLessThan(1);
    }
    fireEvent.doubleClick(stage, anchorClient);
    pump(300);
    expect(transformOf(media()).scale).toBe(1);
  });

  it("放大动画中途再次双击立即反向，无跳帧", () => {
    const stage = renderViewer();
    pump(120);
    fireEvent.doubleClick(stage, { clientX: 500, clientY: 350 });
    pump(4);
    const mid = transformOf(media());
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2.5);
    fireEvent.doubleClick(stage, { clientX: 500, clientY: 350 });
    pump(1);
    const next = transformOf(media());
    expect(Math.abs(next.scale - mid.scale)).toBeLessThan(0.5);
    pump(300);
    expect(transformOf(media()).scale).toBe(1);
  });
});

describe("翻页", () => {
  it("1x 横向拖过 30% 松手切到下一张，旧图缩放静默复位", () => {
    const stage = renderViewer();
    pump(120);
    // 先放大再复位不了——直接拖：模拟 pointer 序列
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 700, clientY: 350 });
    for (let i = 1; i <= 10; i++) {
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 700 - i * 40, clientY: 350 });
      pump(1);
    }
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 300, clientY: 350 });
    pump(300);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("second");
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(transformOf(media()).scale).toBe(1);
  });

  it("拖动不足且无甩动速度时弹回当前张", () => {
    const stage = renderViewer();
    pump(120);
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 500, clientY: 350 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 460, clientY: 350 });
    pump(1);
    // 停顿让速度归零
    clock += 300;
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 460, clientY: 350 });
    pump(300);
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("方向键与按钮翻页走弹簧滑动", async () => {
    renderViewer();
    pump(120);
    await userEvent.setup().keyboard("{ArrowRight}");
    pump(300);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上一张" }));
    pump(300);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一张" })).toHaveProperty("disabled", true);
  });
});

describe("操作与可访问性", () => {
  it("预览下方显示实际月日，同年省略年份、跨年显示年份，录屏沿用相同规则", () => {
    setupTauriMock();
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 17, 12).getTime());
    render(<PhotoViewer records={[
      { ...records[0], createdAt: new Date(2026, 10, 17, 9, 11).getTime() },
      { ...records[1], kind: "recording", createdAt: new Date(2025, 11, 31, 22, 19).getTime() },
    ]} startId="first" onClose={() => {}} />);
    pump(120);
    const date = () => document.querySelector(".lightbox-meta time")!;
    expect(date().textContent).toBe("11月17日 09:11");
    expect(date().getAttribute("datetime")).toBe(new Date(2026, 10, 17, 9, 11).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    pump(200);
    expect(date().textContent).toBe("2025年12月31日 22:19");
  });

  it("Ctrl/Cmd+C 复制当前图片，切换后复制新的图片", async () => {
    const copied: string[] = [];
    setupTauriMock((command, args) => {
      if (command === "copy_snapshot") {
        const id = String(invokeArgs(args).id);
        copied.push(id);
        return `已复制 ${id}`;
      }
    });
    render(<PhotoViewer records={records} startId="first" onClose={() => {}} />);
    pump(120);
    const user = userEvent.setup();
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 first");
    await user.keyboard("{ArrowRight}");
    pump(300);
    await user.keyboard("{Meta>}c{/Meta}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 second");
    expect(copied).toEqual(["first", "second"]);
  });

  it("复制失败显示原因并允许重试", async () => {
    let missing = true;
    setupTauriMock((command) => {
      if (command === "copy_snapshot") {
        if (missing) throw new Error("快照文件已被移动或删除");
        return "已复制 first";
      }
    });
    render(<PhotoViewer records={records} startId="first" onClose={() => {}} />);
    pump(120);
    const user = userEvent.setup();
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("快照文件已被移动或删除");
    missing = false;
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 first");
  });

  it("标注按钮打开标注窗口；录屏不显示标注、保留播放控件", () => {
    const annotate = vi.fn();
    setupTauriMock((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    });
    render(<PhotoViewer records={records} startId="first" onClose={() => {}} />);
    pump(120);
    fireEvent.click(screen.getByRole("button", { name: "标注" }));
    expect(annotate).toHaveBeenCalledWith("first");
  });

  it("录屏保留原生播放控件，复制快捷键与标注都不可用", async () => {
    const copied = vi.fn();
    setupTauriMock((command) => {
      if (command === "copy_snapshot") copied();
    });
    render(<PhotoViewer records={[{ ...records[0], kind: "recording", fileName: "first.mp4", durationMs: 3000 }]} startId="first" onClose={() => {}} />);
    pump(120);
    expect(screen.getByLabelText("first").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("first")).toHaveProperty("controls", true);
    expect(screen.queryByRole("button", { name: "标注" })).toBeNull();
    await userEvent.setup().keyboard("{Control>}c{/Control}{Meta>}c{/Meta}");
    expect(copied).not.toHaveBeenCalled();
  });

  it("Enter 键盘缩放（可访问性）与 reduced-motion 直接落位", () => {
    document.documentElement.dataset.motion = "reduced";
    const stage = renderViewer();
    // reduced-motion：英雄展开直接落位
    expect(transformOf(media()).scale).toBe(1);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(transformOf(media()).scale).toBeCloseTo(2.5, 3);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(transformOf(media()).scale).toBe(1);
    void stage;
  });

  it("触控板连续小步下拉能突破 140px 阈值并退场关闭，不再陷入递归阻尼死锁", () => {
    const onClose = vi.fn();
    const stage = renderViewer("first", onClose);
    pump(120);
    // 每次仅下拉 12px（旧逻辑渐近上限仅 108px < 140px），连续 15 帧共 180px
    for (let i = 0; i < 15; i++) wheel(stage, { deltaY: -12 });
    expect(transformOf(media()).ty - 250).toBeGreaterThan(140);
    pump(300);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("偏离中心捏合缩小到 1x 以下时保持光标锚点不向左上角漂移", () => {
    const stage = renderViewer();
    pump(120);
    const before = transformOf(media());
    // 取图片左边缘附近作为捏合锚点（stage left=100, top=50 → stage 内坐标 cx=320, cy=270）
    const cx = 320;
    const cy = 270;
    const contentX = (cx - before.tx) / before.scale;
    const contentY = (cy - before.ty) / before.scale;
    wheel(stage, { deltaY: 10, ctrlKey: true, clientX: 100 + cx, clientY: 50 + cy });
    wheel(stage, { deltaY: 10, ctrlKey: true, clientX: 100 + cx, clientY: 50 + cy });
    const after = transformOf(media());
    expect(after.scale).toBeLessThan(1);
    expect(after.tx + contentX * after.scale).toBeCloseTo(cx, 2);
    expect(after.ty + contentY * after.scale).toBeCloseTo(cy, 2);
  });

  it("鼠标按住下拉超过 140px 后静止超过 110ms 不会中途提前关闭，松手才触发关闭", () => {
    const onClose = vi.fn();
    const stage = renderViewer("first", onClose);
    pump(120);
    fireEvent.pointerDown(stage, { pointerId: 7, button: 0, clientX: 500, clientY: 200 });
    fireEvent.pointerMove(stage, { pointerId: 7, clientX: 500, clientY: 380 });
    // 按住静止 320ms（超过 GESTURE_IDLE_MS = 110ms）
    pump(20);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerUp(stage, { pointerId: 7, clientX: 500, clientY: 380 });
    pump(200);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("从按钮焦点打开时立即接管焦点，拉宽窗口同步重排邻图槽位，切页自动暂停录屏", () => {
    let resizeCb: (() => void) | undefined;
    let stageW = 800;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { resizeCb = cb; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("photo-stage")) return new DOMRect(100, 50, stageW, 600);
      if (this.hasAttribute("data-thumb-id")) return new DOMRect(140, 400, 160, 80);
      return new DOMRect(0, 0, 0, 0);
    });
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => false });

    setupTauriMock();
    render(<>
      <button data-thumb-id="rec">缩略图按钮</button>
      <PhotoViewer
        records={[
          { ...records[0], id: "rec", kind: "recording", fileName: "rec.mp4" },
          records[1],
        ]}
        startId="rec"
        onClose={() => {}}
      />
    </>);
    const stage = document.querySelector<HTMLElement>(".photo-stage")!;
    expect(document.activeElement).toBe(stage);

    stageW = 1000;
    act(() => resizeCb?.());
    const nextPane = document.querySelectorAll<HTMLElement>(".photo-pane")[1];
    expect(nextPane.style.transform).toContain("translate3d(1024px,");

    pump(120);
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    pump(200);
    expect(pauseSpy).toHaveBeenCalled();
  });
});
