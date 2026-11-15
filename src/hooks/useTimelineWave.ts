import { useCallback, useLayoutEffect, useRef } from "react";
import { motionReduced } from "../lib/motion";
import { timelineTickFocus } from "../lib/timelineScrubber";

const TRAVEL_MS = 90;

/** Animate one wave position, rather than restarting a transition on every tick.
 * Small scroll samples are painted immediately; a large jump crosses the axis
 * in a short, interruptible motion with a deadline that new samples cannot delay. */
export function useTimelineWave(ratio: number, span: number, ticks: number[]) {
  const element = useRef<HTMLSpanElement>(null);
  const layout = useRef({ span, ticks });
  const reduced = useRef(false);
  const motion = useRef({ value: ratio, target: ratio, from: ratio, start: 0, end: 0, frame: null as number | null });

  const paint = useCallback((value: number) => {
    motion.current.value = value;
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
    if (node) paint(motion.current.value);
  }, [paint]);

  const cancel = useCallback(() => {
    if (motion.current.frame !== null) window.cancelAnimationFrame(motion.current.frame);
    motion.current.frame = null;
  }, []);

  const step = useCallback(function advance(now: number) {
    const state = motion.current;
    state.frame = null;
    const progress = Math.min(1, Math.max(0, (now - state.start) / (state.end - state.start)));
    paint(state.from + (state.target - state.from) * (1 - (1 - progress) ** 3));
    if (progress < 1) state.frame = window.requestAnimationFrame(advance);
    else paint(state.target);
  }, [paint]);

  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => {
      reduced.current = motionReduced() || !!media?.matches;
      if (reduced.current) {
        cancel();
        paint(motion.current.target);
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    media?.addEventListener("change", update);
    update();
    return () => {
      cancel();
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, [cancel, paint]);

  useLayoutEffect(() => {
    const state = motion.current;
    if (layout.current.span !== span || layout.current.ticks !== ticks) {
      cancel();
      layout.current = { span, ticks };
      state.target = ratio;
      paint(ratio);
    }
  }, [ratio, span, ticks, cancel, paint]);

  const follow = useCallback((target: number) => {
    const state = motion.current;
    const { span: travel, ticks: positions } = layout.current;
    if (state.target === target) {
      if (state.frame === null) paint(target);
      return;
    }
    const oldTarget = state.target;
    state.target = target;
    const spacing = positions.length > 1 ? travel / (positions.length - 1) : 12;
    if (reduced.current || Math.abs(target - state.value) * travel <= spacing) {
      cancel();
      paint(target);
      return;
    }
    const now = performance.now();
    const continuing = state.frame !== null && state.end > now
      && Math.sign(oldTarget - state.from) === Math.sign(target - state.value);
    state.from = state.value;
    state.start = now;
    if (!continuing) state.end = now + TRAVEL_MS;
    if (state.frame === null) state.frame = window.requestAnimationFrame(step);
  }, [cancel, paint, step]);

  useLayoutEffect(() => follow(ratio), [ratio, span, ticks, follow]);

  return { ref, follow };
}
