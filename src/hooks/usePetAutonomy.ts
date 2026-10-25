import { useCallback, useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import type { WalkDirection } from "../lib/petWalk";

export const PET_AUTONOMY = {
  idleMs: [2500, 7000] as const,
  walkMs: [2000, 6000] as const,
  walkSpeed: 68,
};

type AutonomyOptions = {
  enabled: boolean;
  wander: boolean;
  randomActions: boolean;
  canWalk: boolean;
  actions: string[];
  paused: boolean;
  setWalking: (direction: WalkDirection | null) => void;
  onAction: (entry: string | null) => void;
  actionDuration: (entry: string) => Promise<number>;
};

function randomBetween([min, max]: readonly [number, number]) {
  return min + Math.random() * (max - min);
}

/**
 * Idle-only companion behaviour. It never emits pet-animation, so autonomous
 * movement and actions stay local to the floating desktop window.
 */
export function usePetAutonomy(options: AutonomyOptions) {
  const [generation, setGeneration] = useState(0);
  const runToken = useRef(0);
  const latest = useRef(options);
  latest.current = options;

  const cancel = useCallback(() => {
    runToken.current += 1;
    latest.current.setWalking(null);
    latest.current.onAction(null);
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const { enabled, wander, randomActions, canWalk, actions, paused, setWalking, onAction } = options;
    if (!enabled || paused || (!wander && !randomActions) || (!canWalk && actions.length === 0)) {
      setWalking(null);
      return;
    }

    const token = runToken.current;
    const petWindow = getCurrentWindow();
    let disposed = false;
    let timer: number | undefined;
    let raf = 0;
    let finishTimer: (() => void) | undefined;
    let finishWalk: (() => void) | undefined;
    let autoWalking: WalkDirection | null = null;
    let autoAction: string | null = null;
    const alive = () => !disposed && runToken.current === token;

    const wait = (ms: number) => new Promise<void>((resolve) => {
      finishTimer = resolve;
      timer = window.setTimeout(() => {
        finishTimer = undefined;
        resolve();
      }, ms);
    });

    async function walk() {
      const [monitor, position, size, scale] = await Promise.all([
        currentMonitor(),
        petWindow.outerPosition(),
        petWindow.outerSize(),
        petWindow.scaleFactor(),
      ]);
      if (!alive() || !monitor || !(scale > 0)) return;
      const { position: origin, size: area } = monitor.workArea;
      const minX = origin.x;
      const maxX = origin.x + area.width - size.width;
      const floor = origin.y + area.height - size.height;
      if (minX > maxX) return;
      let x = Math.max(minX, Math.min(maxX, position.x));
      const y = Math.max(origin.y, Math.min(floor, position.y));
      const margin = Math.min(120 * scale, (maxX - minX) / 4);
      let direction: WalkDirection = Math.random() < 0.5 ? "left" : "right";
      if (position.x - minX < margin) direction = "right";
      else if (maxX - position.x < margin) direction = "left";
      const finishAt = performance.now() + randomBetween(PET_AUTONOMY.walkMs);
      let previous = performance.now();
      autoWalking = direction;
      setWalking(direction);

      await new Promise<void>((resolve) => {
        finishWalk = resolve;
        const step = (now: number) => {
          if (!alive() || now >= finishAt) {
            resolve();
            return;
          }
          const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
          previous = now;
          x += (direction === "left" ? -1 : 1) * PET_AUTONOMY.walkSpeed * scale * dt;
          if (x <= minX) {
            x = minX;
            direction = "right";
            autoWalking = direction;
            setWalking(direction);
          } else if (x >= maxX) {
            x = maxX;
            direction = "left";
            autoWalking = direction;
            setWalking(direction);
          }
          void petWindow
            .setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
            .catch(() => {});
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      });
      if (autoWalking) {
        autoWalking = null;
        setWalking(null);
      }
    }

    async function playAction(entry: string) {
      autoAction = entry;
      onAction(entry);
      const duration = await latest.current.actionDuration(entry);
      if (!alive() || autoAction !== entry) return;
      await wait(duration);
      if (autoAction === entry) {
        autoAction = null;
        onAction(null);
      }
    }

    async function loop() {
      while (alive()) {
        await wait(randomBetween(PET_AUTONOMY.idleMs));
        if (!alive()) break;

        const choices: Array<{ kind: "idle" | "walk" | "action"; weight: number }> = [
          { kind: "idle", weight: 3 },
        ];
        if (wander && canWalk) choices.push({ kind: "walk", weight: 4 });
        if (randomActions && actions.length > 0) choices.push({ kind: "action", weight: 3 });
        let roll = Math.random() * choices.reduce((sum, choice) => sum + choice.weight, 0);
        let picked = choices[choices.length - 1].kind;
        for (const choice of choices) {
          roll -= choice.weight;
          if (roll < 0) {
            picked = choice.kind;
            break;
          }
        }

        if (picked === "walk") await walk();
        else if (picked === "action") await playAction(actions[Math.floor(Math.random() * actions.length)]);
      }
    }

    void loop();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      finishTimer?.();
      finishWalk?.();
      if (autoWalking) setWalking(null);
      if (autoAction) onAction(null);
    };
  }, [generation, options.enabled, options.paused, options.wander, options.randomActions, options.canWalk, options.actions.join("\0"), options.setWalking]);

  return { cancel };
}
