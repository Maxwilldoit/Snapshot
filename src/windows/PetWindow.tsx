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
import { iconUrl, petUrl, petWalkUrl } from "../lib/media";
import { MediaImage } from "../components/MediaImage";
import { broadcastPetAnimation, onPetAnimationAsked } from "../lib/petSync";
import { placementForEntry, type PetPlacement } from "../lib/petFrame";
import { PET_SCALE, petWindowSize } from "../lib/petSize";
import { cycleEntries, nextDragWalk, pickWalk, STANDING, type DragWalk, type WalkDirection } from "../lib/petWalk";
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
    throw new Error("读不到桌宠窗口的位置");
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

/** 窗口停下这么久没再动，就算松手了，换回原来的动作 */
const WALK_SETTLE_MS = 250;
/** 点一下换上的动作只停这么久，然后回到默认待机 */
const CLICK_ACTION_MS = 3000;
/** 语义反馈播完回到录制中/待机等当下仍有效的状态 */
const EVENT_ACTION_MS = 2600;
/** 等这么久还没来第二下，才算单击。第二下是双击，打开启动台，不换动作 */
export const CLICK_DELAY_MS = 400;

function ordinaryAnimations(asset: Pick<PetAsset, "animations" | "eventActions" | "stateActions"> | null | undefined) {
  const reserved = new Set([
    ...Object.values(asset?.eventActions ?? {}),
    ...Object.values(asset?.stateActions ?? {}),
  ]);
  return (asset?.animations ?? []).filter((entry) => !reserved.has(entry));
}

export function PetWindow() {
  const [app, setApp] = useState<PreviousApp>({ id: null, pid: null, name: "", title: "" });
  const [appearanceId, setAppearanceId] = useState("app-icon");
  const [animations, setAnimations] = useState<string[]>([]);
  const [layout, setLayout] = useState<PetLayout | null>(null);
  const [eventActions, setEventActions] = useState<PetAsset["eventActions"]>({});
  const [stateActions, setStateActions] = useState<PetAsset["stateActions"]>({});
  const [restingEntry, setRestingEntry] = useState<string | null>(null);
  const [shownEntry, setShownEntry] = useState<string | null>(null);
  const [eventEntry, setEventEntry] = useState<string | null>(null);
  const [eventPulse, setEventPulse] = useState(0);
  const [recording, setRecording] = useState(false);
  const [shortcutsPaused, setShortcutsPaused] = useState(false);
  const [petSize, setPetSize] = useState(60);
  // 读到设置前不定大小，免得先按默认缩放一次再跳到用户设的大小
  const [petScale, setPetScale] = useState<number | null>(null);
  const [walking, setWalking] = useState<WalkDirection | null>(null);
  const dragged = useRef(false);
  // 点过之后下一次从这里接着换，回到待机也不清掉，免得每次点击都是同一个动作
  const actionCursor = useRef(0);
  const returnTimer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const eventTimer = useRef<number | undefined>(undefined);
  const restingRef = useRef<string | null>(null);
  const appearanceKey = useRef("");
  const latestAsset = useRef<PetAsset | null>(null);

  // 点击切换只在常规动作里转，走路动作留给拖动
  const regularAnimations = ordinaryAnimations({ animations, eventActions, stateActions });
  const cycle = cycleEntries(regularAnimations);
  const resting = restingEntry && cycle.includes(restingEntry) ? restingEntry : (cycle[0] ?? null);
  restingRef.current = resting;

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
        const actions = cycleEntries(ordinaryAnimations(asset));
        const nextResting = asset && actions.includes(asset.entry) ? asset.entry : (actions[0] ?? null);
        actionCursor.current = Math.max(0, actions.indexOf(nextResting ?? ""));
        setAppearanceId(id);
        setAnimations(entries);
        setLayout(asset?.layout ?? null);
        setEventActions(asset?.eventActions ?? {});
        setStateActions(asset?.stateActions ?? {});
        latestAsset.current = asset ?? null;
        setRestingEntry(nextResting);
        setShownEntry(nextResting);
      } else {
        setShortcutsPaused(Boolean(settings.shortcutsPaused));
      }
      setPetScale(settings.petScale ?? PET_SCALE.default);
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
      setEventEntry(entry);
      setEventPulse((value) => value + 1);
      eventTimer.current = window.setTimeout(() => setEventEntry(null), EVENT_ACTION_MS);
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
  const shownWalk = stateEntry || eventEntry ? null : walks.find((walk) => walk.direction === walking && walk.choice)?.direction ?? null;
  const shownChoice = walks.find((walk) => walk.direction === shownWalk)?.choice ?? null;
  const visibleEntry = stateEntry ?? eventEntry ?? (shownWalk && shownChoice ? shownChoice.entry : currentEntry);
  const visiblePulse = eventEntry && !stateEntry ? eventPulse : 0;
  const visibleFlip = Boolean(shownWalk && shownChoice?.flip);
  const screenEdge = Math.min(window.screen.availWidth, window.screen.availHeight);
  const fittedSize = petScale === null ? null : petWindowSize(screenEdge, petScale);
  const visiblePlacement = fittedSize === null ? null : placementForEntry(fittedSize, layout, visibleEntry, visibleFlip);
  const fittedKey = fittedSize === null ? "pending" : windowKey(fittedSize, visiblePlacement);

  // 物理像素。放大时窗口左上角相对方窗的偏移，存位置要减掉
  const frameShift = useRef({ x: 0, y: 0 });
  const appliedKey = useRef("");
  const frameModel = useRef({ petScale, layout, visibleEntry, visibleFlip });
  frameModel.current = { petScale, layout, visibleEntry, visibleFlip };

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
          const side = petWindowSize(shortEdge, model.petScale);
          if (active) setPetSize(side);
          const place = placementForEntry(side, model.layout, model.visibleEntry, model.visibleFlip);
          const key = windowKey(side, place);
          if (key === appliedKey.current) continue;
          appliedKey.current = key;
          await commitPetWindow(petWindow, side, place, frameShift);
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
  }, [fittedSize, petScale, fittedKey]);

  // 拖动时网页收不到指针事件（系统接管了窗口），只能看窗口往哪边移
  useEffect(() => {
    const petWindow = getCurrentWindow();
    let last: { x: number; y: number } | null = null;
    let state: DragWalk = STANDING;
    let settle: number | undefined;
    const movedListener = petWindow.onMoved(({ payload }) => {
      const previous = last;
      last = { x: payload.x, y: payload.y };
      if (!previous) return;
      const next = nextDragWalk(state, payload.x - previous.x, payload.y - previous.y);
      if (!next) return;
      state = next;
      setWalking(next.direction);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        state = STANDING;
        setWalking(null);
      }, WALK_SETTLE_MS);
    });
    return () => {
      window.clearTimeout(settle);
      void movedListener.then((unlisten) => unlisten());
    };
  }, []);

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    dragged.current = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const finishClick = () => {
      cleanup();
      if (dragged.current) return;
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
    };
    const markDrag = (move: PointerEvent) => {
      if (Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) <= 4) return;
      dragged.current = true;
      window.clearTimeout(clickTimer.current);
      clickTimer.current = undefined;
      cleanup();
      void getCurrentWindow().startDragging();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", markDrag);
      window.removeEventListener("pointerup", finishClick);
    };
    window.addEventListener("pointermove", markDrag);
    window.addEventListener("pointerup", finishClick);
  }

  // 平时停在默认待机。点一下换到下一个非走路动作，停几秒再回到待机。
  function switchOnClick() {
    const rest = restingRef.current;
    if (appearanceId === "app-icon" || !rest || cycle.length < 2) return;
    for (let step = 1; step <= cycle.length; step += 1) {
      const index = (actionCursor.current + step) % cycle.length;
      const entry = cycle[index];
      if (entry === rest) continue;
      actionCursor.current = index;
      setShownEntry(entry);
      window.clearTimeout(returnTimer.current);
      returnTimer.current = window.setTimeout(() => setShownEntry(restingRef.current), CLICK_ACTION_MS);
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

  const petSrc = custom ? petUrl(appearanceId, visibleEntry) : null;
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
      {custom && framed ? (
        <>
          <MediaImage
            key={`${petSrc ?? "none"}:${visiblePulse}`}
            className="pet-fade pet-framed"
            style={framedStyle(visibleEntry ?? "", visibleFlip)}
            src={petSrc}
            hidden={shownWalk !== null}
            fallback={<PawPrint size={petSize - 10} />}
          />
          {walks.map(({ direction, choice }) =>
            choice ? (
              <MediaImage
                key={`${direction}:${choice.entry}`}
                className={choice.flip ? "pet-walk pet-flip pet-framed" : "pet-walk pet-framed"}
                style={framedStyle(choice.entry, choice.flip)}
                src={petWalkUrl(appearanceId, choice.entry)}
                hidden={shownWalk !== direction}
                fallback={null}
              />
            ) : null,
          )}
        </>
      ) : (
        <div className="pet-orb">
          {custom ? (
            <>
              <MediaImage
                key={`${petSrc ?? "none"}:${visiblePulse}`}
                className="pet-fade"
                src={petSrc}
                hidden={shownWalk !== null}
                fallback={<PawPrint size={petSize - 10} />}
              />
              {walks.map(({ direction, choice }) =>
                choice ? (
                  <MediaImage
                    key={`${direction}:${choice.entry}`}
                    className={choice.flip ? "pet-walk pet-flip" : "pet-walk"}
                    src={petWalkUrl(appearanceId, choice.entry)}
                    hidden={shownWalk !== direction}
                    fallback={null}
                  />
                ) : null,
              )}
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
      )}
    </div>
  );
}
