import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineScrollbar, type TimelineStop } from "./TimelineScrollbar";

/** 轨道高 360，上下内缩 14 → 刻度有效跨度 332（Y: 14..346 对应 scrollTop: 0..2000）。 */
const VIEW = 400;
const CONTENT = 2400;
const MAX = CONTENT - VIEW;
const TRACK = 360;
const RULER_PAD = 14;
const SPAN = TRACK - RULER_PAD * 2;
const TRACK_TOP = 8;

const stops: TimelineStop[] = [
  { key: "d0", label: "今天", timestamp: new Date(2026, 10, 14, 12, 0).getTime() },
  { key: "d1", label: "昨天", timestamp: new Date(2026, 10, 13, 12, 0).getTime() },
  { key: "d2", label: "10 月 20 日", timestamp: new Date(2026, 9, 20, 12, 0).getTime() },
  { key: "d3", label: "2025 年 12 月 3 日", timestamp: new Date(2025, 11, 3, 12, 0).getTime() },
];
let offsets = [0, 600, 1200, 1800];
let resized: (() => void) | undefined;
let contentHeight = CONTENT;

function layout(scrollRef: RefObject<HTMLElement | null>, activeStops: TimelineStop[]) {
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
    if (this.classList.contains("timeline-track")) return new DOMRect(222, TRACK_TOP, 78, TRACK);
    const key = this.dataset.dayKey;
    if (key) {
      const offset = offsets[activeStops.findIndex((stop) => stop.key === key)] ?? 0;
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

function setup(customStops: TimelineStop[] = stops) {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  const scrollRef = { current: null as HTMLElement | null };
  const position = layout(scrollRef, customStops);
  const view = render(<Harness groups={customStops} />);
  scrollRef.current = document.querySelector<HTMLElement>(".history-scroll");
  act(() => resized?.());
  const scroller = scrollRef.current!;
  const scroll = (to: number) => {
    scroller.scrollTop = to;
    fireEvent.scroll(scroller);
  };
  return { scroller, position, scroll, view };
}

const root = () => document.querySelector<HTMLElement>(".timeline-scrollbar")!;
const thumb = () => screen.getByRole("slider", { name: "历史时间线" });
const label = () => document.querySelector<HTMLElement>(".timeline-label")!;
const tick = (name: string) => screen.getByRole("button", { name: `跳到 ${name}` });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  contentHeight = CONTENT;
  offsets = [0, 600, 1200, 1800];
});

describe("历史侧边刻度尺时间轴滚动条", () => {
  it("可滚动时常驻展示年月刻度与细刻度线，滚动页面时高亮对应时间节点", async () => {
    const { scroll } = setup();
    // 刻度尺本身始终可见，不需要先滚或悬停才出现
    expect(root().classList.contains("is-visible")).toBe(true);
    expect(root().classList.contains("is-interactive")).toBe(true);
    expect(root().getAttribute("aria-hidden")).toBe("false");
    expect(document.querySelectorAll(".timeline-graduation").length).toBeGreaterThan(10);

    // 跨月/跨年时以年月作为主节点展示，同月后续天保留为小刻度
    expect(tick("今天").querySelector(".timeline-stop-text")?.textContent).toBe("2026年11月");
    expect(tick("昨天").querySelector(".timeline-stop-text")).toBeNull();
    expect(tick("10 月 20 日").querySelector(".timeline-stop-text")?.textContent).toBe("10月");
    expect(tick("2025 年 12 月 3 日").querySelector(".timeline-stop-text")?.textContent).toBe("2025年12月");

    // 滚到 2026 年 11 月的第二天：对应月份节点保持高亮，游标位置沿刻度尺推进
    scroll(700);
    await waitFor(() => expect(label().textContent).toBe("昨天"));
    expect(tick("今天").classList.contains("is-active")).toBe(true);
    expect(tick("昨天").classList.contains("is-active-stop")).toBe(true);
    expect(thumb().getAttribute("aria-valuenow")).toBe("35");
    expect(thumb().style.top).toBe(`${RULER_PAD + (700 / MAX) * SPAN}px`);

    // 滚到 2025 年 12 月：2025年12月 节点高亮
    scroll(1800);
    await waitFor(() => expect(label().textContent).toBe("2025 年 12 月 3 日"));
    expect(tick("2025 年 12 月 3 日").classList.contains("is-active")).toBe(true);
    expect(tick("今天").classList.contains("is-active")).toBe(false);
  });

  it("悬浮日期气泡停下 1.2 秒后淡出，但侧边刻度尺保持常驻可见", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { scroll } = setup();
    expect(root().classList.contains("is-visible")).toBe(true);
    expect(label().classList.contains("is-shown")).toBe(false);

    scroll(1200);
    act(() => { vi.advanceTimersByTime(20); });
    expect(label().textContent).toBe("10 月 20 日");
    expect(label().classList.contains("is-shown")).toBe(true);

    act(() => { vi.advanceTimersByTime(1300); });
    expect(label().classList.contains("is-shown")).toBe(false);
    // 刻度尺依然可见且可直接点击/悬浮
    expect(root().classList.contains("is-visible")).toBe(true);

    fireEvent.pointerOver(root(), { relatedTarget: document.body });
    expect(label().classList.contains("is-shown")).toBe(true);
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1300); });
    expect(label().classList.contains("is-shown")).toBe(false);
  });

  it("点击刻度直接跳转到对应年份/月份，悬停时预览该日期", () => {
    const { scroll, position } = setup();
    scroll(0);
    fireEvent.pointerOver(tick("2025 年 12 月 3 日"));
    expect(label().textContent).toBe("2025 年 12 月 3 日");
    expect(label().classList.contains("is-preview")).toBe(true);

    fireEvent.click(tick("2025 年 12 月 3 日"));
    expect(position.get()).toBe(1800);
    expect(tick("2025 年 12 月 3 日").classList.contains("is-active")).toBe(true);

    fireEvent.pointerOut(tick("2025 年 12 月 3 日"));
    expect(label().classList.contains("is-preview")).toBe(false);
  });

  it("按住任意刻度直接拖拽即可连续滑动年份/月份，松手不会回跳到起点刻度", () => {
    const { scroll, position } = setup();
    scroll(0);
    const firstTick = tick("今天");
    fireEvent.pointerDown(firstTick, { button: 0, pointerId: 9, clientY: TRACK_TOP + RULER_PAD });
    // 未达拖动阈值时不进入拖动
    expect(root().classList.contains("is-dragging")).toBe(false);
    // 往下拖动到刻度尺底端：进入拖拽并直接滚到最底端
    fireEvent.pointerMove(window, { pointerId: 9, clientY: TRACK_TOP + RULER_PAD + SPAN });
    expect(root().classList.contains("is-dragging")).toBe(true);
    expect(position.get()).toBe(MAX);
    expect(label().textContent).toBe("2025 年 12 月 3 日");

    // 拖到中点后松手，并模拟浏览器紧随其后派发的 click：位置应停在中点，不能跳回 d0
    fireEvent.pointerMove(window, { pointerId: 9, clientY: TRACK_TOP + RULER_PAD + SPAN / 2 });
    expect(position.get()).toBe(MAX / 2);
    fireEvent.pointerUp(window, { pointerId: 9 });
    fireEvent.click(firstTick);
    expect(position.get()).toBe(MAX / 2);
  });

  it("拖动游标或按住空白刻度尺滑出轨道也不中断，松手后停止跟随", () => {
    const { scroll, position } = setup();
    scroll(0);
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientY: TRACK_TOP + RULER_PAD });
    expect(document.activeElement).toBe(thumb());
    expect(root().classList.contains("is-dragging")).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: TRACK_TOP + RULER_PAD + SPAN });
    expect(position.get()).toBe(MAX);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(root().classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientY: TRACK_TOP + RULER_PAD });
    expect(position.get()).toBe(MAX);

    // 点空白刻度尺也支持直接落位并继续拖拽
    const track = document.querySelector<HTMLElement>(".timeline-track")!;
    fireEvent.pointerDown(track, { button: 0, pointerId: 2, clientY: TRACK_TOP + RULER_PAD + SPAN / 2 });
    expect(position.get()).toBe(MAX / 2);
    fireEvent.pointerMove(window, { pointerId: 2, clientY: TRACK_TOP + RULER_PAD + SPAN + 20 });
    expect(position.get()).toBe(MAX);
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(root().classList.contains("is-dragging")).toBe(false);
  });

  it("同月多天分组时展示简洁日刻度并防重叠；无时间戳数据也正常工作", () => {
    const sameMonthStops: TimelineStop[] = [
      { key: "a", label: "今天", timestamp: new Date(2026, 10, 14, 12, 0).getTime() },
      { key: "b", label: "昨天", timestamp: new Date(2026, 10, 13, 12, 0).getTime() },
      { key: "c", label: "11 月 10 日", timestamp: new Date(2026, 10, 10, 12, 0).getTime() },
      { key: "d", label: "11 月 5 日", timestamp: new Date(2026, 10, 5, 12, 0).getTime() },
    ];
    setup(sameMonthStops);
    expect(tick("今天").querySelector(".timeline-stop-text")?.textContent).toBe("今天");
    expect(tick("昨天").querySelector(".timeline-stop-text")?.textContent).toBe("昨天");
    expect(tick("11 月 10 日").querySelector(".timeline-stop-text")?.textContent).toBe("11/10");
    expect(tick("11 月 5 日").querySelector(".timeline-stop-text")?.textContent).toBe("11/5");
  });

  it("键盘：Home / End 到两端，左右键换刻度节点，上下键按视口四分之一滚动", () => {
    const { position } = setup();
    thumb().focus();
    fireEvent.keyDown(thumb(), { key: "End" });
    expect(position.get()).toBe(MAX);
    expect(label().textContent).toBe("2025 年 12 月 3 日");
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
  });

  it("筛选后分组变化重新测量；没有可滚内容时立即收起", () => {
    const { scroll, view } = setup();
    scroll(1200);
    const fewer = stops.slice(0, 2);
    offsets = [0, 600];
    view.rerender(<Harness groups={fewer} />);
    act(() => resized?.());
    expect(screen.queryByRole("button", { name: "跳到 10 月 20 日" })).toBeNull();
    expect(tick("昨天").style.top).toBe(`${RULER_PAD + (600 / MAX) * SPAN}px`);

    contentHeight = VIEW;
    view.rerender(<Harness groups={[]} empty />);
    act(() => resized?.());
    expect(root().classList.contains("is-visible")).toBe(false);
    expect(root().classList.contains("is-interactive")).toBe(false);
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
