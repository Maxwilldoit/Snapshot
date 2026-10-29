import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, type Window } from "@tauri-apps/api/window";
import { AppWindow, PawPrint } from "lucide-react";
import {
  getPreviousApp,
  getRecordingStatus,
  loadSettings,
  onPetEvent,
  onPreviousAppChanged,
  onRecordingChanged,
  onSettingsChanged,
  setPetFrameShift,
  showLaunchpad,
  showQuickMenu,
} from "../lib/backend";
import { iconUrl } from "../lib/media";
import { MediaImage } from "../components/MediaImage";
import { PetMedia } from "../components/PetMedia";
import { petImageFrame, usePetImages } from "../hooks/usePetImages";
import { broadcastPetAnimation, onPetAnimationAsked } from "../lib/petSync";
import { placementForEntry, type PetPlacement } from "../lib/petFrame";
import { PET_SCALE, petWindowSize } from "../lib/petSize";
import { nextDragWalk, pickWalk, STANDING, type DragWalk, type WalkDirection } from "../lib/petWalk";
import { clickableAnimations, ordinaryAnimations } from "../lib/petActions";
import { useI18n, useWindowTitle } from "../lib/i18n";
import { motionReduced } from "../lib/motion";
import { usePetAutonomy } from "../hooks/usePetAutonomy";
import { petActionDuration } from "../lib/petAnimation";
import type { PetAsset, PetEvent, PetLayout, PreviousApp, RecordingStatus, Settings } from "../types";

/** 放大后超出了所在屏幕的可用区域，就挪回来 */
async function keepOnScreen(petWindow: Window) {
  const monitor = await currentMonitor();
  if (!monitor) return;
  const [position, size] = await Promise.all([petWindow.outerPosition(), petWindow.outerSize()]);
  const { position: origin, size: area } = monitor.workArea;
  const x = Math.max(origin.x, Math.min(position.x, origin.x + area.width - size.width));
  const y = Math.max(origin.y, Math.min(position.y, origin.y + area.height - size.height));
  if (x !== position.x || y !== position.y) await petWindow.setPosition(new PhysicalPosition(x, y));
}

/** 平时那个方窗要落在工作区内。返回物理像素的挪动量，脚跟着方窗一起挪 */
async function nudgeNormalWindow(normalX: number, normalY: number, side: number, factor: number) {
  const monitor = await currentMonitor();
  if (!monitor || !(factor > 0)) return { x: 0, y: 0 };
  const extent = Math.round(side * factor);
  const { position: origin, size: area } = monitor.workArea;
  const x = Math.max(origin.x, Math.min(normalX, origin.x + area.width - extent));
  const y = Math.max(origin.y, Math.min(normalY, origin.y + area.height - extent));
  return { x: x - normalX, y: y - normalY };
}

/** 没长出方窗时和老路径用同一个键，拖动换走路动作不会把窗口重摆一遍 */
function windowKey(side: number, place: PetPlacement | null) {
  if (!place || (place.shiftX === 0 && place.shiftY === 0 && place.width === side && place.height === side)) {
    return `square|${side}`;
  }
  return `grow|${side}|${place.width}x${place.height}@${place.shiftX},${place.shiftY}`;
}

async function commitPetWindow(
  petWindow: Window,
  side: number,
  place: PetPlacement | null,
  shiftRef: { current: { x: number; y: number } },
  translate: (source: string) => string,
) {
  const grows =
    place != null && !(place.shiftX === 0 && place.shiftY === 0 && place.width === side && place.height === side);
  if (!place || !grows) {
    if (shiftRef.current.x !== 0 || shiftRef.current.y !== 0) {
      const pos = await petWindow.outerPosition();
      const nextX = pos.x - shiftRef.current.x;
      const nextY = pos.y - shiftRef.current.y;
      shiftRef.current = { x: 0, y: 0 };
      await setPetFrameShift(0, 0);
      if (Number.isFinite(nextX) && Number.isFinite(nextY)) {
        await petWindow.setPosition(new PhysicalPosition(nextX, nextY));
      }
    }
    await petWindow.setSize(new LogicalSize(side, side));
    await keepOnScreen(petWindow);
    return;
  }

  const factor = await petWindow.scaleFactor();
  const pos = await petWindow.outerPosition();
  if (!(factor > 0) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    throw new Error(translate("读不到桌宠窗口的位置"));
  }
  const shiftX = Math.round(place.shiftX * factor);
  const shiftY = Math.round(place.shiftY * factor);
  const normalX = pos.x - shiftRef.current.x;
  const normalY = pos.y - shiftRef.current.y;
  const nudge = await nudgeNormalWindow(normalX, normalY, side, factor);
  const nextX = Math.round(normalX + nudge.x + shiftX);
  const nextY = Math.round(normalY + nudge.y + shiftY);
  shiftRef.current = { x: shiftX, y: shiftY };
  await setPetFrameShift(shiftX, shiftY);
  if (nextX !== pos.x || nextY !== pos.y) await petWindow.setPosition(new PhysicalPosition(nextX, nextY));
  await petWindow.setSize(new LogicalSize(place.width, place.height));
}

/** 等这么久还没来第二下，才算单击。第二下是双击，打开启动台，不换动作 */
export const CLICK_DELAY_MS = 400;

type DragGeometry = {
  position: { x: number; y: number };
  scale: number;
  /** 窗口左上角的物理像素上限；再往下就会碰到任务栏或屏幕工作区边缘。 */
  floorY: number | null;
};

async function readDragGeometry(petWindow: Window): Promise<DragGeometry | null> {
  const [position, size, scale, monitor] = await Promise.all([
    petWindow.outerPosition(),
    petWindow.outerSize(),
    petWindow.scaleFactor(),
    currentMonitor(),
  ]);
  if (!(scale > 0) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const floorY = monitor
    ? monitor.workArea.position.y + monitor.workArea.size.height - size.height
    : null;
  return { position, scale, floorY };
}

export function PetWindow() {
  const { t } = useI18n();
  useWindowTitle(t("桌宠"));
  const [app, setApp] = useState<PreviousApp>({ id: null, pid: null, name: "", title: "" });
  const [appearanceId, setAppearanceId] = useState("app-icon");
  const [animations, setAnimations] = useState<string[]>([]);
  const [layout, setLayout] = useState<PetLayout | null>(null);
  const [eventActions, setEventActions] = useState<PetAsset["eventActions"]>({});
  const [stateActions, setStateActions] = useState<PetAsset["stateActions"]>({});
  const [restingEntry, setRestingEntry] = useState<string | null>(null);
  const [shownEntry, setShownEntry] = useState<string | null>(null);
  const [eventEntry, setEventEntry] = useState<string | null>(null);
  // 每次换动作都给 img 新 key，让 GIF 从首帧播放一轮，而不是接着隐藏时的进度。
  const [actionPulse, setActionPulse] = useState(0);
  const [recording, setRecording] = useState(false);
  const [shortcutsPaused, setShortcutsPaused] = useState(false);
  const [petSize, setPetSize] = useState(80);
  // 读到设置前不定大小，免得先按默认缩放一次再跳到用户设的大小
  const [petScale, setPetScale] = useState<number | null>(null);
  const [petWander, setPetWander] = useState(false);
  const [petRandomActions, setPetRandomActions] = useState(false);
  const [petGravity, setPetGravity] = useState(true);
  const [walking, setWalking] = useState<WalkDirection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [falling, setFalling] = useState(false);
  const [manualAction, setManualAction] = useState(false);
  const dragged = useRef(false);
  // 点过之后下一次从这里接着换，回到待机也不清掉，免得每次点击都是同一个动作
  const actionCursor = useRef(0);
  const returnTimer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const eventTimer = useRef<number | undefined>(undefined);
  const restingRef = useRef<string | null>(null);
  const targetEntry = useRef<string | null>(null);
  const autoAction = useRef<string | null>(null);
  const appearanceKey = useRef("");
  const latestAsset = useRef<PetAsset | null>(null);
  const gravityEnabled = useRef(true);
  gravityEnabled.current = petGravity;
  const dragMotion = useRef<DragWalk>(STANDING);
  const finishDrag = useRef<() => void>(() => {});
  const gravityToken = useRef(0);
  const gravityFrame = useRef(0);

  // 点击切换只在常规动作里转，走路动作留给拖动
  const regularAnimations = ordinaryAnimations({ animations, eventActions, stateActions });
  const cycle = clickableAnimations({ animations, eventActions, stateActions });
  const resting = restingEntry && cycle.includes(restingEntry) ? restingEntry : (cycle[0] ?? null);
  restingRef.current = resting;

  function requestEntry(entry: string | null) {
    if (entry === targetEntry.current) return;
    targetEntry.current = entry;
    if (entry && entry !== restingRef.current) void petActionDuration(appearanceId, entry);
    setActionPulse((value) => value + 1);
    setShownEntry(entry);
  }

  function showManualEntry(entry: string | null) {
    autoAction.current = null;
    requestEntry(entry);
  }

  function showAutoEntry(entry: string | null) {
    if (entry) {
      autoAction.current = entry;
      requestEntry(entry);
    } else if (autoAction.current && targetEntry.current === autoAction.current) {
      autoAction.current = null;
      requestEntry(null);
    }
  }

  useEffect(
    () => () => {
      window.clearTimeout(returnTimer.current);
      window.clearTimeout(clickTimer.current);
      window.clearTimeout(eventTimer.current);
    },
    [],
  );

  useEffect(() => {
    const applyAppearance = (settings: Settings) => {
      const id = settings.selectedAppearanceId;
      const asset = settings.petAssets.find((item) => item.id === id);
      const key = JSON.stringify([id, asset?.path, asset?.entry, asset?.animations, asset?.layout, asset?.eventActions, asset?.stateActions]);
      if (appearanceKey.current !== key) {
        appearanceKey.current = key;
        window.clearTimeout(returnTimer.current);
        window.clearTimeout(clickTimer.current);
        window.clearTimeout(eventTimer.current);
        clickTimer.current = undefined;
        eventTimer.current = undefined;
        setEventEntry(null);
        setShortcutsPaused(Boolean(settings.shortcutsPaused));
        const entries = asset?.animations ?? [];
        const actions = clickableAnimations(asset);
        const nextResting = asset && actions.includes(asset.entry) ? asset.entry : (actions[0] ?? null);
        actionCursor.current = Math.max(0, actions.indexOf(nextResting ?? ""));
        setAppearanceId(id);
        setAnimations(entries);
        setLayout(asset?.layout ?? null);
        setEventActions(asset?.eventActions ?? {});
        setStateActions(asset?.stateActions ?? {});
        latestAsset.current = asset ?? null;
        setRestingEntry(nextResting);
        targetEntry.current = nextResting;
        setShownEntry(nextResting);
      } else {
        setShortcutsPaused(Boolean(settings.shortcutsPaused));
      }
      setPetScale(settings.petScale ?? PET_SCALE.default);
      setPetWander(Boolean(settings.petWander));
      setPetRandomActions(Boolean(settings.petRandomActions));
      setPetGravity(settings.petGravity ?? true);
    };
    void getPreviousApp().then(setApp);
    void loadSettings().then(applyAppearance);
    const appListener = onPreviousAppChanged(setApp);
    const settingsListener = onSettingsChanged(applyAppearance);
    return () => {
      void appListener.then((unlisten) => unlisten());
      void settingsListener.then((unlisten) => unlisten());
    };
  }, []);

  // 状态先订阅再查询快照：持续录制状态即使在桌宠窗口没挂监听时改变也能恢复。
  useEffect(() => {
    let revision = 0;
    let active = true;
    const recordingListener = onRecordingChanged((status: RecordingStatus) => {
      revision += 1;
      setRecording(Boolean(status?.active));
    });
    void recordingListener.then(() => {
      const observed = revision;
      void getRecordingStatus().then((status) => {
        if (active && observed === revision) setRecording(Boolean(status?.active));
      });
    });
    const eventListener = onPetEvent((event: PetEvent) => {
      if (event === "shortcuts.paused") setShortcutsPaused(true);
      if (event === "shortcuts.resumed") setShortcutsPaused(false);
      const asset = latestAsset.current;
      const entry = asset?.eventActions?.[event];
      if (!entry || !asset?.animations.includes(entry)) return;
      window.clearTimeout(eventTimer.current);
      void petActionDuration(asset.id, entry);
      setEventEntry(entry);
      setActionPulse((value) => value + 1);
    });
    return () => {
      active = false;
      void recordingListener.then((unlisten) => unlisten());
      void eventListener.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      void getRecordingStatus().then((status) => setRecording(Boolean(status?.active)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  // 算在渲染里：公式、百分比或当前动作一变，依赖就变，窗口跟着重设大小
  const currentEntry = shownEntry && cycle.includes(shownEntry) ? shownEntry : resting;
  const custom = appearanceId !== "app-icon";
  const walks = custom
    ? (["left", "right"] as const).map((direction) => ({ direction, choice: pickWalk(regularAnimations, direction, currentEntry) }))
    : [];
  const stateEntry = (shortcutsPaused ? stateActions?.["shortcuts-paused"] : undefined) ??
    (recording ? stateActions?.recording : null);

  const autonomy = usePetAutonomy({
    enabled: custom && !motionReduced(),
    wander: petWander,
    randomActions: petRandomActions,
    canWalk: walks.some((walk) => Boolean(walk.choice)),
    actions: cycle.filter((entry) => entry !== resting),
    paused: dragging || falling || manualAction || recording || shortcutsPaused || Boolean(stateEntry) || Boolean(eventEntry),
    setWalking,
    onAction: showAutoEntry,
    actionDuration: (entry) => petActionDuration(appearanceId, entry),
  });

  const shownWalk = stateEntry || eventEntry ? null : walks.find((walk) => walk.direction === walking && walk.choice)?.direction ?? null;
  const shownChoice = walks.find((walk) => walk.direction === shownWalk)?.choice ?? null;
  const normalEntry = stateEntry ?? eventEntry ?? currentEntry;
  const normalFrame = custom ? petImageFrame(appearanceId, normalEntry, false, false, actionPulse) : null;
  const walkFrames = walks.flatMap(({ choice }) => choice ? [petImageFrame(appearanceId, choice.entry, true, choice.flip)] : []);
  const targetFrame = shownWalk && shownChoice ? petImageFrame(appearanceId, shownChoice.entry, true, shownChoice.flip) : normalFrame;
  const { frames, displayed, leaving, onReady: onPetImageReady } = usePetImages(targetFrame, [...(normalFrame ? [normalFrame] : []), ...walkFrames]);
  const visibleEntry = displayed?.entry ?? null;
  const visibleFlip = displayed?.flip ?? false;
  const screenEdge = Math.min(window.screen.availWidth, window.screen.availHeight);
  const fittedSize = petScale === null ? null : petWindowSize(screenEdge, petScale, custom ? "pet" : "app-icon");
  const visiblePlacement = fittedSize === null ? null : placementForEntry(fittedSize, layout, visibleEntry, visibleFlip);
  const fittedKey = fittedSize === null ? "pending" : windowKey(fittedSize, visiblePlacement);

  // 从动作真正显示到屏幕上的那一刻开始计时，完整走完一轮 GIF 后再返回待机。
  useEffect(() => {
    window.clearTimeout(returnTimer.current);
    if (!manualAction || !currentEntry || currentEntry === resting || !normalFrame || displayed?.key !== normalFrame.key) return;
    let cancelled = false;
    void petActionDuration(appearanceId, currentEntry).then((duration) => {
      if (cancelled) return;
      returnTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        showManualEntry(restingRef.current);
        setManualAction(false);
      }, duration);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(returnTimer.current);
    };
  }, [appearanceId, currentEntry, displayed?.key, manualAction, normalFrame?.key, resting]);

  useEffect(() => {
    window.clearTimeout(eventTimer.current);
    if (!eventEntry || !normalFrame || displayed?.key !== normalFrame.key) return;
    let cancelled = false;
    void petActionDuration(appearanceId, eventEntry).then((duration) => {
      if (cancelled) return;
      eventTimer.current = window.setTimeout(() => {
        if (!cancelled) setEventEntry(null);
      }, duration);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(eventTimer.current);
    };
  }, [appearanceId, displayed?.key, eventEntry, normalFrame?.key]);

  function cancelGravity() {
    gravityToken.current += 1;
    cancelAnimationFrame(gravityFrame.current);
    setFalling(false);
  }

  async function dropToFloor() {
    const petWindow = getCurrentWindow();
    const token = ++gravityToken.current;
    const [monitor, position, size, scale] = await Promise.all([
      currentMonitor(),
      petWindow.outerPosition(),
      petWindow.outerSize(),
      petWindow.scaleFactor(),
    ]);
    if (!monitor || token !== gravityToken.current) return;
    const { position: origin, size: area } = monitor.workArea;
    const minX = origin.x;
    const maxX = origin.x + area.width - size.width;
    const floor = origin.y + area.height - size.height;
    let x = maxX < minX ? minX : Math.max(minX, Math.min(maxX, position.x));
    let y = Math.min(floor, Math.max(origin.y, position.y));
    if (x !== position.x || y !== position.y) {
      await petWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
    }
    if (!gravityEnabled.current || y >= floor) return;
    if (motionReduced()) {
      await petWindow.setPosition(new PhysicalPosition(x, floor)).catch(() => {});
      return;
    }

    setFalling(true);
    let velocity = 0;
    let previous = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        if (token !== gravityToken.current || !gravityEnabled.current) {
          resolve();
          return;
        }
        const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
        previous = now;
        velocity += 2600 * scale * dt;
        y += velocity * dt;
        const landed = y >= floor;
        if (landed) y = floor;
        void petWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => {});
        if (landed) resolve();
        else gravityFrame.current = requestAnimationFrame(step);
      };
      gravityFrame.current = requestAnimationFrame(step);
    });
    if (token === gravityToken.current) setFalling(false);
  }

  finishDrag.current = () => {
    if (gravityEnabled.current) void dropToFloor().catch(() => {});
    else void keepOnScreen(getCurrentWindow()).catch(() => {});
  };

  useEffect(() => {
    if (petScale === null) return;
    cancelGravity();
    if (petGravity) void dropToFloor().catch(() => {});
  }, [petGravity, petScale]);

  useEffect(
    () => () => {
      gravityToken.current += 1;
      cancelAnimationFrame(gravityFrame.current);
    },
    [],
  );

  // 物理像素。放大时窗口左上角相对方窗的偏移，存位置要减掉
  const frameShift = useRef({ x: 0, y: 0 });
  const appliedKey = useRef("");
  const frameModel = useRef({ petScale, custom, layout, visibleEntry, visibleFlip });
  frameModel.current = { petScale, custom, layout, visibleEntry, visibleFlip };

  useLayoutEffect(() => {
    if (fittedSize === null || petScale === null) return;
    const petWindow = getCurrentWindow();
    let active = true;
    let running = false;
    let again = false;

    const apply = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const model = frameModel.current;
          if (model.petScale === null) return;
          const shortEdge = Math.min(window.screen.availWidth, window.screen.availHeight);
          const side = petWindowSize(shortEdge, model.petScale, model.custom ? "pet" : "app-icon");
          if (active) setPetSize(side);
          const place = placementForEntry(side, model.layout, model.visibleEntry, model.visibleFlip);
          const key = windowKey(side, place);
          if (key === appliedKey.current) continue;
          appliedKey.current = key;
          await commitPetWindow(petWindow, side, place, frameShift, t);
        } while (again);
      } catch (error) {
        appliedKey.current = "";
        console.error("snapshot: pet window resize failed", error);
      } finally {
        running = false;
      }
    };

    void apply();
    const movedListener = petWindow.onMoved(() => {
      void apply();
    });
    const scaleListener = petWindow.onScaleChanged(() => {
      void apply();
    });
    return () => {
      active = false;
      void movedListener.then((unlisten) => unlisten());
      void scaleListener.then((unlisten) => unlisten());
    };
  }, [fittedSize, petScale, fittedKey, t]);

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    autonomy.cancel();
    cancelGravity();
    setWalking(null);
    setManualAction(false);
    dragged.current = false;
    const petWindow = getCurrentWindow();
    const element = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startScreenX = event.screenX;
    const startScreenY = event.screenY;
    let lastScreenX = startScreenX;
    let lastScreenY = startScreenY;
    let geometry: DragGeometry | null = null;
    let target: { x: number; y: number } | null = null;
    let frame = 0;
    let finished = false;
    const moved = { x: startScreenX, y: startScreenY };

    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // 老 WebView 没实现指针捕获时仍可继续用窗口级监听。
    }

    const cleanup = () => {
      window.removeEventListener("pointermove", markDrag);
      window.removeEventListener("pointerup", finishPress);
      window.removeEventListener("pointercancel", cancelPress);
      element.removeEventListener("lostpointercapture", loseCapture);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      try {
        if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // 窗口已经失去捕获时，释放会抛错，可以直接忽略。
      }
    };

    const placeTarget = () => {
      if (finished || !geometry || !target) return;
      const previousX = moved.x;
      const previousY = moved.y;
      const next = nextDragWalk(dragMotion.current, target.x - previousX, target.y - previousY);
      moved.x = target.x;
      moved.y = target.y;
      if (next) {
        dragMotion.current = next;
        setWalking(next.direction);
      }
      const x = Math.round(target.x);
      const y = Math.round(target.y);
      if (x === Math.round(previousX) && y === Math.round(previousY)) return;
      void petWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
    };

    const schedulePlace = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeTarget();
      });
    };

    const clampTarget = (screenX: number, screenY: number) => {
      if (!geometry) return null;
      const rawX = geometry.position.x + (screenX - startScreenX) * geometry.scale;
      const rawY = geometry.position.y + (screenY - startScreenY) * geometry.scale;
      // Rust 侧在 Moved 时也会守住这条线。两边使用同一个上限，避免反复把窗口压回又拖下去。
      return { x: rawX, y: geometry.floorY === null ? rawY : Math.min(rawY, geometry.floorY) };
    };

    const startMoving = () => {
      if (dragged.current) return;
      dragged.current = true;
      setDragging(true);
      window.clearTimeout(clickTimer.current);
      clickTimer.current = undefined;
      dragMotion.current = STANDING;
      moved.x = geometry?.position.x ?? startScreenX;
      moved.y = geometry?.position.y ?? startScreenY;
    };

    const markDrag = (move: PointerEvent) => {
      if (finished || move.pointerId !== pointerId) return;
      lastScreenX = move.screenX;
      lastScreenY = move.screenY;
      if (!dragged.current) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        startMoving();
      }
      if (!geometry) return;
      target = clampTarget(lastScreenX, lastScreenY);
      schedulePlace();
    };

    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!dragged.current) {
        if (cancelled) return;
        if (clickTimer.current !== undefined) {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = undefined;
          void showLaunchpad(event.screenX, event.screenY);
          return;
        }
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = undefined;
          switchOnClick();
        }, CLICK_DELAY_MS);
        return;
      }

      setWalking(null);
      setDragging(false);
      dragMotion.current = STANDING;
      const landing = target && geometry
        ? petWindow.setPosition(new PhysicalPosition(Math.round(target.x), Math.round(target.y))).catch(() => {})
        : Promise.resolve();
      void landing.then(() => finishDrag.current());
    };

    const finishPress = (up: PointerEvent) => {
      if (up.pointerId === pointerId) finish(false);
    };
    const cancelPress = (cancelled: PointerEvent) => {
      if (cancelled.pointerId === pointerId) finish(true);
    };
    const loseCapture = () => {
      if (dragged.current) finish(true);
    };

    window.addEventListener("pointermove", markDrag);
    window.addEventListener("pointerup", finishPress);
    window.addEventListener("pointercancel", cancelPress);
    element.addEventListener("lostpointercapture", loseCapture);

    void readDragGeometry(petWindow).then((result) => {
      if (finished) return;
      geometry = result;
      if (dragged.current && geometry) {
        moved.x = geometry.position.x;
        moved.y = geometry.position.y;
        target = clampTarget(lastScreenX, lastScreenY);
        schedulePlace();
      }
    }).catch(() => {});
  }

  // 平时停在默认待机。点一下换到下一个非走路动作，完整播放一轮后回到待机。
  function switchOnClick() {
    const rest = restingRef.current;
    if (appearanceId === "app-icon" || !rest || cycle.length < 2) return;
    for (let step = 1; step <= cycle.length; step += 1) {
      const index = (actionCursor.current + step) % cycle.length;
      const entry = cycle[index];
      if (entry === rest) continue;
      actionCursor.current = index;
      showManualEntry(entry);
      setManualAction(true);
      window.clearTimeout(returnTimer.current);
      return;
    }
  }

  // 换了动作就告诉主窗口，侧栏的猫跟着换；主窗口刚打开来问时也答一声（走路不算，侧栏不跟着走）
  const current = useRef({ assetId: appearanceId, entry: currentEntry });
  current.current = { assetId: appearanceId, entry: currentEntry };
  useEffect(() => {
    if (appearanceId !== "app-icon") broadcastPetAnimation({ assetId: appearanceId, entry: currentEntry });
  }, [appearanceId, currentEntry]);
  useEffect(
    () =>
      onPetAnimationAsked(() => {
        if (current.current.assetId !== "app-icon") broadcastPetAnimation(current.current);
      }),
    [],
  );

  // 有锚点的图按基准比例摆；窗口长出去的那截已经算进 shift，这里减掉才是相对当前窗口的位置
  const framedStyle = (entry: string, flip: boolean) => {
    if (fittedSize === null || !visiblePlacement) return undefined;
    const place = placementForEntry(fittedSize, layout, entry, flip);
    if (!place) return undefined;
    return {
      left: place.imageX - visiblePlacement.shiftX,
      top: place.imageY - visiblePlacement.shiftY,
      width: place.imageWidth,
      height: place.imageHeight,
    };
  };
  const framed = visiblePlacement != null;

  function onContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    autonomy.cancel();
    cancelGravity();
    setWalking(null);
    void showQuickMenu(event.screenX, event.screenY);
  }

  return (
    <div
      className={`pet-window ${custom ? "custom" : "app-icon"}`}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      title={!custom && app.name ? app.name : undefined}
      style={{ "--pet-icon-size": `${petSize - 4}px` } as React.CSSProperties}
    >
      <div className={custom && framed ? "pet-frames" : "pet-orb"}>
        {custom ? (
          <>
            {frames.map((frame) => {
              const style = framedStyle(frame.entry ?? "", frame.flip);
              return (
                <PetMedia
                  key={frame.key}
                  className={[
                    frame.walk ? "pet-walk" : "pet-action",
                    frame.flip ? "pet-flip" : "",
                    style ? "pet-framed" : "",
                    frame.key === displayed?.key ? "pet-current" : frame.key === leaving?.key ? "pet-crossfade-out" : "",
                  ].filter(Boolean).join(" ")}
                  style={style}
                  src={frame.src}
                  entry={frame.entry}
                  hidden={displayed?.key !== frame.key && leaving?.key !== frame.key}
                  onReady={(element) => void onPetImageReady(frame, element)}
                />
              );
            })}
            {!displayed && <PawPrint size={petSize - 10} style={{ gridArea: "1 / 1" }} />}
          </>
        ) : (
          <MediaImage
            key={app.pid ?? "none"}
            src={app.pid === null ? null : iconUrl(app.pid, petSize)}
            alt={app.name}
            fallback={<AppWindow size={petSize - 12} />}
          />
        )}
      </div>
    </div>
  );
}
