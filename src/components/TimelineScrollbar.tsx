import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useI18n } from "../lib/i18n";

/** 滚动停止后多久淡出；悬停、聚焦、拖动期间不淡出。 */
const HIDE_DELAY = 1200;
/** 滑块最短长度：内容再长也抓得住。 */
const THUMB_MIN = 36;
/** 日期标签离轨道上下边至少留这么多。 */
const LABEL_EDGE = 22;
/** 轨道相对滚动区上下各留的空白，与 CSS 的 .timeline-track top / bottom 一致。 */
const TRACK_INSET_TOP = 8;
const TRACK_INSET_BOTTOM = 12;

export type TimelineStop = { key: string; label: string };

type Geometry = {
  maxScroll: number;
  trackHeight: number;
  thumbHeight: number;
  /** 每个日期分组在滚动内容里的顶边位置 */
  offsets: number[];
};

type Drag = { pointerId: number; startY: number; startTop: number; travel: number; maxScroll: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 滑块顶边 → 滚动位置：滑块在轨道里可走的距离对应整段可滚动距离。 */
function topToScroll(top: number, travel: number, maxScroll: number) {
  return travel > 0 ? (clamp(top, 0, travel) / travel) * maxScroll : 0;
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

/**
 * 历史页的时间线滚动条。
 * 滚动时浮现在右缘：轨道上的刻度是日期分组，按内容里的真实位置排布；蓝色滑块按可见比例占位，
 * 旁边的标签跟着滑块显示当前日期。拖滑块、点轨道、点日期刻度、键盘方向键都能定位；停下后淡出。
 * 不拥有滚动状态，只读写滚动容器的 scrollTop，触控板 / 滚轮 / 键盘原生滚动照常工作。
 */
export function TimelineScrollbar({
  scrollRef,
  stops,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  stops: TimelineStop[];
}) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const hideTimer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  /** 最近一次量到的几何，供滚动 / 拖动回调直接读，不依赖 React 何时提交状态。 */
  const geometryRef = useRef<Geometry | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [visible, setVisible] = useState(false);
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
    hideTimer.current = window.setTimeout(() => setVisible(false), HIDE_DELAY);
  }, [clearHideTimer]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  /** 量一次：分组顶边、可滚动距离、轨道高度。分组位置随排版变化，由 ResizeObserver 触发重量。 */
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
    // 轨道上下留白固定（见 CSS），从常驻的根节点量，首帧还没有轨道也能算出几何。
    const trackHeight = Math.max(0, root.clientHeight - TRACK_INSET_TOP - TRACK_INSET_BOTTOM);
    const thumbHeight = maxScroll > 0 && scroller.scrollHeight > 0
      ? clamp((scroller.clientHeight / scroller.scrollHeight) * trackHeight, Math.min(THUMB_MIN, trackHeight), trackHeight)
      : trackHeight;
    const next = { maxScroll, trackHeight, thumbHeight, offsets };
    const previous = geometryRef.current;
    if (
      previous && previous.maxScroll === maxScroll && previous.trackHeight === trackHeight
      && previous.thumbHeight === thumbHeight && previous.offsets.length === offsets.length
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

  // 分组变化（筛选、删除、新截图）后分组位置要重量；此时轨道可能刚挂上。
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
        reveal();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
      clearHideTimer();
    };
  }, [scrollRef, syncPosition, reveal, clearHideTimer]);

  useEffect(() => {
    if (hovering || focused || dragging) {
      clearHideTimer();
      setVisible(true);
    } else scheduleHide();
  }, [hovering, focused, dragging, clearHideTimer, scheduleHide]);

  const scrollTo = (top: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = top;
    // jsdom 没有布局，赋值 scrollTop 不派发 scroll；主动同步一次。
    syncPosition();
    reveal();
  };

  // 拖动期间指针可能滑出窄轨道（去够日期标签那一侧），用 window 级监听保证拖动不断。
  useEffect(() => {
    if (!dragging) return;
    const move = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      const scroller = scrollRef.current;
      if (!drag || !scroller || drag.pointerId !== event.pointerId) return;
      scroller.scrollTop = topToScroll(drag.startTop + event.clientY - drag.startY, drag.travel, drag.maxScroll);
      syncPosition();
      reveal();
    };
    const finish = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
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
  }, [dragging, scrollRef, syncPosition, reveal]);

  const active = activeIndex(geometry?.offsets ?? offsetsRef.current, scrollTop);
  const overflow = (geometry?.maxScroll ?? 0) > 0;
  const ready = geometry !== null && overflow && stops.length > 0;
  // 没有可滚内容（筛选无结果、空历史）时立即收起，不等淡出计时器。
  const shown = ready && (visible || hovering || focused || dragging);
  const travel = geometry ? geometry.trackHeight - geometry.thumbHeight : 0;
  const thumbTop = geometry && geometry.maxScroll > 0 ? (clamp(scrollTop, 0, geometry.maxScroll) / geometry.maxScroll) * travel : 0;
  /** 日期刻度在轨道上的位置：按内容顶边映射到滑块可走范围，与滑块同一坐标系。 */
  const stopTop = (index: number) => geometry && geometry.maxScroll > 0
    ? (clamp(geometry.offsets[index] ?? 0, 0, geometry.maxScroll) / geometry.maxScroll) * travel
    : 0;

  function beginDrag(event: PointerEvent<HTMLElement>, startTop: number) {
    if (!geometry) return;
    thumbRef.current?.focus({ preventScroll: true });
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startTop, travel, maxScroll: geometry.maxScroll };
    setDragging(true);
  }

  function onThumbPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!geometry || !overflow || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginDrag(event, thumbTop);
  }

  function onTrackPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!geometry || !overflow || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-stop], [role=slider]")) return;
    const box = event.currentTarget.getBoundingClientRect();
    // 点空白轨道：滑块中心落到指针处，并立即进入拖动，按住可以继续拖。
    const top = clamp(event.clientY - box.top - geometry.thumbHeight / 2, 0, travel);
    scrollTo(topToScroll(top, travel, geometry.maxScroll));
    beginDrag(event, top);
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
  // 标签跟着滑块走；悬停某个刻度时改为预览那一天的日期，并停在刻度旁。
  const labelTop = geometry ? clamp(
    TRACK_INSET_TOP + (preview ? stopTop(hoverStop!) + geometry.thumbHeight / 2 : thumbTop + geometry.thumbHeight / 2),
    LABEL_EDGE,
    Math.max(LABEL_EDGE, geometry.trackHeight + TRACK_INSET_TOP - LABEL_EDGE),
  ) : 0;

  return (
    <div
      ref={rootRef}
      className={`timeline-scrollbar ${shown ? "is-visible" : ""} ${ready ? "is-interactive" : ""} ${dragging ? "is-dragging" : ""}`}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => { setHovering(false); setHoverStop(null); }}
      aria-hidden={!shown}
    >
      {ready && geometry && (
        <>
          <div className="timeline-track" ref={trackRef} onPointerDown={onTrackPointerDown}>
            <div className="timeline-rail" aria-hidden="true" />
            {stops.map((stop, index) => {
              const top = stopTop(index);
              // 刻度落在滑块下面就让位，避免灰点压在蓝色滑块上。
              const under = top >= thumbTop - 4 && top <= thumbTop + geometry.thumbHeight + 4;
              return (
                <button
                  key={stop.key}
                  type="button"
                  tabIndex={-1}
                  className={`timeline-stop ${index === active ? "is-active" : ""} ${under ? "is-under-thumb" : ""}`}
                  style={{ top }}
                  data-stop={stop.key}
                  aria-label={t("跳到 {date}", { date: stop.label })}
                  title={stop.label}
                  onPointerEnter={() => setHoverStop(index)}
                  onPointerLeave={() => setHoverStop(null)}
                  onClick={() => scrollTo(Math.min(geometry.offsets[index] ?? 0, geometry.maxScroll))}
                >
                  <span className="timeline-stop-dot" aria-hidden="true" />
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
              style={{ top: thumbTop, height: geometry.thumbHeight }}
              onPointerDown={onThumbPointerDown}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </div>
          <div
            className={`timeline-label ${preview ? "is-preview" : ""}`}
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
