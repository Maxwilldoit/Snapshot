import { useCallback, useEffect, useRef } from "react";
import { availableMonitors, currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { pickPetBehaviorAction, pickPetEntry, type PetBehavior, type PetBehaviorMove } from "../lib/petBehavior";
import { clampPetX, petFloorY, petHorizontalLimits } from "../lib/petBounds";
import type { MediaBounds } from "../lib/petSize";
import type { WalkDirection } from "../lib/petWalk";

type PlaybackResult = "ended" | "cancelled" | "failed";

export type PetBehaviorAutonomyOptions = {
  behavior: PetBehavior | null;
  enabled: boolean;
  paused: boolean;
  wander: boolean;
  randomActions: boolean;
  current: () => string | null;
  play: (entry: string, facing: WalkDirection, onReady?: (media: HTMLVideoElement) => void) => Promise<PlaybackResult>;
  cancelPlayback: () => void;
  contentBounds?: () => MediaBounds | null;
  groundY?: () => number | null;
  frameShift?: () => { x: number; y: number };
  canvasWidth?: () => number;
};

const FAILURE_BACKOFF_MS = 250;
// A real clip chains immediately. Already-settled promises still yield to input/rendering.
const MIN_SEGMENT_MS = 16;

function validMove(move: PetBehaviorMove) {
  return Boolean(move.entry) && [move.minDistance, move.maxDistance, move.leadMs, move.tailMs].every(Number.isFinite)
    && move.minDistance >= 0 && move.maxDistance >= move.minDistance && move.maxDistance > 0
    && move.leadMs >= 0 && move.tailMs >= 0;
}

/** Profile clips only. cancel stops this run; a gate/profile change starts a fresh run. */
export function usePetBehaviorAutonomy(options: PetBehaviorAutonomyOptions): { cancel: () => void } {
  const latest = useRef(options);
  latest.current = options;
  const stopRun = useRef<(() => void) | null>(null);
  const direction = useRef<{ behavior: PetBehavior | null; facing: WalkDirection }>({ behavior: null, facing: "left" });
  const cancel = useCallback(() => stopRun.current?.(), []);

  useEffect(() => {
    const { behavior, enabled, paused, wander, randomActions } = options;
    if (!behavior || !enabled || paused || (!wander && !randomActions)) return;
    const profile: PetBehavior = behavior;
    if (direction.current.behavior !== profile) direction.current = { behavior: profile, facing: "left" };

    const petWindow = getCurrentWindow();
    let disposed = false;
    let raf: number | undefined;
    let timer: number | undefined;
    let finishWait: (() => void) | undefined;
    let playing = false;
    let abortPending: (() => void) | undefined;
    const alive = () => !disposed && latest.current.behavior === profile && latest.current.enabled
      && !latest.current.paused && latest.current.wander === wander && latest.current.randomActions === randomActions;
    const stopFrames = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
    };
    const stop = () => {
      if (disposed) return;
      disposed = true;
      stopFrames();
      window.clearTimeout(timer);
      finishWait?.();
      finishWait = undefined;
      abortPending?.();
      if (playing) {
        playing = false;
        latest.current.cancelPlayback();
      }
    };
    stopRun.current = stop;

    // One cancellation listener per awaited operation; completed clips must not
    // accumulate handlers on a shared, permanently pending cancellation promise.
    function interruptible<T>(operation: Promise<T>, fallback: T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          if (abortPending === abort) abortPending = undefined;
          settle();
        };
        const abort = () => finish(() => resolve(fallback));
        abortPending = abort;
        operation.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
        if (!alive()) abort();
      });
    }

    const wait = (ms: number) => new Promise<void>((resolve) => {
      if (!alive()) { resolve(); return; }
      finishWait = resolve;
      timer = window.setTimeout(() => {
        timer = undefined;
        finishWait = undefined;
        resolve();
      }, ms);
    });

    async function geometry() {
      const [position, size, scale, monitors, monitor] = await Promise.all([
        petWindow.outerPosition(), petWindow.outerSize(), petWindow.scaleFactor(),
        availableMonitors().catch(() => []), currentMonitor().catch(() => null),
      ]);
      if (!alive()) return null;
      const areas = monitors?.length ? monitors.map((item) => item.workArea) : monitor ? [monitor.workArea] : [];
      const content = latest.current.contentBounds?.() ?? null;
      const limits = petHorizontalLimits(areas, position, size, content, scale);
      if (!limits || limits.minX >= limits.maxX) return null;
      // Native positions are whole physical pixels. Rounding may not cross a fractional DPI limit.
      const pixels = { minX: Math.ceil(limits.minX), maxX: Math.floor(limits.maxX) };
      if (pixels.minX > pixels.maxX) return null;
      const area = monitor?.workArea;
      const floor = area ? petFloorY(area, size.height, content, scale, latest.current.groundY?.() ?? null) : null;
      const y = area && floor !== null
        ? Math.min(floor, Math.max(area.position.y, position.y))
        : position.y;
      const shift = latest.current.frameShift?.() ?? { x: 0, y: 0 };
      return { position: { x: position.x, y }, size, scale, limits, pixels, shift };
    }
    type Geometry = NonNullable<Awaited<ReturnType<typeof geometry>>>;
    type Motion = { move: PetBehaviorMove; distance: number };
    const physicalDistance = (motion: Motion, view: Geometry) => {
      // Tauri's native width is physical; scale to the profile's logical reference, then back to physical.
      const logicalWidth = latest.current.canvasWidth?.() ?? view.size.width / view.scale;
      return motion.distance * (logicalWidth / profile.referenceWidth) * view.scale;
    };
    const targetX = (motion: Motion, view: Geometry, facing: WalkDirection) =>
      view.position.x + (facing === "left" ? -1 : 1) * physicalDistance(motion, view);
    const fits = (motion: Motion, view: Geometry, facing: WalkDirection) => {
      const x = targetX(motion, view, facing);
      return Number.isFinite(x) && clampPetX(view.position.x, view.limits) === view.position.x
        && clampPetX(x, view.limits) === x;
    };

    async function play(entry: string, motion?: Motion): Promise<PlaybackResult> {
      if (!alive()) return "cancelled";
      const facing = direction.current.facing;
      let active = true;
      let ready = false;
      let sample: (() => void) | undefined;
      const valid = () => active && alive();
      const onReady = (media: HTMLVideoElement) => {
        if (!valid() || ready) return;
        ready = true;
        if (!motion) return;
        // onReady means both the foreground video and its native window are in place.
        void geometry().then((view) => {
          if (!valid() || !view || !fits(motion, view, facing)) return;
          const endX = targetX(motion, view, facing);
          let progress = 0;
          let lastX = Math.round(view.position.x);
          let lastY = Math.round(view.position.y);
          let writing = false;
          sample = () => {
            if (!valid() || writing) return;
            const durationMs = media.duration * 1000;
            const timeMs = media.currentTime * 1000;
            const travelMs = durationMs - motion.move.leadMs - motion.move.tailMs;
            if (!Number.isFinite(durationMs) || !Number.isFinite(timeMs) || !(travelMs > 0)) return;
            progress = Math.max(progress, Math.min(1, Math.max(0, (timeMs - motion.move.leadMs) / travelMs)));
            // Lead and tail do not reposition even if window rounding differs from the source position.
            if (progress === 0) return;
            const shift = latest.current.frameShift?.() ?? view.shift;
            const x = clampPetX(Math.round(view.position.x + (endX - view.position.x) * progress), view.pixels) + shift.x - view.shift.x;
            const y = Math.round(view.position.y + shift.y - view.shift.y);
            if (x === lastX && y === lastY) return;
            writing = true;
            lastX = x;
            lastY = y;
            void petWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {}).finally(() => { writing = false; });
          };
          const step = () => {
            if (!valid()) return;
            sample?.();
            if (valid()) raf = requestAnimationFrame(step);
          };
          raf = requestAnimationFrame(step);
        }).catch(() => {});
      };
      playing = true;
      try {
        // The callback and all motion state exist before play: onReady may run synchronously.
        const result = await interruptible(latest.current.play(entry, facing, onReady), "cancelled");
        if (result === "ended" && valid()) sample?.();
        return result;
      } catch {
        return "failed";
      } finally {
        active = false;
        playing = false;
        stopFrames();
      }
    }

    const stationary = () => randomActions
      ? pickPetBehaviorAction(profile, direction.current.facing, latest.current.current())
      : pickPetEntry(profile.idle, latest.current.current());
    async function turn(): Promise<PlaybackResult> {
      const entry = pickPetEntry(profile.turn, latest.current.current());
      if (!entry) return "failed";
      const result = await play(entry);
      if (result === "ended" && alive()) {
        direction.current.facing = direction.current.facing === "left" ? "right" : "left";
      }
      return result;
    }

    async function segment(): Promise<PlaybackResult> {
      const moves = wander && Number.isFinite(profile.referenceWidth) && profile.referenceWidth > 0
        ? profile.moves.filter(validMove) : [];
      const choices = [
        { kind: "idle", weight: profile.weights.idle, allowed: profile.idle.length > 0 },
        { kind: "turn", weight: profile.weights.turn, allowed: randomActions && profile.turn.length > 0 },
        { kind: "move", weight: profile.weights.move, allowed: moves.length > 0 },
        // The action picker falls back to idle when no category supports this facing.
        { kind: "action", weight: profile.weights.action, allowed: randomActions },
      ].filter((choice) => choice.allowed && choice.weight > 0 && Number.isFinite(choice.weight));
      // Normalize first so even very large finite profile weights cannot overflow the sum.
      const maxWeight = Math.max(...choices.map((choice) => choice.weight));
      let roll = Math.random() * choices.reduce((sum, choice) => sum + choice.weight / maxWeight, 0);
      const kind = choices.find((choice) => (roll -= choice.weight / maxWeight) < 0)?.kind;
      if (kind === "turn") return turn();
      if (kind === "move") {
        const move = moves[Math.floor(Math.random() * moves.length)];
        if (!move) return "failed";
        const motion = { move, distance: move.minDistance + Math.random() * (move.maxDistance - move.minDistance) };
        const view = await interruptible(geometry(), null);
        if (!alive()) return "cancelled";
        if (view && fits(motion, view, direction.current.facing)) return play(move.entry, motion);
        const opposite = direction.current.facing === "left" ? "right" : "left";
        if (view && fits(motion, view, opposite)) {
          if (randomActions && profile.turn.length) return turn();
          // Free walking must still leave an edge when random actions are off.
          // Face inward for this move; its lead-in still keeps the position unchanged.
          direction.current.facing = opposite;
          return play(move.entry, motion);
        }
        const entry = stationary();
        return entry ? play(entry) : "failed";
      }
      const entry = kind === "idle" ? pickPetEntry(profile.idle, latest.current.current()) : stationary();
      return entry ? play(entry) : "failed";
    }

    async function loop() {
      while (alive()) {
        const started = performance.now();
        let result: PlaybackResult;
        try { result = await segment(); } catch { result = "failed"; }
        if (!alive() || result === "cancelled") break;
        const delay = result === "failed" ? FAILURE_BACKOFF_MS : MIN_SEGMENT_MS - (performance.now() - started);
        if (delay > 0) await wait(delay);
      }
    }
    void loop();
    return () => {
      stop();
      if (stopRun.current === stop) stopRun.current = null;
    };
  }, [options.behavior, options.enabled, options.paused, options.wander, options.randomActions]);

  return { cancel };
}
