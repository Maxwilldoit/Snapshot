import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { motionReduced } from "../lib/motion";

export type TimelineGroupInput = {
  key: string;
  label: string;
  items: readonly unknown[];
};

export type TimelineNode = {
  groupIndex: number;
  key: string;
  label: string;
  count: number;
  u: number;
  major: boolean;
};

const MIN_TICK_GAP_PX = 7;

function monthKeyOf(dayKey: string): string {
  const ts = Number(dayKey);
  if (!Number.isFinite(ts)) return dayKey;
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

/**
 * 计算每个日期分组在轨道上的归一化位置（0..1），并按像素最小间距稀疏化可见刻度线，
 * 避免历史跨度很长时刻度挤成实心黑条，同时保留月份切换主刻度与首尾节点。
 */
export function buildTimelineTicks(
  groups: ReadonlyArray<TimelineGroupInput>,
  dayTops: readonly number[],
  maxScroll: number,
  trackHeight: number,
): { nodes: TimelineNode[]; visibleTicks: TimelineNode[] } {
  const n = groups.length;
  if (n === 0) return { nodes: [], visibleTicks: [] };

  const firstTop = dayTops[0] ?? 0;
  const rawLastTop = dayTops[n - 1] ?? 0;
  const hasMeasuredSpread = n > 1 && rawLastTop > firstTop;
  const span = hasMeasuredSpread ? Math.max(1, Math.max(maxScroll, rawLastTop) - firstTop) : 1;

  const nodes: TimelineNode[] = groups.map((group, index) => {
    let u = 0;
    if (n > 1) {
      u = hasMeasuredSpread
        ? Math.max(0, Math.min(1, ((dayTops[index] ?? firstTop) - firstTop) / span))
        : index / (n - 1);
    }
    const prevMonth = index > 0 ? monthKeyOf(groups[index - 1].key) : "";
    const major = index === 0 || monthKeyOf(group.key) !== prevMonth;
    return {
      groupIndex: index,
      key: group.key,
      label: group.label,
      count: group.items.length,
      u,
      major,
    };
  });

  if (trackHeight <= 0 || n <= 1) {
    return { nodes, visibleTicks: nodes };
  }

  const height = Math.max(1, trackHeight);
  const kept = new Set<number>([0, n - 1]);
  let lastMajorY = nodes[0].u * height;

  for (let i = 1; i < n - 1; i++) {
    if (!nodes[i].major) continue;
    const y = nodes[i].u * height;
    if (y - lastMajorY >= MIN_TICK_GAP_PX && (nodes[n - 1].u * height) - y >= MIN_TICK_GAP_PX) {
      kept.add(i);
      lastMajorY = y;
    }
  }

  const sortedKept = () => [...kept].sort((a, b) => a - b);
  for (let i = 1; i < n - 1; i++) {
    if (kept.has(i)) continue;
    const y = nodes[i].u * height;
    const neighbors = sortedKept();
    const tooClose = neighbors.some((idx) => Math.abs(nodes[idx].u * height - y) < MIN_TICK_GAP_PX);
    if (!tooClose) kept.add(i);
  }

  const visibleTicks = sortedKept().map((idx) => nodes[idx]);
  return { nodes, visibleTicks };
}

/**
 * 历史页右侧极简时间定位尺：
 * - 平时仅在右缘呈现克制的细短刻度与当前位置胶囊，不占版面、不弹干扰气泡；
 * - 鼠标移入或按住拖拽时刻度微展、浮出毛玻璃日期胶囊，点击直达对应日期，拖拽线性顺滑定位。
 */
export function TimelineScrubber({
  groups,
  scrollRef,
  onInteractChange,
}: {
  groups: ReadonlyArray<TimelineGroupInput>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onInteractChange?: (active: boolean) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const tickRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const dragRef = useRef<{ id: number; startY: number; moved: boolean } | null>(null);

  const [metrics, setMetrics] = useState<{ maxScroll: number; trackHeight: number; dayTops: number[] }>({
    maxScroll: 0,
    trackHeight: 0,
    dayTops: [],
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [hover, setHover] = useState<{ groupIndex: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const scrollable = metrics.maxScroll > 8 && groups.length > 0;

  const { nodes, visibleTicks } = useMemo(
    () => buildTimelineTicks(groups, metrics.dayTops, metrics.maxScroll, metrics.trackHeight),
    [groups, metrics.dayTops, metrics.maxScroll, metrics.trackHeight],
  );

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const visibleTicksRef = useRef(visibleTicks);
  visibleTicksRef.current = visibleTicks;
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const syncScrollVisuals = useCallback(() => {
    const scroller = scrollRef.current;
    const { maxScroll, trackHeight } = metricsRef.current;
    const currentNodes = nodesRef.current;
    if (!scroller || maxScroll <= 0 || currentNodes.length === 0) return;

    const u = Math.max(0, Math.min(1, scroller.scrollTop / maxScroll));
    if (thumbRef.current && trackHeight > 0) {
      const y = Math.round(u * trackHeight);
      thumbRef.current.style.transform = `translate3d(0, ${y}px, 0)`;
    }

    let idx = 0;
    for (let i = 0; i < currentNodes.length; i++) {
      if (currentNodes[i].u <= u + 0.002) idx = i;
      else break;
    }
    setActiveIndex((prev) => (prev === idx ? prev : idx));
  }, [scrollRef]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const sections = [...scroller.querySelectorAll<HTMLElement>("section.day[data-day-key]")];
    const dayTops = sections.map((sec) => sec.offsetTop);
    const trackHeight = trackRef.current?.clientHeight || Math.max(0, scroller.clientHeight - 28);

    setMetrics((prev) => {
      const sameTops = prev.dayTops.length === dayTops.length && prev.dayTops.every((v, i) => v === dayTops[i]);
      if (prev.maxScroll === maxScroll && prev.trackHeight === trackHeight && sameTops) return prev;
      return { maxScroll, trackHeight, dayTops };
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller) return;

    const onScroll = () => syncScrollVisuals();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measure());
      observer.observe(scroller);
      const content = scroller.firstElementChild;
      if (content) observer.observe(content);
    }

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [groups, measure, scrollRef, syncScrollVisuals]);

  useLayoutEffect(() => {
    if (scrollable) {
      measure();
      syncScrollVisuals();
    }
  }, [scrollable, nodes, measure, syncScrollVisuals]);

  const applyTickWave = useCallback((pointerY: number | null) => {
    const reduced = motionReduced();
    const height = metricsRef.current.trackHeight;
    const ticks = visibleTicksRef.current;
    for (let i = 0; i < tickRefs.current.length; i++) {
      const el = tickRefs.current[i];
      const tick = ticks[i];
      if (!el || !tick) continue;
      const base = tick.major ? 8 : 5;
      if (pointerY === null || reduced || height <= 0) {
        el.style.width = `${base}px`;
        continue;
      }
      const dist = Math.abs(tick.u * height - pointerY);
      const boost = dist < 34 ? Math.cos((dist / 34) * (Math.PI / 2)) * 5 : 0;
      el.style.width = `${(base + boost).toFixed(1)}px`;
    }
  }, []);

  const resolveAtClientY = useCallback((clientY: number) => {
    const track = trackRef.current;
    const currentNodes = nodesRef.current;
    const ticks = visibleTicksRef.current;
    if (!track || currentNodes.length === 0) return null;

    const rect = track.getBoundingClientRect();
    const height = Math.max(1, rect.height);
    const y = Math.max(0, Math.min(height, clientY - rect.top));
    const u = y / height;

    // 光标贴近某根可见刻度时优先吸附到该日期，点击更精准
    let snappedIndex: number | null = null;
    let bestDist = 6;
    for (const tick of ticks) {
      const dist = Math.abs(tick.u * height - y);
      if (dist <= bestDist) {
        bestDist = dist;
        snappedIndex = tick.groupIndex;
      }
    }

    if (snappedIndex === null) {
      snappedIndex = 0;
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].u <= u + 0.001) snappedIndex = i;
        else break;
      }
    }

    return { u, y, height, groupIndex: snappedIndex };
  }, []);

  const jumpToGroup = useCallback((groupIndex: number, smooth: boolean) => {
    const scroller = scrollRef.current;
    const group = groups[groupIndex];
    if (!scroller || !group) return;

    const { maxScroll, dayTops } = metricsRef.current;
    let targetTop: number;
    const measuredTop = dayTops[groupIndex];
    if (typeof measuredTop === "number" && (dayTops.length <= 1 || dayTops[dayTops.length - 1] > dayTops[0])) {
      const leadOffset = (dayTops[0] ?? 0) >= 48 ? dayTops[0] : 4;
      targetTop = Math.max(0, Math.min(maxScroll, measuredTop - leadOffset));
    } else {
      const node = nodesRef.current[groupIndex];
      targetTop = Math.round((node?.u ?? 0) * maxScroll);
    }

    if (smooth && !motionReduced() && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: targetTop, behavior: "smooth" });
    } else {
      scroller.scrollTop = targetTop;
    }
    setActiveIndex(groupIndex);
  }, [groups, scrollRef]);

  if (!scrollable) return null;

  const activeGroup = groups[activeIndex] ?? groups[0];
  const hoverNode = hover ? nodes[hover.groupIndex] : null;
  const pillY = hover ? Math.max(0, Math.min(Math.max(0, metrics.trackHeight - 24), hover.y - 12)) : 0;

  return (
    <div
      ref={rootRef}
      className={`timeline-scrubber ${hover || dragging ? "is-active" : ""} ${dragging ? "is-dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label={t("时间定位")}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, groups.length - 1)}
      aria-valuenow={activeIndex}
      aria-valuetext={activeGroup?.label}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        onInteractChange?.(true);
        const hit = resolveAtClientY(event.clientY);
        if (hit) {
          setHover({ groupIndex: hit.groupIndex, y: hit.y });
          applyTickWave(hit.y);
        }
      }}
      onPointerMove={(event) => {
        const hit = resolveAtClientY(event.clientY);
        if (!hit) return;
        setHover({ groupIndex: hit.groupIndex, y: hit.y });
        applyTickWave(hit.y);

        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        if (!drag.moved && Math.abs(event.clientY - drag.startY) >= 3) {
          drag.moved = true;
        }
        if (drag.moved && scrollRef.current) {
          scrollRef.current.scrollTop = Math.round(hit.u * metricsRef.current.maxScroll);
        }
      }}
      onPointerDown={(event) => {
        if (typeof event.button === "number" && event.button !== 0) return;
        event.preventDefault();
        onInteractChange?.(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch { /* JSDOM fallback */ }
        dragRef.current = { id: event.pointerId, startY: event.clientY, moved: false };
        setDragging(true);
        const hit = resolveAtClientY(event.clientY);
        if (hit) {
          setHover({ groupIndex: hit.groupIndex, y: hit.y });
          applyTickWave(hit.y);
        }
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        try {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch { /* JSDOM fallback */ }
        const hit = resolveAtClientY(event.clientY);
        if (!drag.moved && hit) {
          jumpToGroup(hit.groupIndex, true);
        }
      }}
      onPointerCancel={(event) => {
        dragRef.current = null;
        setDragging(false);
        setHover(null);
        applyTickWave(null);
        onInteractChange?.(false);
        try {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch { /* JSDOM fallback */ }
      }}
      onPointerLeave={() => {
        if (dragRef.current) return;
        setHover(null);
        applyTickWave(null);
        onInteractChange?.(false);
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "ArrowDown" || event.key === "PageDown") {
          next = Math.min(groups.length - 1, activeIndex + 1);
        } else if (event.key === "ArrowUp" || event.key === "PageUp") {
          next = Math.max(0, activeIndex - 1);
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = groups.length - 1;
        }
        if (next !== null) {
          event.preventDefault();
          jumpToGroup(next, false);
        }
      }}
    >
      <div className="timeline-track" ref={trackRef}>
        {visibleTicks.map((tick, index) => (
          <span
            key={tick.key}
            ref={(el) => { tickRefs.current[index] = el; }}
            className={`timeline-tick ${tick.major ? "is-major" : ""} ${hoverNode?.groupIndex === tick.groupIndex ? "is-hovered" : ""}`}
            style={{ top: `${(tick.u * 100).toFixed(3)}%` }}
            aria-hidden="true"
          />
        ))}
        <span className="timeline-thumb" ref={thumbRef} aria-hidden="true" />
      </div>

      {hoverNode && (
        <div
          className="timeline-pill"
          style={{ transform: `translate3d(0, ${Math.round(pillY)}px, 0)` }}
          aria-hidden="true"
        >
          <span className="timeline-pill-label">{hoverNode.label}</span>
          <span className="timeline-pill-count mono">{hoverNode.count}</span>
        </div>
      )}
    </div>
  );
}
