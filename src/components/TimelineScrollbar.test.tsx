import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineScrollbar, type TimelineStop } from "./TimelineScrollbar";

/** 轨道高 360，视口 400、内容 2400 → 可滚 2000、滑块 60（高于 36 的下限）、可走 300。 */
const VIEW = 400;
const CONTENT = 2400;
const MAX = CONTENT - VIEW;
const TRACK = 360;
const THUMB = 60;
const TRAVEL = TRACK - THUMB;
const TRACK_TOP = 8;

const stops: TimelineStop[] = [
  { key: "d0", label: "今天" },
  { key: "d1", label: "昨天" },
  { key: "d2", label: "11 月 11 日" },
  { key: "d3", label: "11 月 8 日" },
];
let offsets = [0, 600, 1200, 1800];
let resized: (() => void) | undefined;
let contentHeight = CONTENT;

function layout(scrollRef: RefObject<HTMLElement | null>) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this === scrollRef.current) return VIEW;
    if (this.classList.contains("timeline-scrollbar")) return TRACK + TRACK_TOP + 12;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this === scrollRef.current ? contentHeight : 0;
  });
  // jsdom 不实现 scrollTop 赋值：存到元素上，浏览器里由原生滚动派发事件。
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.testScrollTop ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) {
    this.dataset.testScrollTop = String(Math.max(0, Math.min(contentHeight - VIEW, value)));
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === scrollRef.current) return new DOMRect(0, 0, 300, VIEW);
    if (this.classList.contains("timeline-track")) return new DOMRect(278, TRACK_TOP, 22, TRACK);
    const key = this.dataset.dayKey;
    if (key) {
      const offset = offsets[stops.findIndex((stop) => stop.key === key)] ?? 0;
      const scrollerTop = Number(scrollRef.current?.dataset.testScrollTop ?? 0);
      return new DOMRect(0, -scrollerTop + offset, 300, 100);
    }
    return new DOMRect();
  });
  return { get: () => scrollRef.current?.scrollTop ?? 0 };
}

function Harness({ groups, empty = false }: { groups: TimelineStop[]; empty?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div className="history-scroll" ref={scrollRef}>
        <div>
          {empty ? "没有匹配的截图" : groups.map((stop) => <section key={stop.key} className="day" data-day-key={stop.key}>{stop.label}</section>)}
        </div>
      </div>
      <TimelineScrollbar scrollRef={scrollRef} stops={groups} />
    </div>
  );
}

function setup() {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  const scrollRef = { current: null as HTMLElement | null };
  const position = layout(scrollRef);
  const view = render(<Harness groups={stops} />);
  scrollRef.current = document.querySelector<HTMLElement>(".history-scroll");
  // 首次提交时滚动区 ref 还没挂上，浏览器靠 ResizeObserver 的首次通知补量；这里同样触发一次。
  act(() => resized?.());
  const scroller = scrollRef.current!;
  const scroll = (to: number) => {
    scroller.scrollTop = to;
    fireEvent.scroll(scroller);
  };
  return { scroller, position, scroll, view };
}

const root = () => document.querySelector<HTMLElement>(".timeline-scrollbar")!;
// 滚动条淡出时 aria-hidden，按可见性查不到；这里按语义角色查，不看可见性。
const thumb = () => screen.getByRole("slider", { name: "历史时间线", hidden: true });
const label = () => document.querySelector<HTMLElement>(".timeline-label")!;
const tick = (label: string) => screen.getByRole("button", { name: `跳到 ${label}`, hidden: true });

afterEach(() => vi.unstubAllGlobals());

// React 从 pointerover / pointerout 推导 enter / leave，测试里也派发这两个事件。

describe("历史时间线滚动条", () => {
  it("滚动时浮现，标签跟随吸顶日期，滑块按可见比例占位", async () => {
    const { scroll } = setup();
    expect(root().classList.contains("is-visible")).toBe(false);
    expect(root().getAttribute("aria-hidden")).toBe("true");
    expect(thumb().style.height).toBe(`${THUMB}px`);

    scroll(700);
    await waitFor(() => expect(root().classList.contains("is-visible")).toBe(true));
    expect(label().textContent).toBe("昨天");
    expect(thumb().getAttribute("aria-valuenow")).toBe("35");
    expect(thumb().style.top).toBe(`${(700 / MAX) * TRAVEL}px`);
    // 当前分组的刻度点亮；此刻四个刻度都露在滑块之外（滑块在轨道 35%–50%，刻度在 0 / 30% / 60% / 90%）
    expect(tick("昨天").classList.contains("is-active")).toBe(true);
    expect(tick("昨天").classList.contains("is-under-thumb")).toBe(false);
    expect(tick("11 月 11 日").classList.contains("is-under-thumb")).toBe(false);
    // 滚到刻度正下方时它让位给滑块
    scroll(1200);
    await waitFor(() => expect(tick("11 月 11 日").classList.contains("is-under-thumb")).toBe(true));
    expect(label().textContent).toBe("11 月 11 日");
    scroll(700);
    await waitFor(() => expect(label().textContent).toBe("昨天"));

    fireEvent.pointerOut(root(), { relatedTarget: document.body });
  });

  it("停下 1.2 秒后淡出；淡出后命中区还在，鼠标移回右缘能重新唤出", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { scroll } = setup();
    scroll(700);
    act(() => { vi.advanceTimersByTime(20); });
    expect(label().textContent).toBe("昨天");
    expect(root().classList.contains("is-visible")).toBe(true);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(root().classList.contains("is-visible")).toBe(true);
    act(() => { vi.advanceTimersByTime(200); });
    expect(root().classList.contains("is-visible")).toBe(false);
    expect(root().getAttribute("aria-hidden")).toBe("true");
    expect(root().classList.contains("is-interactive")).toBe(true);
    fireEvent.pointerOver(root(), { relatedTarget: document.body });
    expect(root().classList.contains("is-visible")).toBe(true);
    expect(root().getAttribute("aria-hidden")).toBe("false");
    // 悬停期间不淡出，离开后重新计时
    act(() => { vi.advanceTimersByTime(3000); });
    expect(root().classList.contains("is-visible")).toBe(true);
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1300); });
    expect(root().classList.contains("is-visible")).toBe(false);
  });

  it("悬停刻度预览那一天的日期，点击刻度跳到那天", () => {
    const { scroll, position } = setup();
    scroll(0);
    fireEvent.pointerOver(tick("11 月 11 日"));
    expect(label().textContent).toBe("11 月 11 日");
    expect(label().classList.contains("is-preview")).toBe(true);
    fireEvent.click(tick("11 月 11 日"));
    expect(position.get()).toBe(1200);
    fireEvent.pointerOut(tick("11 月 11 日"));
    expect(label().textContent).toBe("11 月 11 日");
    expect(label().classList.contains("is-preview")).toBe(false);
  });

  it("拖动滑块按轨道比例定位，滑出轨道也不中断，松手后不再跟随", () => {
    const { scroll, position } = setup();
    scroll(0);
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientY: TRACK_TOP + THUMB / 2 });
    expect(document.activeElement).toBe(thumb());
    expect(root().classList.contains("is-dragging")).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: TRACK_TOP + THUMB / 2 + TRAVEL });
    expect(position.get()).toBe(MAX);
    expect(label().textContent).toBe("11 月 8 日");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: TRACK_TOP + THUMB / 2 + TRAVEL / 2 });
    expect(position.get()).toBe(MAX / 2);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(root().classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientY: TRACK_TOP });
    expect(position.get()).toBe(MAX / 2);
  });

  it("点空白轨道让滑块中心落到指针处，按住可继续拖", () => {
    const { position } = setup();
    const track = document.querySelector<HTMLElement>(".timeline-track")!;
    fireEvent.pointerDown(track, { button: 0, pointerId: 2, clientY: TRACK_TOP + TRACK / 2 });
    expect(position.get()).toBe(((TRACK / 2 - THUMB / 2) / TRAVEL) * MAX);
    fireEvent.pointerMove(window, { pointerId: 2, clientY: TRACK_TOP + TRACK + 10 });
    expect(position.get()).toBe(MAX);
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(root().classList.contains("is-dragging")).toBe(false);
  });

  it("键盘：Home / End 到两端，左右键换日期，上下键按视口四分之一滚动", () => {
    const { position } = setup();
    thumb().focus();
    fireEvent.keyDown(thumb(), { key: "End" });
    expect(position.get()).toBe(MAX);
    expect(label().textContent).toBe("11 月 8 日");
    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    expect(position.get()).toBe(1200);
    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(position.get()).toBe(1800);
    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(position.get()).toBe(0);
    fireEvent.keyDown(thumb(), { key: "ArrowDown" });
    expect(position.get()).toBe(VIEW * 0.25);
    fireEvent.keyDown(thumb(), { key: "ArrowUp" });
    expect(position.get()).toBe(0);
    fireEvent.keyDown(thumb(), { key: "PageDown" });
    expect(position.get()).toBe(VIEW - 40);
    // 聚焦期间不淡出
    vi.useFakeTimers();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(root().classList.contains("is-visible")).toBe(true);
    fireEvent.pointerOver(root(), { relatedTarget: document.body });
    thumb().blur();
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1300); });
    expect(root().classList.contains("is-visible")).toBe(false);
  });

  it("筛选后分组变化重新测量；没有可滚内容时立即收起", () => {
    const { scroll, view } = setup();
    scroll(1200);
    const fewer = stops.slice(0, 2);
    offsets = [0, 600];
    view.rerender(<Harness groups={fewer} />);
    act(() => resized?.());
    expect(screen.queryByRole("button", { name: "跳到 11 月 11 日", hidden: true })).toBeNull();
    expect(tick("昨天").style.top).toBe(`${(600 / MAX) * TRAVEL}px`);

    // 无结果：容器不再溢出
    contentHeight = VIEW;
    view.rerender(<Harness groups={[]} empty />);
    act(() => resized?.());
    expect(root().classList.contains("is-visible")).toBe(false);
    expect(root().classList.contains("is-interactive")).toBe(false);
    expect(screen.queryByRole("slider", { hidden: true })).toBeNull();
    contentHeight = CONTENT;
    offsets = [0, 600, 1200, 1800];
  });
});
