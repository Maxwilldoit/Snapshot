import { useCallback, useEffect, useRef } from "react";
import { availableMonitors, currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { pickPetBehaviorAction, pickPetEntry, type PetBehavior, type PetBehaviorMove } from "../lib/petBehavior";
import { clampPetX, clampPetY, petFloorY, petHorizontalLimits, petVerticalLimits } from "../lib/petBounds";
import type { MediaBounds } from "../lib/petSize";
import { pickWanderVector, type PetFacing } from "../lib/petWalk";

type PlaybackResult = "ended" | "cancelled" | "failed";

export type PetBehaviorAutonomyOptions = {
  behavior: PetBehavior | null;
  enabled: boolean;
  paused: boolean;
  wander: boolean;
  gravity?: boolean;
  randomActions: boolean;
  current: () => string | null;
  play: (entry: string, facing: PetFacing, onReady?: (media: HTMLVideoElement) => void) => Promise<PlaybackResult>;
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
  const direction = useRef<{ behavior: PetBehavior | null; facing: PetFacing }>({ behavior: null, facing: "left" });
  const restBeforeRoll = useRef(false);
  const cancel = useCallback(() => stopRun.current?.(), []);

  useEffect(() => {
    const { behavior, enabled, paused, wander, randomActions } = options;
    const gravity = options.gravity ?? true;
    if (!behavior || !enabled || (!wander && !randomActions)) {
      restBeforeRoll.current = false;
      return;
    }
    const profile: PetBehavior = behavior;
    if (direction.current.behavior !== profile) {
      direction.current = { behavior: profile, facing: "left" };
      restBeforeRoll.current = false;
    }
    if (paused) {
      restBeforeRoll.current = true;
      return;
    }

    const petWindow = getCurrentWindow();
    let disposed = false;
    let raf: number | undefined;
    let timer: number | undefined;
    let finishWait: (() => void) | undefined;
    let playing = false;
    let abortPending: (() => void) | undefined;
    const alive = () => !disposed && latest.current.behavior === profile && latest.current.enabled
      && !latest.current.paused && latest.current.wander === wander
      && (latest.current.gravity ?? true) === gravity && latest.current.randomActions === randomActions;
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
      const ground = latest.current.groundY?.() ?? null;
      const limits = petHorizontalLimits(areas, position, size, content, scale);
      const area = monitor?.workArea;
      const vLimits = area ? petVerticalLimits(area, size.height, content, scale, ground) : null;
      const pixels = limits && Math.ceil(limits.minX) <= Math.floor(limits.maxX)
        ? { minX: Math.ceil(limits.minX), maxX: Math.floor(limits.maxX) }
        : null;
      const vPixels = vLimits && Math.ceil(vLimits.minY) <= Math.floor(vLimits.maxY)
        ? { minY: Math.ceil(vLimits.minY), maxY: Math.floor(vLimits.maxY) }
        : null;
      if (gravity) {
        if (!limits || limits.minX >= limits.maxX || !pixels) return null;
      } else if (!pixels && !vPixels) {
        return null;
      }
      const floor = area ? petFloorY(area, size.height, content, scale, ground) : null;
      const y = !gravity && vLimits
        ? clampPetY(position.y, vLimits)
        : area && floor !== null
          ? Math.min(floor, Math.max(area.position.y, position.y))
          : position.y;
      const shift = latest.current.frameShift?.() ?? { x: 0, y: 0 };
      return { position: { x: position.x, y }, size, scale, limits, pixels, vLimits, vPixels, shift };
    }
    type Geometry = NonNullable<Awaited<ReturnType<typeof geometry>>>;
    type Motion = { move: PetBehaviorMove; distance: number; ux?: number; uy?: number };
    const unitScale = (view: Geometry) => {
      // Tauri's native width is physical; scale to the profile's logical reference, then back to physical.
      const logicalWidth = latest.current.canvasWidth?.() ?? view.size.width / view.scale;
      return (logicalWidth / profile.referenceWidth) * view.scale;
    };
    const physicalDistance = (motion: Motion, view: Geometry) => motion.distance * unitScale(view);
    const targetX = (motion: Motion, view: Geometry, facing: PetFacing) => {
      const ux = motion.ux ?? (facing === "left" ? -1 : 1);
      return view.position.x + ux * physicalDistance(motion, view);
    };
    const targetY = (motion: Motion, view: Geometry) =>
      view.position.y + (motion.uy ?? 0) * physicalDistance(motion, view);
    const fits = (motion: Motion, view: Geometry, facing: PetFacing) => {
      const x = targetX(motion, view, facing);
      const y = targetY(motion, view);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (motion.ux === undefined && motion.uy === undefined) {
        return Boolean(view.limits && view.pixels)
          && clampPetX(view.position.x, view.limits) === view.position.x
          && clampPetX(x, view.limits) === x;
      }
      const okX = Math.abs(motion.ux ?? 0) <= 1e-4 || (
        Boolean(view.limits && view.pixels)
        && clampPetX(view.position.x, view.limits) === view.position.x
        && clampPetX(x, view.limits) === x
      );
      const okY = Math.abs(motion.uy ?? 0) <= 1e-4 || (
        Boolean(view.vLimits && view.vPixels)
        && clampPetY(view.position.y, view.vLimits) === view.position.y
        && clampPetY(y, view.vLimits) === y
      );
      return okX && okY;
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
          const endY = targetY(motion, view);
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
            const rawX = Math.round(view.position.x + (endX - view.position.x) * progress);
            const rawY = Math.round(view.position.y + (endY - view.position.y) * progress);
            const x = clampPetX(rawX, view.pixels) + shift.x - view.shift.x;
            const y = (motion.uy !== undefined ? clampPetY(rawY, view.vPixels) : rawY) + shift.y - view.shift.y;
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

    const canRest = profile.idle.length > 0 && profile.weights.idle > 0 && Number.isFinite(profile.weights.idle);
    let mustRest = canRest && restBeforeRoll.current;
    restBeforeRoll.current = false;

    async function playStationaryWithRest(): Promise<PlaybackResult> {
      const entry = stationary();
      if (!entry) return "failed";
      const result = await play(entry);
      if (result === "ended" && canRest && !profile.idle.includes(entry)) {
        mustRest = true;
      }
      return result;
    }

    async function segment(): Promise<PlaybackResult> {
      if (mustRest) {
        mustRest = false;
        const rest = pickPetEntry(profile.idle, latest.current.current());
        return rest ? play(rest) : "failed";
      }
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
        if (!gravity) {
          const view = await interruptible(geometry(), null);
          if (!alive()) return "cancelled";
          const canX = Boolean(view?.limits && view.pixels && view.limits.minX < view.limits.maxX
            && clampPetX(view.position.x, view.limits) === view.position.x);
          const canY = Boolean(view?.vLimits && view.vPixels && view.vLimits.minY < view.vLimits.maxY
            && clampPetY(view.position.y, view.vLimits) === view.position.y);
          if (!view || (!canX && !canY)) return playStationaryWithRest();
          let { ux, uy } = pickWanderVector(canX, canY);
          const floatMoves = Math.abs(uy) > Math.abs(ux)
            ? moves.filter((item) => /漂浮|float|fly|swim|游|飞/i.test(item.entry))
            : [];
          const pool = floatMoves.length ? floatMoves : moves;
          const move = pool[Math.floor(Math.random() * pool.length)];
          if (!move) return "failed";
          const scalePx = unitScale(view);
          if (!(scalePx > 0)) return playStationaryWithRest();
          const rawDistance = move.minDistance + Math.random() * (move.maxDistance - move.minDistance);
          const wantPx = rawDistance * scalePx;
          if (canX && view.limits && Math.abs(ux) > 1e-4) {
            const roomForward = ux < 0 ? view.position.x - view.limits.minX : view.limits.maxX - view.position.x;
            const roomReverse = ux < 0 ? view.limits.maxX - view.position.x : view.position.x - view.limits.minX;
            if (roomForward < wantPx && roomReverse > roomForward) ux = -ux;
          }
          if (canY && view.vLimits && Math.abs(uy) > 1e-4) {
            const roomForward = uy < 0 ? view.position.y - view.vLimits.minY : view.vLimits.maxY - view.position.y;
            const roomReverse = uy < 0 ? view.vLimits.maxY - view.position.y : view.position.y - view.vLimits.minY;
            if (roomForward < wantPx && roomReverse > roomForward) uy = -uy;
          }
          let maxPx = Infinity;
          if (ux < -1e-4 && view.limits) maxPx = Math.min(maxPx, (view.position.x - view.limits.minX) / -ux);
          else if (ux > 1e-4 && view.limits) maxPx = Math.min(maxPx, (view.limits.maxX - view.position.x) / ux);
          if (uy < -1e-4 && view.vLimits) maxPx = Math.min(maxPx, (view.position.y - view.vLimits.minY) / -uy);
          else if (uy > 1e-4 && view.vLimits) maxPx = Math.min(maxPx, (view.vLimits.maxY - view.position.y) / uy);
          const minRequiredPx = Math.min(move.minDistance * scalePx, 24 * view.scale);
          if (!(maxPx >= minRequiredPx) || !(maxPx > 1)) return playStationaryWithRest();
          const distance = Math.min(rawDistance, maxPx / scalePx);
          const desiredFacing: PetFacing = Math.abs(ux) > 1e-4 ? (ux < 0 ? "left" : "right") : direction.current.facing;
          if (desiredFacing !== direction.current.facing) {
            if (randomActions && profile.turn.length) return turn();
            direction.current.facing = desiredFacing;
          }
          return play(move.entry, { move, distance, ux, uy });
        }

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
        return playStationaryWithRest();
      }
      if (kind === "idle") {
        const entry = pickPetEntry(profile.idle, latest.current.current());
        return entry ? play(entry) : "failed";
      }
      return playStationaryWithRest();
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
  }, [options.behavior, options.enabled, options.paused, options.wander, options.gravity, options.randomActions]);

  return { cancel };
}
