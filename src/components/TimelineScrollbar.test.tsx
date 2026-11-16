import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineScrollbar } from "./TimelineScrollbar";
import type { TimelineStop } from "../lib/timelineScrubber";
import { I18nProvider } from "../lib/i18n";

const VIEW = 400;
const CONTENT = 2400;
const MAX = CONTENT - VIEW;
const TRACK = 360;
const PAD = 14;
const TRACK_TOP = 8;
const SPAN = (TRACK - PAD * 2) * MAX / CONTENT;
const stops: TimelineStop[] = [
  { key: "d0", timestamp: new Date(2026, 7, 15).getTime() },
  { key: "d1", timestamp: new Date(2026, 7, 5).getTime() },
  { key: "d2", timestamp: new Date(2026, 6, 26).getTime() },
  { key: "d3", timestamp: new Date(2026, 6, 16).getTime() },
];
let contentHeight = CONTENT;
let rootHeight = TRACK + TRACK_TOP + 12;
let rootLeft = 264;
let rootTop = 0;
let offsets = new Map(stops.map((stop, index) => [stop.key, index * 600]));
let resize: (() => void) | undefined;
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const frame = () => advance(20);
const settle = () => advance(120);
const root = () => document.querySelector<HTMLElement>(".timeline-scrollbar")!;
const slider = () => screen.getByRole("slider", { name: "历史时间线" });
const bubble = () => screen.getByRole("tooltip", { hidden: true });
const yAt = (ratio: number) => rootTop + TRACK_TOP + PAD + ratio * (rootHeight - TRACK_TOP - 12 - PAD * 2) * (contentHeight - VIEW) / contentHeight;
const tickWidths = () => [...document.querySelectorAll<HTMLElement>(".timeline-tick")].map((tick) => Number.parseFloat(tick.style.width));
const peak = () => tickWidths().indexOf(Math.max(...tickWidths()));

function Harness({ groups }: { groups: TimelineStop[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return <div>
    <div className="history-scroll" ref={scrollRef}><div>{groups.map((stop) => <section key={stop.key} data-day-key={stop.key} />)}</div></div>
    <TimelineScrollbar scrollRef={scrollRef} stops={groups} />
  </div>;
}

function setup(groups = stops, language = "zh") {
  vi.useFakeTimers();
  localStorage.setItem("snapshot-language", language);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("history-scroll") ? VIEW : this.classList.contains("timeline-scrollbar") ? rootHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("history-scroll") ? contentHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.testTop ?? 0); });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) { this.dataset.testTop = String(Math.max(0, Math.min(contentHeight - VIEW, value))); });
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("history-scroll")) return new DOMRect(0, 0, rootLeft, VIEW);
    if (this.classList.contains("timeline-scrollbar")) return new DOMRect(rootLeft, rootTop, 36, rootHeight);
    if (this.classList.contains("timeline-label")) return new DOMRect(0, 0, 150, 24);
    if (this.dataset.dayKey) return new DOMRect(0, (offsets.get(this.dataset.dayKey) ?? 0) - Number(document.querySelector<HTMLElement>(".history-scroll")?.dataset.testTop ?? 0), 264, 100);
    return new DOMRect();
  });
  const view = render(<I18nProvider><Harness groups={groups} /></I18nProvider>);
  frame();
  const scroller = document.querySelector<HTMLElement>(".history-scroll")!;
  const scrollNow = (top: number) => { scroller.scrollTop = top; fireEvent.scroll(scroller); };
  const scroll = (top: number) => { scrollNow(top); settle(); };
  const hover = (ratio: number) => { fireEvent.pointerOver(root(), { clientY: yAt(ratio), relatedTarget: document.body }); fireEvent.pointerMove(root(), { clientY: yAt(ratio) }); frame(); settle(); };
  return { view, scroller, scroll, scrollNow, hover, bounds };
}

afterEach(() => {
  vi.unstubAllGlobals();
  contentHeight = CONTENT;
  rootHeight = TRACK + TRACK_TOP + 12;
  rootLeft = 264;
  rootTop = 0;
  offsets = new Map(stops.map((stop, index) => [stop.key, index * 600]));
  delete document.documentElement.dataset.motion;
});

describe("content date scrubber", () => {
  it("starts with a live wave and follows normal scrolling without opening a date", () => {
    const { scroll } = setup();
    expect(document.querySelectorAll(".timeline-tick")).toHaveLength(Math.floor(SPAN / 12) + 1);
    expect(root().textContent).toBe("");
    expect(root().classList.contains("is-engaged")).toBe(false);
    expect(bubble().getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".timeline-thumb, .timeline-rail, .timeline-stop-text, .timeline-cursor, .timeline-focus")).toBeNull();
    const initialWidths = tickWidths();
    expect(initialWidths[0]).toBe(24);
    scroll(700);
    expect(slider().getAttribute("aria-valuetext")).toContain("2026年8月5日");
    expect(Number(slider().getAttribute("aria-valuenow"))).toBeGreaterThan(33);
    expect(peak()).toBe(Math.round(700 / MAX * (initialWidths.length - 1)));
    expect(Math.max(...tickWidths())).toBeGreaterThanOrEqual(22);
    expect(tickWidths()).not.toEqual(initialWidths);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("previews the real date without scrolling and restores the scrolling wave on leave", () => {
    const { hover, scroller } = setup();
    const initialWidths = tickWidths();
    hover(0.64);
    expect(bubble().textContent).toBe("2026年7月26日");
    expect(bubble().classList.contains("is-shown")).toBe(true);
    expect(peak()).toBe(Math.round(0.64 * (initialWidths.length - 1)));
    expect(scroller.scrollTop).toBe(0);
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); settle();
    expect(bubble().classList.contains("is-shown")).toBe(false);
    expect(tickWidths()).toEqual(initialWidths);
    fireEvent.pointerOver(root(), { clientY: yAt(0), relatedTarget: document.body });
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); settle();
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("keeps the scrolling position independent of hover and retains it after leaving", () => {
    const { hover, scroll } = setup();
    hover(0.64);
    const hovered = tickWidths();
    scroll(700);
    expect(slider().getAttribute("aria-valuenow")).toBe("35");
    expect(tickWidths()).toEqual(hovered);
    expect(bubble().textContent).toBe("2026年7月26日");
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); settle();
    expect(tickWidths()).not.toEqual(hovered);
    expect(peak()).toBe(Math.round(0.35 * (hovered.length - 1)));
    expect(bubble().classList.contains("is-shown")).toBe(false);
    scroll(MAX);
    expect(tickWidths().at(-1)).toBe(24);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("uses the same wave for hovering at the current position and after leaving", () => {
    const { hover } = setup();
    hover(0);
    const hoveredWidths = tickWidths();
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); frame();
    expect(tickWidths()).toEqual(hoveredWidths);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("resumes hover after keyboard navigation without requiring a new pointer entry", () => {
    const { hover, scroller } = setup();
    hover(0.64);
    act(() => slider().focus());
    fireEvent.keyDown(slider(), { key: "ArrowDown" });
    const current = scroller.scrollTop;
    fireEvent.pointerMove(root(), { clientY: yAt(0.95) }); frame();
    expect(scroller.scrollTop).toBe(current);
    expect(bubble().textContent).toBe("2026年7月16日");
  });

  it("clicks within real dates and drags continuously, including beyond the hit area and the last sample", () => {
    const { scroller } = setup();
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 7, clientY: yAt(0.64) });
    expect(scroller.scrollTop).toBeCloseTo(MAX * 0.64);
    fireEvent.pointerUp(window, { pointerId: 7, clientY: yAt(0.64) });
    expect(scroller.scrollTop).toBeCloseTo(MAX * 0.64);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 8, clientY: yAt(0) });
    fireEvent.pointerMove(window, { pointerId: 99, clientY: yAt(1) }); frame();
    expect(scroller.scrollTop).toBe(0);
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 10, clientY: yAt(1) + 100 }); frame();
    expect(scroller.scrollTop).toBe(MAX);
    expect(bubble().classList.contains("is-shown")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 8, clientY: yAt(0.3) });
    expect(scroller.scrollTop).toBeCloseTo(600);
    expect(bubble().classList.contains("is-shown")).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 8, clientY: yAt(1) }); frame();
    expect(scroller.scrollTop).toBeCloseTo(600);
  });

  it("ignores secondary presses and cancels gestures on pointer cancellation or window blur", () => {
    const { scroller } = setup();
    fireEvent.pointerDown(slider(), { button: 2, pointerId: 2, clientY: yAt(1) });
    expect(scroller.scrollTop).toBe(0);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 3, clientY: yAt(0) });
    fireEvent.pointerCancel(window, { pointerId: 9 });
    expect(root().classList.contains("is-dragging")).toBe(true);
    fireEvent.pointerCancel(window, { pointerId: 3 });
    expect(root().classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 4, clientY: yAt(0) });
    fireEvent.pointerMove(window, { pointerId: 4, clientY: yAt(1) });
    fireEvent.blur(window); frame();
    expect(scroller.scrollTop).toBe(0);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("supports focus, adjacent dates, Home/End, and page keys without a visible thumb", () => {
    offsets.set(stops[0].key, 12); // Gallery padding is not another date step.
    const { scroller } = setup();
    act(() => slider().focus());
    expect(bubble().classList.contains("is-shown")).toBe(true);
    fireEvent.keyDown(slider(), { key: "ArrowDown" });
    expect(scroller.scrollTop).toBe(600);
    fireEvent.keyDown(slider(), { key: "ArrowUp" });
    expect(scroller.scrollTop).toBe(0);
    fireEvent.keyDown(slider(), { key: "ArrowDown" });
    expect(scroller.scrollTop).toBe(600);
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(scroller.scrollTop).toBe(1200);
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    expect(scroller.scrollTop).toBe(600);
    fireEvent.keyDown(slider(), { key: "End" });
    expect(scroller.scrollTop).toBe(MAX);
    fireEvent.keyDown(slider(), { key: "Home" });
    expect(scroller.scrollTop).toBe(0);
    fireEvent.keyDown(slider(), { key: "PageDown" });
    expect(scroller.scrollTop).toBe(VIEW);
    fireEvent.keyDown(slider(), { key: "PageUp" });
    expect(scroller.scrollTop).toBe(0);
    act(() => slider().blur());
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("filters the full date index, cancels old drags, resizes ticks and disappears for empty/short lists", () => {
    const { view, scroller } = setup();
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 4, clientY: yAt(0) });
    offsets = new Map([["d0", 0], ["d3", 600]]);
    view.rerender(<I18nProvider><Harness groups={[stops[0], stops[3]]} /></I18nProvider>);
    fireEvent.pointerMove(window, { pointerId: 4, clientY: yAt(1) }); frame();
    expect(scroller.scrollTop).toBe(0);
    expect(root().classList.contains("is-dragging")).toBe(false);
    rootHeight = 260; act(() => resize?.()); frame();
    expect(document.querySelectorAll(".timeline-tick")).toHaveLength(Math.floor((260 - 20 - PAD * 2) * MAX / CONTENT / 12) + 1);
    contentHeight = VIEW; act(() => resize?.()); frame();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    contentHeight = CONTENT;
    view.rerender(<I18nProvider><Harness groups={[]} /></I18nProvider>);
    expect(screen.queryByRole("slider")).toBeNull();
    view.rerender(<I18nProvider><Harness groups={stops} /></I18nProvider>);
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(tickWidths()[0]).toBe(24);
  });

  it("allows proportional scrolling through a single long day", () => {
    const { scroller } = setup(stops.slice(0, 1));
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 1, clientY: yAt(0.5) });
    expect(scroller.scrollTop).toBe(MAX / 2);
    fireEvent.pointerUp(window, { pointerId: 1, clientY: yAt(0.5) });
    expect(bubble().textContent).toBe("2026年8月15日");
    fireEvent.keyDown(slider(), { key: "ArrowDown" });
    expect(scroller.scrollTop).toBeCloseTo(MAX * 0.6);
  });

  it("shrinks a short axis and follows small scroll steps between decorative ticks", () => {
    contentHeight = VIEW + 40;
    const { scroll } = setup();
    const height = Number.parseFloat(slider().style.height);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(height).toBeLessThan(60);
    expect(document.querySelectorAll(".timeline-tick").length).toBeLessThan(4);
    const waves = [0, 1, 2, 10, 39, 40].map((top) => { scroll(top); return tickWidths(); });
    expect(waves[1]).not.toEqual(waves[0]);
    expect(waves[2]).not.toEqual(waves[1]);
    expect(waves[0][0] - waves[1][0]).toBeGreaterThan(0);
    expect(waves[0][0] - waves[1][0]).toBeLessThan(1);
    expect(waves.every((widths) => Math.max(...widths) >= 22)).toBe(true);
    expect(waves.at(-1)?.at(-1)).toBe(24);
    expect(bubble().classList.contains("is-shown")).toBe(false);
    expect(root().classList.contains("is-engaged")).toBe(false);
  });

  it("moves continuously through the last date instead of stopping at its heading", () => {
    const { scroll } = setup();
    scroll(1800);
    const before = tickWidths().at(-1)!;
    scroll(1900);
    const middle = tickWidths().at(-1)!;
    scroll(2000);
    const end = tickWidths().at(-1)!;
    expect(middle - before).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(middle);
    expect(end).toBe(24);
  });

  it("changes the wave within a single tick during normal scrolling without reading date layout", () => {
    const { scroll, bounds } = setup();
    scroll(700);
    const widths = tickWidths();
    bounds.mockClear();
    scroll(701);
    expect(tickWidths()).not.toEqual(widths);
    expect(bounds.mock.contexts.filter((node) => (node as HTMLElement).hasAttribute("data-day-key"))).toHaveLength(0);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("keeps dragging and the tick wave continuous within the same date", () => {
    const { scroller } = setup();
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 1, clientY: yAt(0.62) });
    settle();
    const before = tickWidths();
    const date = bubble().textContent;
    fireEvent.pointerMove(window, { pointerId: 1, clientY: yAt(0.63) }); frame();
    expect(scroller.scrollTop).toBeCloseTo(MAX * 0.63);
    expect(tickWidths()).not.toEqual(before);
    expect(bubble().textContent).toBe(date);
  });

  it("leaves the bottom by keyboard even when final dates are below the scroll limit", () => {
    contentHeight = VIEW + 100;
    offsets = new Map(stops.map((stop, index) => [stop.key, index * 60]));
    const { scroller } = setup();
    act(() => slider().focus());
    fireEvent.keyDown(slider(), { key: "End" });
    expect(scroller.scrollTop).toBe(100);
    fireEvent.keyDown(slider(), { key: "ArrowUp" });
    expect(scroller.scrollTop).toBe(60);
    fireEvent.keyDown(slider(), { key: "ArrowDown" });
    expect(scroller.scrollTop).toBe(100);
    fireEvent.keyDown(slider(), { key: "Home" });
    expect(scroller.scrollTop).toBe(0);
  });

  it("coalesces high-frequency pointer input and does not remeasure the list", () => {
    const { hover, bounds } = setup();
    hover(0);
    bounds.mockClear();
    for (let index = 0; index < 100; index++) fireEvent.pointerMove(root(), { clientY: yAt(index / 100) });
    frame();
    expect(bubble().textContent).toBe("2026年7月16日");
    expect(bounds.mock.contexts.filter((node) => (node as HTMLElement).hasAttribute("data-day-key"))).toHaveLength(0);
  });

  it("tracks an entrance transform without a resize or remeasuring date sections", () => {
    const { hover, bounds } = setup();
    rootTop = 200;
    bounds.mockClear();
    hover(1 / 3);
    expect(bubble().textContent).toBe("2026年8月5日");
    expect(bounds.mock.contexts.filter((node) => (node as HTMLElement).hasAttribute("data-day-key"))).toHaveLength(0);
  });

  it("keeps the portal bubble inside viewport edges and formats English dates", () => {
    rootTop = -20;
    rootLeft = 5;
    const { hover } = setup(stops, "en");
    hover(0);
    expect(bubble().textContent).toBe("Aug 15, 2026");
    expect(Number.parseFloat(bubble().style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(bubble().style.top)).toBeGreaterThanOrEqual(20);
    hover(1);
    expect(Number.parseFloat(bubble().style.top)).toBeLessThan(window.innerHeight - 12);
  });

  it("cancels queued work and removes listeners when unmounted", () => {
    const { view } = setup();
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 1, clientY: yAt(0) });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: yAt(1) });
    view.unmount(); frame();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("paints small native scroll samples immediately without an extra frame or list measurements", () => {
    const { scrollNow, bounds } = setup();
    bounds.mockClear();
    const before = tickWidths();
    scrollNow(10);
    const first = tickWidths();
    expect(first).not.toEqual(before);
    scrollNow(20);
    expect(tickWidths()).not.toEqual(first);
    expect(slider().getAttribute("aria-valuenow")).toBe("1");
    expect(bubble().classList.contains("is-shown")).toBe(false);
    expect(bounds).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("matches the exact scroll position on every sample, even for a large jump", () => {
    const { scrollNow, bounds } = setup();
    bounds.mockClear();
    const count = tickWidths().length;
    scrollNow(MAX);
    expect(slider().getAttribute("aria-valuenow")).toBe("100");
    expect(peak()).toBe(count - 1);
    expect(tickWidths().at(-1)).toBe(24);
    expect(bubble().classList.contains("is-shown")).toBe(false);
    expect(bounds).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks fast bursts and reversals with no lag or trailing animation", () => {
    const { scrollNow } = setup();
    const count = tickWidths().length;
    for (const ratio of [0.3, 0.55, 0.7, 0.9, 1, 0.4, 0]) {
      scrollNow(MAX * ratio);
      expect(peak()).toBe(Math.round(ratio * (count - 1)));
      expect(Math.max(...tickWidths())).toBeGreaterThanOrEqual(22);
      expect(vi.getTimerCount()).toBe(0);
    }
    frame();
    expect(peak()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lands on the new position when layout changes mid-scroll", () => {
    const { scrollNow } = setup();
    scrollNow(MAX);
    expect(tickWidths().at(-1)).toBe(24);
    rootHeight = 260;
    act(() => resize?.()); frame();
    expect(tickWidths().at(-1)).toBe(24);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paints instantly under reduced motion without scheduling any frames", async () => {
    const { scrollNow, view } = setup();
    await act(async () => { document.documentElement.dataset.motion = "reduced"; });
    scrollNow(MAX);
    expect(tickWidths().at(-1)).toBe(24);
    scrollNow(0);
    expect(tickWidths()[0]).toBe(24);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
