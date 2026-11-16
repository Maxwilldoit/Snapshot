import { useCallback, useLayoutEffect, useRef } from "react";
import { timelineTickFocus } from "../lib/timelineScrubber";

/** Paint the wave at exactly the live scroll position, like a native scrollbar.
 * No tween: slow scrolling never trails the content and fast scrolling shows
 * every intermediate position the scroll itself passes through. */
export function useTimelineWave(ratio: number, span: number, ticks: number[]) {
  const element = useRef<HTMLSpanElement>(null);
  const layout = useRef({ span, ticks });
  const value = useRef(ratio);

  const paint = useCallback((value: number) => {
    const { span: travel, ticks: positions } = layout.current;
    const spacing = positions.length > 1 ? travel / (positions.length - 1) : 12;
    const nodes = element.current?.children;
    positions.forEach((position, index) => {
      const node = nodes?.[index] as HTMLElement | undefined;
      if (!node) return;
      const focus = timelineTickFocus(Math.abs(position - value) * travel / spacing);
      node.style.width = `${focus.width}px`;
      node.style.background = `color-mix(in srgb, var(--accent) ${focus.accent * 100}%, color-mix(in srgb, var(--text1) 22%, transparent))`;
    });
  }, []);

  const ref = useCallback((node: HTMLSpanElement | null) => {
    element.current = node;
    // Restoring the same date index may remount ticks without changing geometry.
    if (node) paint(value.current);
  }, [paint]);

  const follow = useCallback((target: number) => {
    value.current = target;
    paint(target);
  }, [paint]);

  useLayoutEffect(() => {
    layout.current = { span, ticks };
    follow(ratio);
  }, [ratio, span, ticks, follow]);

  return { ref, follow };
}
