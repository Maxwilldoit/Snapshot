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
const SPAN = TRACK - PAD * 2;
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
const frame = () => act(() => { vi.advanceTimersByTime(20); });
const root = () => document.querySelector<HTMLElement>(".timeline-scrollbar")!;
const slider = () => screen.getByRole("slider", { name: "历史时间线" });
const bubble = () => screen.getByRole("tooltip", { hidden: true });
const yAt = (ratio: number) => rootTop + TRACK_TOP + PAD + ratio * (rootHeight - TRACK_TOP - 12 - PAD * 2);

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
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(0), 16));
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
  const scroll = (top: number) => { scroller.scrollTop = top; fireEvent.scroll(scroller); frame(); };
  const hover = (ratio: number) => { fireEvent.pointerOver(root(), { clientY: yAt(ratio), relatedTarget: document.body }); fireEvent.pointerMove(root(), { clientY: yAt(ratio) }); frame(); };
  return { view, scroller, scroll, hover, bounds };
}

afterEach(() => {
  vi.unstubAllGlobals();
  contentHeight = CONTENT;
  rootHeight = TRACK + TRACK_TOP + 12;
  rootLeft = 264;
  rootTop = 0;
  offsets = new Map(stops.map((stop, index) => [stop.key, index * 600]));
});

describe("minimal hover date scrubber", () => {
  it("starts with only bounded ticks, and normal scrolling updates position without opening a date", () => {
    const { scroll } = setup();
    expect(document.querySelectorAll(".timeline-tick")).toHaveLength(Math.floor(SPAN / 12) + 1);
    expect(root().textContent).toBe("");
    expect(root().classList.contains("is-engaged")).toBe(false);
    expect(bubble().getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".timeline-thumb, .timeline-rail, .timeline-stop-text")).toBeNull();
    scroll(700);
    expect(slider().getAttribute("aria-valuetext")).toContain("2026年8月5日");
    expect(Number(slider().getAttribute("aria-valuenow"))).toBeGreaterThan(33);
    expect(document.querySelectorAll(".timeline-tick.is-current")).toHaveLength(1);
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("previews the nearest real date on hover without scrolling, and restores quiet ticks on leave", () => {
    const { hover, scroller } = setup();
    hover(0.64);
    expect(bubble().textContent).toBe("2026年7月26日");
    expect(bubble().classList.contains("is-shown")).toBe(true);
    expect(document.querySelectorAll(".timeline-tick.is-near-0")).toHaveLength(1);
    expect(scroller.scrollTop).toBe(0);
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); frame();
    expect(bubble().classList.contains("is-shown")).toBe(false);
    expect(document.querySelector(".is-near-0, .is-near-1, .is-near-2")).toBeNull();
    fireEvent.pointerOver(root(), { clientY: yAt(0), relatedTarget: document.body });
    fireEvent.pointerOut(root(), { relatedTarget: document.body }); frame();
    expect(bubble().classList.contains("is-shown")).toBe(false);
  });

  it("clicks actual dates, drags beyond the hit area and commits the final pointer position", () => {
    const { scroller } = setup();
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 7, clientY: yAt(0.64) });
    expect(scroller.scrollTop).toBe(1200);
    fireEvent.pointerUp(window, { pointerId: 7, clientY: yAt(0.64) });
    expect(scroller.scrollTop).toBe(1200);
    fireEvent.pointerDown(slider(), { button: 0, pointerId: 8, clientY: yAt(0) });
    fireEvent.pointerMove(window, { pointerId: 99, clientY: yAt(1) }); frame();
    expect(scroller.scrollTop).toBe(0);
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 10, clientY: yAt(1) + 100 }); frame();
    expect(scroller.scrollTop).toBe(MAX);
    expect(bubble().classList.contains("is-shown")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 8, clientY: yAt(1 / 3) });
    expect(scroller.scrollTop).toBe(600);
    expect(bubble().classList.contains("is-shown")).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 8, clientY: yAt(1) }); frame();
    expect(scroller.scrollTop).toBe(600);
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
    const { scroller } = setup();
    act(() => slider().focus());
    expect(bubble().classList.contains("is-shown")).toBe(true);
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
    expect(document.querySelectorAll(".timeline-tick")).toHaveLength(Math.floor((260 - 20 - PAD * 2) / 12) + 1);
    contentHeight = VIEW; act(() => resize?.()); frame();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    contentHeight = CONTENT;
    view.rerender(<I18nProvider><Harness groups={[]} /></I18nProvider>);
    expect(screen.queryByRole("slider")).toBeNull();
    view.rerender(<I18nProvider><Harness groups={stops} /></I18nProvider>);
    expect(screen.getByRole("slider")).toBeTruthy();
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
});
