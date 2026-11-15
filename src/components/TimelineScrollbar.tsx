import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useI18n, type Language } from "../lib/i18n";

/** 滚动停止后多久淡出悬浮日期气泡；刻度尺本身常驻页面右缘，悬停、聚焦、拖动期间气泡不淡出。 */
const HIDE_DELAY = 1200;
/** 刻度线在轨道上下内缩留白，保证首尾文字不贴边裁切。 */
const RULER_PAD = 14;
/** 刻度文字之间最少保留的垂直间距（px），避免密集时文字叠在一起。 */
const MIN_LABEL_GAP = 22;
/** 悬浮日期气泡离轨道上下边至少留这么多。 */
const LABEL_EDGE = 22;
/** 背景细刻度线间距（px），让整条侧栏读起来像连续刻度尺。 */
const GRADUATION_STEP = 10;
/** 区分「点击刻度跳转」与「按住刻度开始拖拽」的垂直位移阈值（px）。 */
const DRAG_THRESHOLD = 3;
/** 轨道相对滚动区上下各留的空白，与 CSS 的 .timeline-track top / bottom 一致。 */
const TRACK_INSET_TOP = 8;
const TRACK_INSET_BOTTOM = 12;

export type TimelineStop = { key: string; label: string; timestamp?: number };

type Geometry = {
  maxScroll: number;
  trackHeight: number;
  /** 每个日期分组在滚动内容里的顶边位置 */
  offsets: number[];
};

type PointerSession =
  | {
      mode: "pending-stop";
      pointerId: number;
      startY: number;
      trackTop: number;
      trackHeight: number;
      maxScroll: number;
      stopIndex: number;
    }
  | {
      mode: "scrub";
      pointerId: number;
      trackTop: number;
      trackHeight: number;
      maxScroll: number;
    };

type RulerNode = {
  index: number;
  periodKey: string;
  rulerLabel: string;
  isMajor: boolean;
  isYearBoundary: boolean;
  showLabel: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function rulerSpan(trackHeight: number) {
  return Math.max(0, trackHeight - RULER_PAD * 2);
}

/** 滚动位置 → 刻度尺轨道 Y（含上下内缩 RULER_PAD）。 */
function scrollToY(scroll: number, maxScroll: number, trackHeight: number) {
  const pad = Math.min(RULER_PAD, trackHeight / 2);
  const span = Math.max(0, trackHeight - pad * 2);
  return maxScroll > 0 ? pad + (clamp(scroll, 0, maxScroll) / maxScroll) * span : pad;
}

/** 刻度尺轨道 Y → 滚动位置。 */
function yToScroll(y: number, trackHeight: number, maxScroll: number) {
  const pad = Math.min(RULER_PAD, trackHeight / 2);
  const span = Math.max(0, trackHeight - pad * 2);
  return span > 0 ? (clamp(y - pad, 0, span) / span) * maxScroll : 0;
}

/** 当前日期 = 最后一个顶边已经滚过视口顶边的分组（与吸顶的日期条一致）。 */
function activeIndex(offsets: number[], top: number) {
  let current = 0;
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index] > top + 1) break;
    current = index;
  }
  return current;
}

function formatMonthLabel(date: Date, includeYear: boolean, language: Language) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (language === "en") {
    return date.toLocaleDateString("en-US", includeYear ? { month: "short", year: "numeric" } : { month: "short" });
  }
  return includeYear ? `${year}年${month}月` : `${month}月`;
}

function formatCompactDayLabel(date: Date, stopLabel: string, language: Language) {
  if (stopLabel === "今天" || stopLabel === "昨天" || stopLabel === "Today" || stopLabel === "Yesterday") {
    return stopLabel;
  }
  if (language === "en") return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 把每日分组整理成侧边刻度尺节点：
 * - 跨月 / 跨年时以「年份/月份」作为主节点，方便直接跳到对应年月；
 * - 都在同一个月内时以简洁日期作主节点，避免只剩单个孤立刻度；
 * - 传入节点未带时间戳（如精简单测）时退回原始标签。
 */
function buildRulerNodes(
  stops: TimelineStop[],
  offsets: number[],
  maxScroll: number,
  trackHeight: number,
  language: Language,
): RulerNode[] {
  if (stops.length === 0) return [];
  const hasTimestamps = stops.every((stop) => typeof stop.timestamp === "number");
  let base: Omit<RulerNode, "showLabel">[];

  if (!hasTimestamps) {
    base = stops.map((stop, index) => ({
      index,
      periodKey: stop.key,
      rulerLabel: stop.label,
      isMajor: true,
      isYearBoundary: index === 0,
    }));
  } else {
    const periods = stops.map((stop) => {
      const date = new Date(stop.timestamp!);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      return { date, year, monthKey: `${year}-${String(month).padStart(2, "0")}` };
    });
    const distinctMonths = new Set(periods.map((item) => item.monthKey));
    if (distinctMonths.size > 1) {
      let prevMonthKey: string | null = null;
      let prevMajorYear: number | null = null;
      base = stops.map((stop, index) => {
        const { date, year, monthKey } = periods[index];
        const isFirstOfMonth = monthKey !== prevMonthKey;
        const isYearBoundary = isFirstOfMonth && (prevMajorYear === null || prevMajorYear !== year);
        if (isFirstOfMonth) {
          prevMonthKey = monthKey;
          prevMajorYear = year;
        }
        return {
          index,
          periodKey: monthKey,
          rulerLabel: isFirstOfMonth ? formatMonthLabel(date, isYearBoundary, language) : stop.label,
          isMajor: isFirstOfMonth,
          isYearBoundary,
        };
      });
    } else {
      base = stops.map((stop, index) => ({
        index,
        periodKey: stop.key,
        rulerLabel: formatCompactDayLabel(periods[index].date, stop.label, language),
        isMajor: true,
        isYearBoundary: index === 0,
      }));
    }
  }

  // 防碰撞：优先保留年份节点与首节点，再依次放入不重叠的月/日节点文字；其余节点仍保留刻度线可点可拖。
  const ys = base.map((node) => scrollToY(offsets[node.index] ?? 0, maxScroll, trackHeight));
  const placedYs: number[] = [];
  const shown = new Set<number>();

  const tryPlace = (index: number) => {
    const y = ys[index];
    if (placedYs.some((other) => Math.abs(other - y) < MIN_LABEL_GAP)) return;
    placedYs.push(y);
    shown.add(index);
  };

  base.forEach((node) => {
    if (node.isMajor && node.isYearBoundary) tryPlace(node.index);
  });
  base.forEach((node) => {
    if (node.isMajor && !node.isYearBoundary) tryPlace(node.index);
  });

  return base.map((node) => ({ ...node, showLabel: shown.has(node.index) }));
}

/** 生成背景等距细刻度 Y 坐标，避开真实数据刻度以免视觉重叠。 */
function buildGraduationMarks(trackHeight: number, stopYs: number[]): number[] {
  const pad = Math.min(RULER_PAD, trackHeight / 2);
  const span = rulerSpan(trackHeight);
  if (span <= 0) return [];
  const marks: number[] = [];
  for (let y = pad; y <= trackHeight - pad + 0.5; y += GRADUATION_STEP) {
    if (stopYs.some((stopY) => Math.abs(stopY - y) < 4)) continue;
    marks.push(Math.round(y));
  }
  return marks;
}

/**
 * 历史页的侧边刻度尺 / 时间轴滚动条。
 * 常驻显示在内容右缘：沿着页面边缘排布时间刻度与年份/月份节点，滚动时高亮当前对应节点，
 * 点击任意刻度节点、拖曳游标或在刻度尺上直接滑动都能快速跳转到对应年份/月份或日期。
 * 不拥有滚动状态，只读写滚动容器的 scrollTop，触控板 / 滚轮 / 键盘原生滚动照常工作。
 */
export function TimelineScrollbar({
  scrollRef,
  stops,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  stops: TimelineStop[];
}) {
  const { t, language } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PointerSession | null>(null);
  const suppressClickRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [popVisible, setPopVisible] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverStop, setHoverStop] = useState<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setPopVisible(false), HIDE_DELAY);
  }, [clearHideTimer]);

  const revealPopover = useCallback(() => {
    setPopVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  /** 量一次：分组顶边、可滚动距离、轨道高度。分组位置随排版变化，由 ResizeObserver 触发重测。 */
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const root = rootRef.current;
    if (!scroller || !root) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const nodes = scroller.querySelectorAll<HTMLElement>("[data-day-key]");
    const offsets = stops.map((stop) => {
      const node = [...nodes].find((item) => item.dataset.dayKey === stop.key);
      return node ? Math.max(0, node.getBoundingClientRect().top - base) : 0;
    });
    offsetsRef.current = offsets;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const trackHeight = Math.max(0, root.clientHeight - TRACK_INSET_TOP - TRACK_INSET_BOTTOM);
    const next = { maxScroll, trackHeight, offsets };
    const previous = geometryRef.current;
    if (
      previous && previous.maxScroll === maxScroll && previous.trackHeight === trackHeight
      && previous.offsets.length === offsets.length
      && previous.offsets.every((value, index) => Math.abs(value - offsets[index]) < 0.5)
    ) return;
    geometryRef.current = next;
    setGeometry(next);
  }, [scrollRef, stops]);

  /** 滚动位置变了：只更新位置，几何沿用最近一次测量。 */
  const syncPosition = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller) setScrollTop(scroller.scrollTop);
  }, [scrollRef]);

  useLayoutEffect(() => {
    measure();
    syncPosition();
  }, [measure, syncPosition]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { measure(); syncPosition(); });
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [measure, syncPosition, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        syncPosition();
        revealPopover();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
      clearHideTimer();
    };
  }, [scrollRef, syncPosition, revealPopover, clearHideTimer]);

  useEffect(() => {
    if (hovering || focused || dragging) {
      clearHideTimer();
      setPopVisible(true);
    } else scheduleHide();
  }, [hovering, focused, dragging, clearHideTimer, scheduleHide]);

  const scrollTo = useCallback((top: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = top;
    // jsdom 没有布局，赋值 scrollTop 不派发 scroll；主动同步一次。
    syncPosition();
    revealPopover();
  }, [scrollRef, syncPosition, revealPopover]);

  // 拖动期间指针可能滑出刻度尺（去够日期气泡那一侧），用 window 级监听保证拖拽不断。
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      const scroller = scrollRef.current;
      if (!session || !scroller || session.pointerId !== event.pointerId) return;
      if (session.mode === "pending-stop") {
        if (Math.abs(event.clientY - session.startY) <= DRAG_THRESHOLD) return;
        sessionRef.current = {
          mode: "scrub",
          pointerId: session.pointerId,
          trackTop: session.trackTop,
          trackHeight: session.trackHeight,
          maxScroll: session.maxScroll,
        };
        suppressClickRef.current = true;
        thumbRef.current?.focus({ preventScroll: true });
        setDragging(true);
      }
      const top = trackRef.current?.getBoundingClientRect().top ?? session.trackTop;
      const nextScroll = yToScroll(event.clientY - top, session.trackHeight, session.maxScroll);
      scroller.scrollTop = nextScroll;
      syncPosition();
      revealPopover();
    };
    const finish = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (session.mode === "scrub") {
        // 如果是在刻度按钮上起拖，松手后屏蔽随后派发的 click，防止跳回起点刻度。
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
      sessionRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [scrollRef, syncPosition, revealPopover]);

  const active = activeIndex(geometry?.offsets ?? offsetsRef.current, scrollTop);
  const overflow = (geometry?.maxScroll ?? 0) > 0;
  const ready = geometry !== null && overflow && stops.length > 0;
  const popoverShown = ready && (popVisible || hovering || focused || dragging);

  const cursorY = geometry ? scrollToY(scrollTop, geometry.maxScroll, geometry.trackHeight) : 0;
  const stopTop = useCallback((index: number) => (
    geometry ? scrollToY(geometry.offsets[index] ?? 0, geometry.maxScroll, geometry.trackHeight) : 0
  ), [geometry]);

  const rulerNodes = useMemo(
    () => (geometry ? buildRulerNodes(stops, geometry.offsets, geometry.maxScroll, geometry.trackHeight, language) : []),
    [stops, geometry, language],
  );
  const stopYs = useMemo(() => rulerNodes.map((node) => stopTop(node.index)), [rulerNodes, stopTop]);
  const graduations = useMemo(
    () => (geometry ? buildGraduationMarks(geometry.trackHeight, stopYs) : []),
    [geometry, stopYs],
  );
  const activePeriodKey = rulerNodes[active]?.periodKey;

  function startScrub(event: PointerEvent<HTMLElement>, immediateScroll?: number) {
    if (!geometry || !overflow || event.button !== 0) return;
    const trackBox = trackRef.current?.getBoundingClientRect();
    if (!trackBox) return;
    event.preventDefault();
    suppressClickRef.current = false;
    thumbRef.current?.focus({ preventScroll: true });
    if (typeof immediateScroll === "number") scrollTo(immediateScroll);
    sessionRef.current = {
      mode: "scrub",
      pointerId: event.pointerId,
      trackTop: trackBox.top,
      trackHeight: geometry.trackHeight,
      maxScroll: geometry.maxScroll,
    };
    setDragging(true);
  }

  function onThumbPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    startScrub(event);
  }

  function onTrackPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!geometry || !overflow || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-stop], [role=slider]")) return;
    const box = event.currentTarget.getBoundingClientRect();
    startScrub(event, yToScroll(event.clientY - box.top, geometry.trackHeight, geometry.maxScroll));
  }

  function onStopPointerDown(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (!geometry || !overflow || event.button !== 0) return;
    const trackBox = trackRef.current?.getBoundingClientRect();
    if (!trackBox) return;
    suppressClickRef.current = false;
    sessionRef.current = {
      mode: "pending-stop",
      pointerId: event.pointerId,
      startY: event.clientY,
      trackTop: trackBox.top,
      trackHeight: geometry.trackHeight,
      maxScroll: geometry.maxScroll,
      stopIndex: index,
    };
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!geometry || !overflow) return;
    const scroller = scrollRef.current;
    const view = scroller?.clientHeight || 400;
    const step = Math.max(40, view * 0.25);
    const page = Math.max(step, view - 40);
    const top = scroller?.scrollTop ?? scrollTop;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = top + step; break;
      case "ArrowUp": next = top - step; break;
      case "PageDown": next = top + page; break;
      case "PageUp": next = top - page; break;
      case "Home": next = 0; break;
      case "End": next = geometry.maxScroll; break;
      case "ArrowRight": next = geometry.offsets[Math.min(active + 1, geometry.offsets.length - 1)] ?? top; break;
      case "ArrowLeft": next = geometry.offsets[Math.max(active - 1, 0)] ?? top; break;
      default: return;
    }
    event.preventDefault();
    scrollTo(clamp(next, 0, geometry.maxScroll));
  }

  const percent = geometry && geometry.maxScroll > 0 ? Math.round((clamp(scrollTop, 0, geometry.maxScroll) / geometry.maxScroll) * 100) : 0;
  const label = stops[active]?.label ?? "";
  const preview = hoverStop !== null && hoverStop !== active ? stops[hoverStop] : undefined;
  const labelTop = geometry ? clamp(
    TRACK_INSET_TOP + (preview ? stopTop(hoverStop!) : cursorY),
    LABEL_EDGE,
    Math.max(LABEL_EDGE, geometry.trackHeight + TRACK_INSET_TOP - LABEL_EDGE),
  ) : 0;

  return (
    <div
      ref={rootRef}
      className={`timeline-scrollbar ${ready ? "is-visible is-interactive" : ""} ${popoverShown ? "is-popover" : ""} ${dragging ? "is-dragging" : ""}`}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => { setHovering(false); setHoverStop(null); }}
      aria-hidden={!ready}
    >
      {ready && geometry && (
        <>
          <div className="timeline-track" ref={trackRef} onPointerDown={onTrackPointerDown}>
            <div className="timeline-rail" aria-hidden="true" />
            {graduations.map((y) => (
              <span key={y} className="timeline-graduation" style={{ top: y }} aria-hidden="true" />
            ))}
            {rulerNodes.map((node) => {
              const stop = stops[node.index];
              const top = stopYs[node.index];
              const isStopActive = node.index === active;
              const isPeriodActive = node.periodKey === activePeriodKey && (node.isMajor || isStopActive);
              return (
                <button
                  key={stop.key}
                  type="button"
                  tabIndex={-1}
                  className={`timeline-stop ${node.isMajor ? "is-major" : ""} ${node.showLabel ? "has-label" : ""} ${isStopActive ? "is-active-stop" : ""} ${isPeriodActive ? "is-active" : ""}`}
                  style={{ top }}
                  data-stop={stop.key}
                  aria-label={t("跳到 {date}", { date: stop.label })}
                  title={stop.label}
                  onPointerEnter={() => setHoverStop(node.index)}
                  onPointerLeave={() => setHoverStop(null)}
                  onPointerDown={(event) => onStopPointerDown(node.index, event)}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    scrollTo(Math.min(geometry.offsets[node.index] ?? 0, geometry.maxScroll));
                  }}
                >
                  {node.showLabel && <span className="timeline-stop-text">{node.rulerLabel}</span>}
                  <span className="timeline-stop-tick" aria-hidden="true" />
                </button>
              );
            })}
            <div
              ref={thumbRef}
              role="slider"
              tabIndex={0}
              className="timeline-thumb"
              aria-label={t("历史时间线")}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={t("{date}，{percent}%", { date: label, percent })}
              style={{ top: cursorY }}
              onPointerDown={onThumbPointerDown}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </div>
          <div
            className={`timeline-label ${popoverShown ? "is-shown" : ""} ${preview ? "is-preview" : ""}`}
            style={{ top: labelTop }}
            aria-hidden="true"
          >
            {preview ? preview.label : label}
          </div>
        </>
      )}
    </div>
  );
}
