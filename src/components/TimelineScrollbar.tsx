import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTimelineWave } from "../hooks/useTimelineWave";
import { useI18n } from "../lib/i18n";
import { sampleTimeline, timelineAdjacentOffset, timelineScrollPosition, timelineTrackSpan, type TimelineStop } from "../lib/timelineScrubber";

const PAD = 14;
const INSET_TOP = 8;
const INSET_BOTTOM = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Geometry = { max: number; height: number; span: number; top: number; left: number; offsets: number[] };
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
  const scrollWave = useRef<((ratio: number) => void) | null>(null);
  const pointerId = useRef<number | null>(null);
  const pending = useRef<PointerSample | null>(null);
  const pointerFrame = useRef<number | null>(null);
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
    // Paint live scroll samples without waiting for React's next commit.
    scrollWave.current?.(next.ratio);
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
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const available = Math.max(0, root.clientHeight - INSET_TOP - INSET_BOTTOM);
    const span = timelineTrackSpan(available - PAD * 2, max);
    const next = {
      max,
      height: available,
      span,
      top: box.top + INSET_TOP,
      left: box.left,
      // The newest day starts at the scroll origin, including gallery padding.
      offsets: stops.map((stop, index) => index === 0 ? 0 : positions.get(stop.key) ?? 0),
    };
    const old = geometryRef.current;
    if (!old || old.max !== next.max || old.height !== next.height || old.span !== next.span || old.top !== next.top || old.left !== next.left
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
    // Native scroll events already arrive with the rendering cycle. Deferring
    // their position to another frame makes the wave trail the content.
    const onScroll = () => syncPosition(); // Never opens the bubble.
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, syncPosition]);

  const navigate = useCallback((ratio: number) => {
    const scroller = scrollRef.current;
    const layout = geometryRef.current;
    if (!scroller || !layout) return;
    // The same continuous mapping drives scrolling, clicking and dragging.
    scroller.scrollTop = ratio * layout.max;
    syncPosition();
  }, [scrollRef, syncPosition]);

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
    const span = layout.span;
    const ratio = span > 0 ? clamp((y - layout.top - pad) / span, 0, 1) : 0;
    const selection = timelineScrollPosition(stops, layout.offsets, ratio * layout.max, layout.max);
    setPreview(selection);
    if (shouldNavigate) navigate(ratio);
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

  const ready = !!geometry && geometry.max > 0 && geometry.span > 0 && stops.length > 0;
  const engaged = ready && (hovering || dragging || focused);
  const selected = (hovering || dragging) && preview ? preview : current;
  const index = Math.min(selected.index, Math.max(0, stops.length - 1));
  const currentYear = new Date().getFullYear();
  const format = useMemo(() => {
    const locale = language === "en" ? "en-US" : "zh-CN";
    const month = language === "en" ? "short" : "long";
    const withYear = new Intl.DateTimeFormat(locale, { year: "numeric", month, day: "numeric" });
    const withoutYear = new Intl.DateTimeFormat(locale, { month, day: "numeric" });
    return (timestamp: number) => (new Date(timestamp).getFullYear() === currentYear ? withoutYear : withYear).format(timestamp);
  }, [language, currentYear]);
  const date = stops[index] ? format(stops[index].timestamp) : "";
  const currentDate = stops[current.index] ? format(stops[current.index].timestamp) : "";
  const pad = Math.min(PAD, (geometry?.height ?? 0) / 2);
  const span = geometry?.span ?? 0;
  const ticks = useMemo(() => sampleTimeline(span), [span]);
  const wave = useTimelineWave(selected.ratio, span, ticks);
  useLayoutEffect(() => {
    scrollWave.current = (hovering || dragging) && preview ? null : wave.follow;
    return () => { scrollWave.current = null; };
  }, [hovering, dragging, preview, wave.follow]);

  useLayoutEffect(() => {
    if (!ready || !engaged || !labelRef.current) return;
    const { width, height } = labelRef.current.getBoundingClientRect();
    setLabelSize((old) => old.width === width && old.height === height ? old : { width, height });
  }, [date, ready, engaged]);

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
    const scroller = scrollRef.current;
    if (!ready || !geometry || !scroller) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": case "ArrowRight":
      case "ArrowUp": case "ArrowLeft": {
        const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        next = stops.length === 1 ? clamp(scroller.scrollTop + direction * geometry.max * 0.1, 0, geometry.max)
          : timelineAdjacentOffset(geometry.offsets, scroller.scrollTop, geometry.max, direction);
        break;
      }
      case "Home": next = 0; break;
      case "End": next = geometry.max; break;
      case "PageDown": case "PageUp":
        next = clamp(scroller.scrollTop + (event.key === "PageDown" ? 1 : -1) * scroller.clientHeight, 0, geometry.max); break;
      default: return;
    }
    event.preventDefault();
    setFocused(true);
    setHovering(false);
    setPreview(null);
    navigate(next / geometry.max);
  }

  return (
    <div
      ref={rootRef}
      className={`timeline-scrollbar ${ready ? "is-interactive" : ""} ${engaged ? "is-engaged" : ""} ${dragging ? "is-dragging" : ""}`}
      aria-hidden={!ready}
      onPointerEnter={(event) => { setHovering(true); queuePointer({ y: event.clientY, navigate: false }); }}
      onPointerMove={(event) => {
        if (pointerId.current === null) {
          setHovering(true);
          queuePointer({ y: event.clientY, navigate: false });
        }
      }}
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
        style={{ height: geometry?.height }}
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
        {ready && <span ref={wave.ref} aria-hidden="true" className="timeline-ticks">{ticks.map((ratio, tickIndex) => (
          <span
            key={tickIndex}
            aria-hidden="true"
            className="timeline-tick"
            style={{ top: pad + ratio * span }}
          />
        ))}</span>}
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
