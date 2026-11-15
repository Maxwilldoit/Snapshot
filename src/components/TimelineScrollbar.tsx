import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../lib/i18n";
import { nearestTimelineDate, sampleTimeline, timelineDateRatio, timelineScrollPosition, type TimelineStop } from "../lib/timelineScrubber";

const PAD = 14;
const INSET_TOP = 8;
const INSET_BOTTOM = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Geometry = { max: number; height: number; top: number; left: number; offsets: number[] };
type Selection = { index: number; ratio: number };
type PointerSample = { y: number; navigate: boolean };

/** Date navigation owns only its small UI. The complete date index comes from the
 * page; this unvirtualized list's offsets are measured once per layout change. */
export function TimelineScrollbar({ scrollRef, stops }: {
  scrollRef: RefObject<HTMLElement | null>;
  stops: TimelineStop[];
}) {
  const { t, language } = useI18n();
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const pointerId = useRef<number | null>(null);
  const pending = useRef<PointerSample | null>(null);
  const pointerFrame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [current, setCurrent] = useState<Selection>({ index: 0, ratio: 0 });
  const [preview, setPreview] = useState<Selection | null>(null);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [labelSize, setLabelSize] = useState({ width: 180, height: 24 });

  const syncPosition = useCallback(() => {
    const scroller = scrollRef.current;
    const layout = geometryRef.current;
    if (!scroller || !layout) return;
    const next = timelineScrollPosition(stops, layout.offsets, scroller.scrollTop, layout.max);
    setCurrent((old) => old.index === next.index && old.ratio === next.ratio ? old : next);
  }, [scrollRef, stops]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const root = rootRef.current;
    if (!scroller || !root) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    // One DOM pass and one map lookup per day, instead of a nested search.
    const positions = new Map<string, number>();
    for (const node of scroller.querySelectorAll<HTMLElement>("[data-day-key]")) {
      positions.set(node.dataset.dayKey!, Math.max(0, node.getBoundingClientRect().top - base));
    }
    const box = root.getBoundingClientRect();
    const next = {
      max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      height: Math.max(0, root.clientHeight - INSET_TOP - INSET_BOTTOM),
      top: box.top + INSET_TOP,
      left: box.left,
      offsets: stops.map((stop) => positions.get(stop.key) ?? 0),
    };
    const old = geometryRef.current;
    if (!old || old.max !== next.max || old.height !== next.height || old.top !== next.top || old.left !== next.left
      || old.offsets.length !== next.offsets.length || old.offsets.some((value, index) => Math.abs(value - next.offsets[index]) > 0.5)) {
      geometryRef.current = next;
      setGeometry(next);
    }
    syncPosition();
  }, [scrollRef, stops, syncPosition]);

  useLayoutEffect(() => {
    measure();
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(() => { frame = null; measure(); });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const scroller = scrollRef.current;
    if (scroller) {
      observer?.observe(scroller);
      if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    }
    if (rootRef.current) observer?.observe(rootRef.current);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [measure, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const onScroll = () => {
      if (scrollFrame.current === null) scrollFrame.current = window.requestAnimationFrame(() => {
        scrollFrame.current = null;
        syncPosition(); // Ordinary scrolling never opens the bubble.
      });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [scrollRef, syncPosition]);

  const navigate = useCallback((selection: Selection) => {
    const scroller = scrollRef.current;
    const layout = geometryRef.current;
    if (!scroller || !layout) return;
    // A single long day still permits browsing within that day's records.
    scroller.scrollTop = stops.length === 1 ? selection.ratio * layout.max
      : selection.ratio === 0 ? 0 : selection.ratio === 1 ? layout.max
        : Math.min(layout.offsets[selection.index] ?? 0, layout.max);
    syncPosition();
  }, [scrollRef, stops.length, syncPosition]);

  const selectPointer = useCallback(({ y, navigate: shouldNavigate }: PointerSample) => {
    let layout = geometryRef.current;
    const root = rootRef.current;
    if (!layout || !root || !stops.length) return;
    // The page's entrance transition can move the hit area without a resize.
    // Read only this small anchor once per frame; the date list stays cached.
    const box = root.getBoundingClientRect();
    if (layout.top !== box.top + INSET_TOP || layout.left !== box.left) {
      layout = { ...layout, top: box.top + INSET_TOP, left: box.left };
      geometryRef.current = layout;
      setGeometry(layout);
    }
    const pad = Math.min(PAD, layout.height / 2);
    const span = layout.height - pad * 2;
    const ratio = span > 0 ? clamp((y - layout.top - pad) / span, 0, 1) : 0;
    const selection = { ratio, index: nearestTimelineDate(stops, ratio) };
    setPreview(selection);
    if (shouldNavigate) navigate(selection);
  }, [stops, navigate]);

  const queuePointer = useCallback((sample: PointerSample) => {
    pending.current = sample;
    if (pointerFrame.current === null) pointerFrame.current = window.requestAnimationFrame(() => {
      pointerFrame.current = null;
      if (pending.current) selectPointer(pending.current);
      pending.current = null;
    });
  }, [selectPointer]);

  useEffect(() => {
    const cancelFrame = () => {
      if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = null;
      pending.current = null;
    };
    const cancel = () => {
      cancelFrame();
      pointerId.current = null;
      setDragging(false);
      setHovering(false);
      setFocused(false);
      setPreview(null);
    };
    const move = (event: globalThis.PointerEvent) => {
      if (pointerId.current === event.pointerId) queuePointer({ y: event.clientY, navigate: true });
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (pointerId.current !== event.pointerId) return;
      // Commit the final sample even when up arrives before the next frame.
      cancelFrame();
      selectPointer({ y: event.clientY, navigate: true });
      pointerId.current = null;
      setDragging(false);
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (pointerId.current === event.pointerId) cancel();
    };
    cancel(); // A changed date index cancels any gesture using the old index.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", cancel);
    return () => {
      cancelFrame();
      pointerId.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", cancel);
    };
  }, [queuePointer, selectPointer]);

  const ready = !!geometry && geometry.max > 0 && geometry.height > PAD * 2 && stops.length > 0;
  const engaged = ready && (hovering || dragging || focused);
  const selected = (hovering || dragging) && preview ? preview : current;
  const index = Math.min(selected.index, Math.max(0, stops.length - 1));
  const formatter = useMemo(() => new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    year: "numeric", month: language === "en" ? "short" : "long", day: "numeric",
  }), [language]);
  const date = stops[index] ? formatter.format(stops[index].timestamp) : "";
  const currentDate = stops[current.index] ? formatter.format(stops[current.index].timestamp) : "";
  const pad = Math.min(PAD, (geometry?.height ?? 0) / 2);
  const span = Math.max(0, (geometry?.height ?? 0) - pad * 2);
  const ticks = useMemo(() => sampleTimeline(stops, span), [stops, span]);
  const activeTick = Math.round((engaged ? selected.ratio : current.ratio) * (ticks.length - 1));

  useLayoutEffect(() => {
    if (!ready || !labelRef.current) return;
    const { width, height } = labelRef.current.getBoundingClientRect();
    setLabelSize((old) => old.width === width && old.height === height ? old : { width, height });
  }, [date, ready]);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!ready || event.button !== 0 || pointerId.current !== null) return;
    event.preventDefault(); // Mouse navigation must not leave a sticky keyboard focus.
    setFocused(false);
    pointerId.current = event.pointerId;
    setDragging(true);
    setHovering(true);
    selectPointer({ y: event.clientY, navigate: true });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!ready || !geometry) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": case "ArrowRight": next = Math.min(stops.length - 1, current.index + 1); break;
      case "ArrowUp": case "ArrowLeft": next = Math.max(0, current.index - 1); break;
      case "Home": next = 0; break;
      case "End": next = stops.length - 1; break;
      case "PageDown": case "PageUp": {
        const scroller = scrollRef.current;
        if (scroller) scroller.scrollTop = clamp(scroller.scrollTop + (event.key === "PageDown" ? 1 : -1) * scroller.clientHeight, 0, geometry.max);
        syncPosition();
        event.preventDefault();
        setFocused(true);
        return;
      }
      default: return;
    }
    event.preventDefault();
    setFocused(true);
    setHovering(false);
    setPreview(null);
    const ratio = event.key === "End" ? 1 : event.key === "Home" ? 0
      : stops.length === 1 ? clamp(current.ratio + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 0.1 : -0.1), 0, 1)
        : timelineDateRatio(stops, stops[next].timestamp);
    navigate({ index: next, ratio });
  }

  return (
    <div
      ref={rootRef}
      className={`timeline-scrollbar ${ready ? "is-interactive" : ""} ${engaged ? "is-engaged" : ""} ${dragging ? "is-dragging" : ""}`}
      aria-hidden={!ready}
      onPointerEnter={(event) => { setHovering(true); queuePointer({ y: event.clientY, navigate: false }); }}
      onPointerMove={(event) => { if (pointerId.current === null) queuePointer({ y: event.clientY, navigate: false }); }}
      onPointerLeave={() => {
        setHovering(false);
        if (pointerId.current === null) {
          if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
          pointerFrame.current = null;
          pending.current = null;
          setPreview(null);
        }
      }}
    >
      <div
        className="timeline-track"
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label={t("历史时间线")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(current.ratio * 100)}
        aria-valuetext={t("{date}，{percent}%", { date: currentDate, percent: Math.round(current.ratio * 100) })}
        aria-describedby={engaged ? tooltipId : undefined}
        onPointerDown={pointerDown}
        onKeyDown={keyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {ready && ticks.map((tick, tickIndex) => {
          const distance = Math.abs(tickIndex - activeTick);
          return <span
            key={tickIndex}
            aria-hidden="true"
            className={`timeline-tick ${tick.major ? "is-major" : ""} ${distance === 0 ? "is-current" : ""} ${engaged && distance <= 2 ? `is-near-${distance}` : ""}`}
            style={{ top: Math.round(pad + tick.ratio * span) }}
          />;
        })}
      </div>
      {ready && geometry && createPortal(
        <div
          ref={labelRef}
          id={tooltipId}
          role="tooltip"
          aria-hidden={!engaged}
          className={`timeline-label ${engaged ? "is-shown" : ""}`}
          style={{
            left: clamp(geometry.left - labelSize.width - 6, 8, Math.max(8, window.innerWidth - labelSize.width - 8)),
            top: clamp(geometry.top + pad + selected.ratio * span, 8 + labelSize.height / 2, Math.max(8 + labelSize.height / 2, window.innerHeight - 8 - labelSize.height / 2)),
          }}
        >{date}</div>, document.body,
      )}
    </div>
  );
}
