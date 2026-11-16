import { useCallback, useLayoutEffect, useRef } from "react";
import { timelineTickFocus } from "../lib/timelineScrubber";

/** Paint the wave at exactly the live scroll position, like a native scrollbar.
 * No tween: slow scrolling never trails the content and fast scrolling shows
 * every intermediate position the scroll itself passes through. */
export function useTimelineWave(ratio: number, span: number, ticks: number[]) {
  const element = useRef<HTMLSpanElement>(null);
  const layout = useRef({ span, ticks });
  const value = useRef(ratio);
  const painted = useRef<{ value: number; span: number; ticks: number[] } | null>(null);

  const paint = useCallback((value: number) => {
    const { span: travel, ticks: positions } = layout.current;
    const last = painted.current;
    // Only ticks inside the wave's reach change; the rest stay untouched so a
    // scroll frame writes a handful of styles instead of the whole axis.
    const reach = positions.length > 1 ? 3 * (travel / (positions.length - 1)) / Math.max(travel, 1) : Infinity;
    const from = last && last.span === travel && last.ticks === positions ? Math.min(last.value, value) - reach : -Infinity;
    const to = last && last.span === travel && last.ticks === positions ? Math.max(last.value, value) + reach : Infinity;
    const spacing = positions.length > 1 ? travel / (positions.length - 1) : 12;
    const nodes = element.current?.children;
    positions.forEach((position, index) => {
      if (position < from || position > to) return;
      const node = nodes?.[index] as HTMLElement | undefined;
      if (!node) return;
      const focus = timelineTickFocus(Math.abs(position - value) * travel / spacing);
      const width = `${focus.width}px`;
      const background = `color-mix(in srgb, var(--accent) ${focus.accent * 100}%, color-mix(in srgb, var(--text1) 22%, transparent))`;
      if (node.style.width !== width) node.style.width = width;
      if (node.style.background !== background) node.style.background = background;
    });
    painted.current = { value, span: travel, ticks: positions };
  }, []);

  const ref = useCallback((node: HTMLSpanElement | null) => {
    element.current = node;
    painted.current = null;
    // Restoring the same date index may remount ticks without changing geometry.
    if (node) paint(value.current);
  }, [paint]);

  const follow = useCallback((target: number) => {
    if (painted.current?.value === target && painted.current.span === layout.current.span && painted.current.ticks === layout.current.ticks) return;
    value.current = target;
    paint(target);
  }, [paint]);

  useLayoutEffect(() => {
    layout.current = { span, ticks };
    follow(ratio);
  }, [ratio, span, ticks, follow]);

  return { ref, follow };
}
