import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { availableMonitors, currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, type Window } from "@tauri-apps/api/window";
import { AppWindow, PawPrint } from "lucide-react";
import {
  getPreviousApp,
  getRecordingStatus,
  loadSettings,
  onPetEvent,
  onPreviousAppChanged,
  onRecordingChanged,
  onSettingsChanged,
  setPetHitbox,
  setPetFrameShift,
  setPetBounds,
  showLaunchpad,
  showQuickMenu,
} from "../lib/backend";
import { iconUrl, isWebmEntry } from "../lib/media";
import { MediaImage } from "../components/MediaImage";
import { PetMedia, type PetMediaElement } from "../components/PetMedia";
import { createPetAlphaReader, unionMediaBounds } from "../lib/petMediaBounds";
import { cachePetMediaShape, loadPetMediaShapes, mediaShapeKey, type PetMediaShape } from "../lib/petMediaShapeCache";
import { petVideoPixels } from "../lib/petVideoAlpha";
import { petImageFrame, usePetImages, type PetImageFrame } from "../hooks/usePetImages";
import { broadcastPetAnimation, onPetAnimationAsked } from "../lib/petSync";
import { coverPetPlacements, cropPetPlacement, groundForEntry, mediaPlacement, petRenderCanvas, placementForEntry, type PetPlacement, type PetRenderCanvas } from "../lib/petFrame";
import { PET_SCALE, containedMediaBounds, petWindowSize, type MediaBounds } from "../lib/petSize";
import { clampPetPixelX, clampPetX, petFloorY, petHorizontalLimits, type PetWorkArea } from "../lib/petBounds";
import { ensurePetAutoScale, readPetBaseScale, watchPetBaseScales } from "../lib/petScale";
import { hasVerticalWalkEntries, nextDragWalk, pickWalk, STANDING, type DragWalk, type PetFacing, type WalkDirection } from "../lib/petWalk";
import { clickableAnimations, ordinaryAnimations, pickHitAnimation } from "../lib/petActions";
import { useI18n, useWindowTitle } from "../lib/i18n";
import { motionReduced } from "../lib/motion";
import { usePetAutonomy } from "../hooks/usePetAutonomy";
import { petActionDuration } from "../lib/petAnimation";
import { pickPetEntry, pickPetHitEntry, resolvePetBehavior, type PetBehavior } from "../lib/petBehavior";
import {
  augmentAssetWithBuiltinHurt,
  builtinHurtDurationMs,
  HURT_EXPRESSION_MS,
  HURT_FRAME_INTERVAL_MS,
  identifyCatalogSprite,
  isBuiltinHurtEntry,
  pickPetHurtMode,
  type PetHurtMode,
} from "../lib/petHurtExpression";
import { createPetPlayback, type PetPlaybackOwner } from "../lib/petPlayback";
import {
  clampLaunchAtBounds,
  estimateThrowVelocity,
  HIT_ACTION_MIN_SPEED,
  impactDeformation,
  SLINGSHOT_DOUBLE_MS,
  slingshotLaunchVelocity,
  slingshotPower,
  stepThrow,
  trimPointerTrail,
  type ContactEdge,
  type PetImpactKind,
  type PointerSample,
  type ThrowBounds,
} from "../lib/petThrowPhysics";
import { usePetBehaviorAutonomy } from "../hooks/usePetBehaviorAutonomy";
import type { PetAsset, PetEvent, PetLayout, PreviousApp, RecordingStatus, Settings } from "../types";

type MediaShape = PetMediaShape;

function framePlacement(side: number, layout: PetLayout | null, frame: PetImageFrame | null, shapes: Map<string, MediaShape>) {
  if (!frame) return null;
  const shape = shapes.get(mediaShapeKey(frame.assetId, frame.entry ?? "", frame.walk));
  const place = placementForEntry(side, layout, frame.entry, frame.flip) ??
    (shape ? mediaPlacement(side, shape.width, shape.height) : null);
  return place ? cropPetPlacement(place, shape?.bounds ?? null, frame.flip) : null;
}

function viewportPlacement(side: number, layout: PetLayout | null, current: PetImageFrame | null, previous: PetImageFrame | null, shapes: Map<string, MediaShape>, squashing = false) {
  let place = framePlacement(side, layout, current, shapes);
  if (place && squashing) {
    // Q 弹与碰撞形变在水平和竖直方向均会短暂外扩；只在这段动画内为变形留余量。
    const x = Math.ceil(place.imageWidth * .06);
    const y = Math.ceil(place.imageHeight * .06);
    place = { ...place, shiftX: place.shiftX - x, shiftY: place.shiftY - y,
      width: place.width + x * 2, height: place.height + y * 2 };
  }
  return place ? coverPetPlacements(place, framePlacement(side, layout, previous, shapes)) : null;
}

function viewportGround(side: number, layout: PetLayout | null, frame: PetImageFrame | null, place: PetPlacement | null) {
  if (!frame || !place) return null;
  const normal = placementForEntry(side, layout, frame.entry, frame.flip);
  const ground = groundForEntry(side, layout, frame.entry, frame.flip);
  return normal && ground !== null ? ground + normal.shiftY - place.shiftY : null;
}

function viewportContent(place: PetPlacement, frame: PetImageFrame, shapes: Map<string, MediaShape>): MediaBounds {
  const bounds = shapes.get(mediaShapeKey(frame.assetId, frame.entry ?? "", frame.walk))?.bounds ??
    { left: 0, top: 0, width: 1, height: 1 };
  return {
    left: place.imageX - place.shiftX + (frame.flip ? 1 - bounds.left - bounds.width : bounds.left) * place.imageWidth,
    top: place.imageY - place.shiftY + bounds.top * place.imageHeight,
    width: bounds.width * place.imageWidth, height: bounds.height * place.imageHeight,
  };
}

/** 放大后超出了所在屏幕的可用区域，就挪回来 */
async function keepOnScreen(petWindow: Window, content: MediaBounds | null = null, horizontal = true, canMove = () => true, groundY: number | null = null) {
  const monitor = await currentMonitor();
  if (!monitor || !canMove()) return;
  const [position, size, scale, monitors] = await Promise.all([
    petWindow.outerPosition(), petWindow.outerSize(), petWindow.scaleFactor(), availableMonitors().catch(() => []),
  ]);
  if (!canMove()) return;
  const { position: origin } = monitor.workArea;
  const areas = monitors?.length ? monitors.map((item) => item.workArea) : [monitor.workArea];
  // 可见内容的边距常带小数（如 4.5px），这里必须落到整数像素，否则 setPosition 失败、窗口停在屏幕外
  const x = horizontal ? clampPetPixelX(position.x, petHorizontalLimits(areas, position, size, content, scale)) : position.x;
  const floor = petFloorY(monitor.workArea, size.height, content, scale, groundY);
  const y = floor === null ? position.y : Math.min(floor, Math.max(origin.y, position.y));
  if (x !== position.x || y !== position.y) await petWindow.setPosition(new PhysicalPosition(x, y));
}

/** 动作切换只修正垂直位置；横向由拖动和可见范围校准处理，避免透明方窗把角色推离屏幕边缘。 */
async function nudgeNormalWindow(normalY: number, side: number, factor: number, groundY: number | null, canMove: () => boolean) {
  if (!(factor > 0) || groundY === null || !canMove()) return { x: 0, y: 0 };
  const monitor = await currentMonitor();
  if (!monitor || !canMove()) return { x: 0, y: 0 };
  const extent = Math.round(side * factor);
  const floor = petFloorY(monitor.workArea, extent, null, factor, groundY);
  const y = floor === null ? normalY : Math.min(floor, Math.max(monitor.workArea.position.y, normalY));
  return { x: 0, y: y - normalY };
}

/** 相同外框无需重设原生窗口，呼吸动画只扩展一次包围盒，不逐帧缩放窗口。 */
function windowKey(side: number, place: PetPlacement | null, canvas: PetRenderCanvas | null = null) {
  const backing = canvas ? `|canvas:${canvas.left},${canvas.top},${canvas.width},${canvas.height}` : "";
  if (!place || (place.shiftX === 0 && place.shiftY === 0 && place.width === side && place.height === side)) {
    return `square|${side}${backing}`;
  }
  return `frame|${side}|${place.width}x${place.height}@${place.shiftX},${place.shiftY}${backing}`;
}

async function commitPetWindow(
  petWindow: Window,
  side: number,
  place: PetPlacement | null,
  shiftRef: { current: { x: number; y: number } },
  translate: (source: string) => string,
  groundY: number | null,
  canNudge: () => boolean,
  canvas: PetRenderCanvas | null,
  getLiveNormal?: () => { x: number; y: number } | null,
) {
  const atomic = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const reframes =
    place != null && !(place.shiftX === 0 && place.shiftY === 0 && place.width === side && place.height === side);
  if (!place || !reframes) {
    if (atomic) {
      const pos = await petWindow.outerPosition();
      const live = getLiveNormal?.();
      const nextX = Math.round(live ? live.x : pos.x - shiftRef.current.x);
      const nextY = Math.round(live ? live.y : pos.y - shiftRef.current.y);
      const prevShift = { ...shiftRef.current };
      shiftRef.current = { x: 0, y: 0 };
      try {
        const offset = await setPetBounds({
          x: nextX, y: nextY, width: side, height: side, shiftX: 0, shiftY: 0, canvas,
        });
        if (groundY !== null && canNudge()) await keepOnScreen(petWindow, null, false, canNudge, groundY);
        return offset;
      } catch (error) {
        shiftRef.current = prevShift;
        throw error;
      }
    }
    if (shiftRef.current.x !== 0 || shiftRef.current.y !== 0) {
      const pos = await petWindow.outerPosition();
      const live = getLiveNormal?.();
      const nextX = Math.round(live ? live.x : pos.x - shiftRef.current.x);
      const nextY = Math.round(live ? live.y : pos.y - shiftRef.current.y);
      shiftRef.current = { x: 0, y: 0 };
      await setPetFrameShift(0, 0);
      if (Number.isFinite(nextX) && Number.isFinite(nextY)) {
        await petWindow.setPosition(new PhysicalPosition(nextX, nextY));
      }
    }
    await petWindow.setSize(new LogicalSize(side, side));
    // 未测量的透明媒体不能先按方窗下沿推回去；随后可见范围校准会处理。
    if (groundY !== null && canNudge()) await keepOnScreen(petWindow, null, false, canNudge, groundY);
    return;
  }

  const factor = await petWindow.scaleFactor();
  const pos = await petWindow.outerPosition();
  if (!(factor > 0) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    throw new Error(translate("读不到桌宠窗口的位置"));
  }
  const shiftX = Math.round(place.shiftX * factor);
  const shiftY = Math.round(place.shiftY * factor);
  const initialLive = getLiveNormal?.();
  const initialNormalY = initialLive ? initialLive.y : pos.y - shiftRef.current.y;
  const nudge = await nudgeNormalWindow(initialNormalY, side, factor, groundY === null ? null : groundY + place.shiftY, canNudge);
  // 异步 IPC 等待期间光标可能已继续移动；若仍在拖动则采用最新目标坐标，避免窗口被旧 outerPosition() 拽回
  const latestLive = getLiveNormal?.();
  const normalX = latestLive ? latestLive.x : pos.x - shiftRef.current.x;
  const normalY = latestLive ? latestLive.y : pos.y - shiftRef.current.y;
  const nextX = Math.round(normalX + nudge.x + shiftX);
  const nextY = Math.round(normalY + nudge.y + shiftY);
  if (atomic) {
    const prevShift = { ...shiftRef.current };
    shiftRef.current = { x: shiftX, y: shiftY };
    try {
      return await setPetBounds({ x: nextX, y: nextY, width: place.width, height: place.height, shiftX, shiftY, canvas });
    } catch (error) {
      shiftRef.current = prevShift;
      throw error;
    }
  } else {
    shiftRef.current = { x: shiftX, y: shiftY };
    await setPetFrameShift(shiftX, shiftY);
    if (latestLive || nextX !== pos.x || nextY !== pos.y) await petWindow.setPosition(new PhysicalPosition(nextX, nextY));
    await petWindow.setSize(new LogicalSize(place.width, place.height));
  }
}

/** Windows/Linux 等待双击打开启动台；macOS 没有启动台，点击立即切换动作。 */
export const CLICK_DELAY_MS = 400;

type DragGeometry = {
  position: { x: number; y: number };
  scale: number;
  /** 按脚底而非透明方窗计算的窗口左上角物理像素上限。 */
  floorY: number | null;
  /** 按角色头顶计算的窗口左上角物理像素下限（天花板）。 */
  ceilingY: number | null;
  size: { width: number; height: number };
  areas: PetWorkArea[];
  content: MediaBounds | null;
};

type ActiveSleep = {
  phase: "start" | "loop" | "end";
  entry: string;
  set: { start: string; loop: string; end: string };
};

async function readDragGeometry(petWindow: Window, content: MediaBounds | null, groundY: number | null): Promise<DragGeometry | null> {
  const [position, size, scale, monitor, monitors] = await Promise.all([
    petWindow.outerPosition(),
    petWindow.outerSize(),
    petWindow.scaleFactor(),
    currentMonitor(),
    availableMonitors().catch(() => []),
  ]);
  if (!(scale > 0) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const floorY = monitor
    ? petFloorY(monitor.workArea, size.height, content, scale, groundY)
    : null;
  const ceilingY = monitor
    ? monitor.workArea.position.y - Math.round((content?.top ?? 0) * scale)
    : null;
  const areas = monitors?.length ? monitors.map((item) => item.workArea) : monitor ? [monitor.workArea] : [];
  return { position, scale, floorY, ceilingY, size, areas, content };
}

export function PetWindow() {
  const { t } = useI18n();
  const hasLaunchpad = !/Macintosh|Mac OS X/.test(navigator.userAgent);
  useWindowTitle(t("桌宠"));
  const [app, setApp] = useState<PreviousApp>({ id: null, pid: null, name: "", title: "" });
  const [appearanceId, setAppearanceId] = useState("app-icon");
  const [animations, setAnimations] = useState<string[]>([]);
  const [layout, setLayout] = useState<PetLayout | null>(null);
  const [mediaShapes, setMediaShapes] = useState(() => new Map<string, MediaShape>());
  const [eventActions, setEventActions] = useState<PetAsset["eventActions"]>({});
  const [stateActions, setStateActions] = useState<PetAsset["stateActions"]>({});
  const [restingEntry, setRestingEntry] = useState<string | null>(null);
  const [shownEntry, setShownEntry] = useState<string | null>(null);
  const [eventEntry, setEventEntry] = useState<string | null>(null);
  const eventEntryRef = useRef<string | null>(null);
  eventEntryRef.current = eventEntry;
  // 每次换动作都给 img 新 key，让 GIF 从首帧播放一轮，而不是接着隐藏时的进度。
  const [actionPulse, setActionPulse] = useState(0);
  const pulseRef = useRef(0);
  const [behavior, setBehavior] = useState<PetBehavior | null>(null);
  const behaviorRef = useRef<PetBehavior | null>(null);
  const [behaviorFacing, setBehaviorFacing] = useState<PetFacing>("left");
  const facingRef = useRef<PetFacing>("left");
  const [dragEntry, setDragEntry] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [shortcutsPaused, setShortcutsPaused] = useState(false);
  const statusFlagsRef = useRef({ recording: false, shortcutsPaused: false });
  statusFlagsRef.current = { recording, shortcutsPaused };
  const [petSize, setPetSize] = useState(80);
  // 读到设置前不定大小，免得先按默认缩放一次再跳到用户设的大小
  const [petScale, setPetScale] = useState<number | null>(null);
  const [baseScale, setBaseScale] = useState<number>(PET_SCALE.default);
  const [petWander, setPetWander] = useState(false);
  const [petRandomActions, setPetRandomActions] = useState(false);
  const [petGravity, setPetGravity] = useState(true);
  const [walking, setWalking] = useState<WalkDirection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [falling, setFalling] = useState(false);
  const [manualAction, setManualAction] = useState(false);
  const [squashing, setSquashing] = useState(false);
  const [hitPulse, setHitPulse] = useState(0);
  const hitPulseRef = useRef(0);
  hitPulseRef.current = hitPulse;
  const activeHitPulse = useRef<number | null>(null);
  const iconFaceRef = useRef<HTMLDivElement>(null);
  const hurtTimerRef = useRef<number | undefined>(undefined);
  const hurtBlinkRef = useRef<number | undefined>(undefined);
  const hurtSeqRef = useRef(0);
  const [sleepState, setSleepState] = useState<ActiveSleep | null>(null);
  const sleepRef = useRef<ActiveSleep | null>(null);
  const flyingRef = useRef(false);
  const lastPressAtRef = useRef<number | null>(null);
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
  const petRootRef = useRef<HTMLDivElement>(null);
  const visibleBounds = useRef<MediaBounds | null>(null);
  const groundOffset = useRef<number | null>(null);
  const pointerHeld = useRef(false);
  const positionRevision = useRef(0);
  const needsHorizontalFit = useRef(true);
  const windowFrameReady = useRef(false);
  const requestBoundsReport = useRef<() => void>(() => {});
  const reframeDrag = useRef<() => void>(() => {});
  const dragNormalPosition = useRef<(() => { x: number; y: number } | null) | null>(null);
  const dragEnvelope = useRef<{ side: number; place: PetPlacement } | null>(null);
  const cancelPointerDrag = useRef<(() => void) | null>(null);
  const fittedAppearance = useRef("");
  const playbackRef = useRef<ReturnType<typeof createPetPlayback> | null>(null);
  const playback = playbackRef.current ??= createPetPlayback();
  const behaviorRevision = useRef(0);
  const readyMedia = useRef(new Map<string, PetMediaElement>());
  const alphaReader = useRef<ReturnType<typeof createPetAlphaReader> | null>(null);
  const readAlpha = alphaReader.current ??= createPetAlphaReader();
  const squash = useRef<Animation | null>(null);
  const tensionSurface = useRef<HTMLElement | null>(null);

  const hitRoll = (pulse: number) => () => ((pulse % 4) + 0.1) / 4;

  function clearHurtExpression() {
    window.clearTimeout(hurtTimerRef.current);
    window.clearInterval(hurtBlinkRef.current);
    hurtTimerRef.current = undefined;
    hurtBlinkRef.current = undefined;
    const root = petRootRef.current;
    if (root) {
      root.removeAttribute("data-hurt-expression");
      root.removeAttribute("data-hurt-character");
    }
    if (iconFaceRef.current) {
      iconFaceRef.current.hidden = true;
      iconFaceRef.current.className = "pet-icon-face";
    }
  }

  function triggerCollisionExpression(edge: ContactEdge, speed: number) {
    if (motionReduced() || sleepRef.current || statusFlagsRef.current.recording || statusFlagsRef.current.shortcutsPaused) return;
    window.clearTimeout(hurtTimerRef.current);
    window.clearInterval(hurtBlinkRef.current);
    hurtSeqRef.current += 1;
    const mode: PetHurtMode = pickPetHurtMode(edge, speed, hurtSeqRef.current);
    const asset = latestAsset.current;
    const spriteId = identifyCatalogSprite(asset);
    const characterTag = spriteId ?? (behaviorRef.current ? behaviorRef.current.id : asset ? "custom-sprite" : "app-icon");
    const root = petRootRef.current;
    if (root) {
      root.setAttribute("data-hurt-expression", mode);
      root.setAttribute("data-hurt-character", characterTag);
    }

    if (!asset) {
      const face = iconFaceRef.current;
      if (face) {
        face.hidden = false;
        face.className = `pet-icon-face mode-${mode}`;
        let phase: 0 | 1 = 0;
        hurtBlinkRef.current = window.setInterval(() => {
          phase = phase === 0 ? 1 : 0;
          if (iconFaceRef.current) {
            iconFaceRef.current.className = `pet-icon-face mode-${mode}${phase ? " phase-1" : ""}`;
          }
        }, HURT_FRAME_INTERVAL_MS);
      }
    }
    const spriteHitEntry = spriteId ? `__builtin_hit__:${spriteId}.webm` : null;
    const holdMs = (spriteHitEntry ? builtinHurtDurationMs(spriteHitEntry) : null) ?? HURT_EXPRESSION_MS;
    hurtTimerRef.current = window.setTimeout(clearHurtExpression, holdMs);
  }

  function rememberMediaDimensions(frame: PetImageFrame, media: PetMediaElement) {
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!(width > 0 && height > 0)) return;
    const key = mediaShapeKey(frame.assetId, frame.entry ?? "", frame.walk);
    setMediaShapes((previous) => {
      const cached = previous.get(key);
      if (cached?.width === width && cached.height === height) return previous;
      return new Map(previous).set(key, { width, height, bounds: null });
    });
  }

  function rememberCompleteMediaShape(
    frame: PetImageFrame,
    media: PetMediaElement,
    bounds: MediaBounds,
  ) {
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!(width > 0 && height > 0)) return;
    const key = mediaShapeKey(frame.assetId, frame.entry ?? "", frame.walk);
    const cached = mediaShapes.get(key);
    const complete = cached?.width === width && cached.height === height && cached.bounds
      ? unionMediaBounds(cached.bounds, bounds)
      : bounds;
    cachePetMediaShape(latestAsset.current, frame.entry, { width, height, bounds: complete });
    setMediaShapes((previous) => {
      const current = previous.get(key);
      if (current && current.width === width && current.height === height && current.bounds &&
        Math.abs(current.bounds.left - complete.left) < 1e-6 &&
        Math.abs(current.bounds.top - complete.top) < 1e-6 &&
        Math.abs(current.bounds.width - complete.width) < 1e-6 &&
        Math.abs(current.bounds.height - complete.height) < 1e-6) return previous;
      return new Map(previous).set(key, { width, height, bounds: complete });
    });
  }

  // 点击切换只在常规动作里转，走路动作留给拖动
  const regularAnimations = ordinaryAnimations({ animations, eventActions, stateActions });
  const behaviorEntries = behavior ? new Set([
    ...behavior.idle, ...behavior.clicks, ...behavior.hit, ...behavior.turn, ...behavior.moves.map((move) => move.entry),
    ...(behavior.sleep ? [...behavior.sleep.start, ...behavior.sleep.loop, ...behavior.sleep.end] : []),
    ...behavior.categories.flatMap((category) => category.entries),
  ]) : null;
  const cycle = behaviorEntries ? regularAnimations.filter((entry) => behaviorEntries.has(entry))
    : clickableAnimations({ animations, eventActions, stateActions });
  const resting = restingEntry && cycle.includes(restingEntry) ? restingEntry : (cycle[0] ?? null);
  restingRef.current = resting;

  function bumpPulse() {
    pulseRef.current += 1;
    setActionPulse(pulseRef.current);
    return pulseRef.current;
  }

  function requestEntry(entry: string | null) {
    if (entry === targetEntry.current) return;
    targetEntry.current = entry;
    if (!behaviorRef.current && entry && entry !== restingRef.current) void petActionDuration(appearanceId, entry);
    bumpPulse();
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

  function clearPullTension() {
    if (tensionSurface.current) {
      tensionSurface.current.style.transform = "";
      tensionSurface.current.style.transformOrigin = "";
      tensionSurface.current = null;
    }
  }

  function cancelBehaviorPlayback() {
    behaviorRevision.current += 1;
    playback.cancel();
    squash.current?.cancel();
    squash.current = null;
    clearPullTension();
    setSquashing(false);
  }

  function animateSurface(surface: HTMLElement, keyframes: Keyframe[], duration: number, expandWindow: boolean) {
    if (typeof surface.animate !== "function") return;
    squash.current?.cancel();
    const animation = surface.animate(keyframes, { duration, easing: "ease-out" });
    squash.current = animation;
    if (expandWindow) setSquashing(true);
    const release = () => {
      if (squash.current !== animation) return;
      squash.current = null;
      if (expandWindow) {
        setSquashing(false);
        requestBoundsReport.current();
      }
    };
    void animation.finished?.then(release, release);
  }

  function triggerMediaSquash(media: PetMediaElement, facing: PetFacing, minScaleY = 0.84, duration = 280) {
    if (motionReduced()) return;
    const surface = media instanceof HTMLVideoElement ? petVideoPixels(media) : media;
    if (!(surface instanceof HTMLElement)) return;
    const mirror = facing === "right" ? "scaleX(-1) " : "";
    const stretchX = Number((1 + (1 - minScaleY) * 0.5).toFixed(3));
    animateSurface(surface, [
      { transform: `${mirror}scale(1, 1)`, transformOrigin: "50% 100%" },
      { transform: `${mirror}scale(${stretchX}, ${minScaleY})`, transformOrigin: "50% 100%", offset: 0.35 },
      { transform: `${mirror}scale(.97, 1.04)`, transformOrigin: "50% 100%", offset: 0.7 },
      { transform: `${mirror}scale(1, 1)`, transformOrigin: "50% 100%" },
    ], duration, true);
  }

  function triggerMediaImpact(
    media: PetMediaElement,
    edge: ContactEdge,
    speed: number,
    kind: PetImpactKind,
    mirrored: boolean,
  ) {
    if (motionReduced()) return;
    const surface = media instanceof HTMLVideoElement ? petVideoPixels(media) : media;
    if (!(surface instanceof HTMLElement)) return;
    const frame = displayedRef.current;
    const shapeBox = frame ? mediaShapes.get(mediaShapeKey(frame.assetId, frame.entry ?? "", frame.walk))?.bounds ?? null : null;
    const { keyframes, duration } = impactDeformation(edge, speed, kind, mirrored, shapeBox);
    // 碰撞瞬间不触发 setSquashing 异步改窗尺寸，避免阻塞 IPC 或与高速移动抢窗口坐标。
    animateSurface(surface, keyframes, duration, false);
  }

  function triggerCurrentImpact(edge: ContactEdge, speed: number) {
    if (motionReduced()) return;
    triggerCollisionExpression(edge, speed);
    if (!latestAsset.current) {
      const actor = petRootRef.current?.querySelector<HTMLElement>(".pet-icon-actor");
      if (!actor) return;
      const { keyframes, duration } = impactDeformation(edge, speed, "app-icon", false);
      animateSurface(actor, keyframes, duration, false);
      return;
    }
    const kind: PetImpactKind = behaviorRef.current ? "behavior" : "sprite";
    const media = petRootRef.current?.querySelector<PetMediaElement>(".pet-current");
    if (!media) return;
    const mirrored = behaviorRef.current ? facingRef.current === "right" : Boolean(displayedRef.current?.flip);
    triggerMediaImpact(media, edge, speed, kind, mirrored);
  }

  function setPullTension(pullDist: number, refWidth: number) {
    if (pullDist <= 0 || motionReduced()) {
      clearPullTension();
      return;
    }
    const media = petRootRef.current?.querySelector<PetMediaElement>(".pet-current");
    const surface = media instanceof HTMLVideoElement ? petVideoPixels(media) : media;
    if (!(surface instanceof HTMLElement)) {
      clearPullTension();
      return;
    }
    if (tensionSurface.current && tensionSurface.current !== surface) {
      tensionSurface.current.style.transform = "";
      tensionSurface.current.style.transformOrigin = "";
    }
    tensionSurface.current = surface;
    const power = Math.min(1.4, slingshotPower(pullDist, refWidth));
    const sx = (1 + power * 0.1).toFixed(3);
    const sy = Math.max(0.72, 1 - power * 0.16).toFixed(3);
    const mirror = facingRef.current === "right" ? "scaleX(-1) " : "";
    surface.style.transformOrigin = "50% 100%";
    surface.style.transform = `${mirror}scale(${sx}, ${sy})`;
  }

  function playBehavior(
    entry: string,
    facing: PetFacing,
    owner: PetPlaybackOwner,
    onReady?: (media: HTMLVideoElement) => void,
    presetPulse?: number,
  ) {
    const asset = latestAsset.current;
    if (!behaviorRef.current || !asset || (!asset.animations.includes(entry) && !isBuiltinHurtEntry(entry))) {
      return Promise.resolve("failed" as const);
    }
    behaviorRevision.current += 1;
    facingRef.current = facing;
    setBehaviorFacing(facing);
    autoAction.current = owner === "auto" ? entry : null;
    targetEntry.current = entry;
    const pulse = presetPulse ?? bumpPulse();
    if (presetPulse !== undefined) activeHitPulse.current = presetPulse;
    else activeHitPulse.current = null;
    const key = petImageFrame(asset.id, entry, false, facing === "right", pulse, owner === "hit").key;
    const result = playback.play(key, owner, (media) => {
      if (owner === "click" && behaviorRef.current?.clicks.includes(entry)) {
        triggerMediaSquash(media, facing, 0.84, 280);
      }
      onReady?.(media);
    });
    setShownEntry(entry);
    return result;
  }

  function enterSleep() {
    const profile = behaviorRef.current;
    if (!profile?.interactions.sleep || !profile.sleep || sleepRef.current) return;
    const start = pickPetEntry(profile.sleep.start);
    const loop = pickPetEntry(profile.sleep.loop);
    const end = pickPetEntry(profile.sleep.end);
    if (!start || !loop || !end) return;
    behaviorAutonomy.cancel();
    cancelBehaviorPlayback();
    cancelGravity();
    setEventEntry(null);
    setManualAction(false);
    const initial: ActiveSleep = { phase: "start", entry: start, set: { start, loop, end } };
    sleepRef.current = initial;
    setSleepState(initial);
    const completed = playBehavior(start, facingRef.current, "sleep");
    void completed.then((outcome) => {
      if (outcome === "cancelled" || sleepRef.current !== initial) return;
      const looping: ActiveSleep = { ...initial, phase: "loop", entry: loop };
      sleepRef.current = looping;
      setSleepState(looping);
      showManualEntry(loop);
    });
  }

  function wakeFromSleep() {
    const currentSleep = sleepRef.current;
    if (!currentSleep || currentSleep.phase === "end") return;
    if (currentSleep.phase === "start") {
      sleepRef.current = null;
      setSleepState(null);
      cancelBehaviorPlayback();
      switchOnClick();
      return;
    }
    const waking: ActiveSleep = { ...currentSleep, phase: "end", entry: currentSleep.set.end };
    sleepRef.current = waking;
    setSleepState(waking);
    const completed = playBehavior(currentSleep.set.end, facingRef.current, "sleep", (media) => {
      triggerMediaSquash(media, facingRef.current, 0.84, 280);
    });
    void completed.then((outcome) => {
      if (outcome === "cancelled" || sleepRef.current !== waking) return;
      sleepRef.current = null;
      setSleepState(null);
      showManualEntry(restingRef.current);
    });
  }

  function playBehaviorInteraction(
    entry: string,
    owner: "click" | "hit" = "click",
    onReady?: (media: HTMLVideoElement) => void,
    presetPulse?: number,
  ) {
    setManualAction(true);
    const completed = playBehavior(entry, facingRef.current, owner, onReady, presetPulse);
    const revision = behaviorRevision.current;
    void completed.then((outcome) => {
      if (presetPulse !== undefined && activeHitPulse.current === presetPulse) {
        activeHitPulse.current = null;
        hitPulseRef.current += 1;
        setHitPulse(hitPulseRef.current);
      }
      if (outcome === "cancelled" || revision !== behaviorRevision.current) return;
      showManualEntry(restingRef.current);
      setManualAction(false);
    });
  }

  function triggerCharacterHitClip(edge: ContactEdge, speed: number) {
    if (sleepRef.current || statusFlagsRef.current.recording || statusFlagsRef.current.shortcutsPaused) return;
    const profile = behaviorRef.current;
    if (profile) {
      // 优先命中已在后台按当前轮次预解码并跳至表情帧的受击视频，实现碰撞瞬间 0ms 变脸。
      const roll = hitRoll(hitPulseRef.current);
      const preloadedWall = pickPetHitEntry(profile, "left", restingRef.current, roll);
      const preloadedCeiling = pickPetHitEntry(profile, "ceiling", restingRef.current, roll);
      const preloadedFloor = pickPetHitEntry(profile, "floor", restingRef.current, roll);
      const entry = (edge === "floor" ? preloadedFloor : edge === "ceiling" ? preloadedCeiling : preloadedWall)
        ?? pickPetHitEntry(profile, edge, targetEntry.current);
      if (!entry) return;
      const usePreloaded = activeHitPulse.current === null &&
        (entry === preloadedWall || entry === preloadedCeiling || entry === preloadedFloor);
      const preset = usePreloaded ? hitPulseRef.current : undefined;
      playBehaviorInteraction(entry, "hit", (media) => {
        triggerMediaImpact(media, edge, speed, "behavior", facingRef.current === "right");
      }, preset);
      return;
    }
    const asset = latestAsset.current;
    if (!asset) return;
    const activeEvent = eventEntryRef.current;
    const preloadedSprite = pickHitAnimation(asset, restingRef.current, () => 0);
    const entry = preloadedSprite ?? pickHitAnimation(asset, activeEvent ? null : targetEntry.current);
    if (!entry || activeEvent === entry) return;
    window.clearTimeout(eventTimer.current);
    void petActionDuration(asset.id, entry);
    eventEntryRef.current = entry;
    if (entry === preloadedSprite && activeHitPulse.current === null) {
      activeHitPulse.current = hitPulseRef.current;
    } else {
      activeHitPulse.current = null;
      bumpPulse();
    }
    setEventEntry(entry);
  }

  function cancelBehaviorAuto() {
    playback.cancel("auto");
    if (autoAction.current && targetEntry.current === autoAction.current) {
      autoAction.current = null;
      requestEntry(restingRef.current);
    }
  }

  useEffect(
    () => () => {
      window.clearTimeout(returnTimer.current);
      window.clearTimeout(clickTimer.current);
      window.clearTimeout(eventTimer.current);
      clearHurtExpression();
      cancelPointerDrag.current?.();
      cancelBehaviorPlayback();
    },
    [],
  );

  useEffect(() => {
    const applyAppearance = (settings: Settings) => {
      const id = settings.selectedAppearanceId;
      const original = settings.petAssets.find((item) => item.id === id);
      const profile = resolvePetBehavior(original);
      const merged = original ? { ...original,
        eventActions: { ...profile?.eventActions, ...original.eventActions },
        stateActions: { ...profile?.stateActions, ...original.stateActions },
      } : undefined;
      const asset = augmentAssetWithBuiltinHurt(merged, profile?.id);
      latestAsset.current = asset ?? null;
      const key = JSON.stringify([id, asset?.path, asset?.entry, asset?.animations, asset?.layout,
        asset?.actionBounds, asset?.eventActions, asset?.stateActions, asset?.behavior]);
      if (appearanceKey.current !== key) {
        appearanceKey.current = key;
        clearHurtExpression();
        cancelBehaviorPlayback();
        behaviorRef.current = profile;
        setBehavior(profile);
        sleepRef.current = null;
        setSleepState(null);
        lastPressAtRef.current = null;
        facingRef.current = "left";
        setBehaviorFacing("left");
        setDragEntry(null);
        setManualAction(false);
        autoAction.current = null;
        window.clearTimeout(returnTimer.current);
        window.clearTimeout(clickTimer.current);
        window.clearTimeout(eventTimer.current);
        clickTimer.current = undefined;
        eventTimer.current = undefined;
        setEventEntry(null);
        setShortcutsPaused(Boolean(settings.shortcutsPaused));
        const entries = asset?.animations ?? [];
        const actions = clickableAnimations(asset);
        const nextResting = profile ? profile.idle[0] ?? null
          : asset && actions.includes(asset.entry) ? asset.entry : (actions[0] ?? null);
        actionCursor.current = Math.max(0, actions.indexOf(nextResting ?? ""));
        setAppearanceId(id);
        setAnimations(entries);
        setLayout(asset?.layout ?? null);
        setMediaShapes(loadPetMediaShapes(asset));
        setEventActions(asset?.eventActions ?? {});
        setStateActions(asset?.stateActions ?? {});
        setRestingEntry(nextResting);
        targetEntry.current = nextResting;
        setShownEntry(nextResting);
      } else {
        setShortcutsPaused(Boolean(settings.shortcutsPaused));
      }
      setPetScale(settings.petScale ?? PET_SCALE.default);
      setBaseScale(readPetBaseScale(asset));
      if (asset) void ensurePetAutoScale(asset);
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

  useEffect(() => watchPetBaseScales(() => setBaseScale(readPetBaseScale(latestAsset.current))), []);

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
      if (sleepRef.current) return;
      const asset = latestAsset.current;
      const entry = asset?.eventActions?.[event];
      if (!entry || !asset?.animations.includes(entry)) return;
      window.clearTimeout(eventTimer.current);
      if (behaviorRef.current) {
        cancelBehaviorPlayback();
        setManualAction(false);
      } else void petActionDuration(asset.id, entry);
      setEventEntry(entry);
      bumpPulse();
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
  const hasVerticalWalk = custom && !behavior && hasVerticalWalkEntries(regularAnimations);
  const walks = custom && !behavior
    ? (["left", "right", "up", "down"] as const).map((direction) => ({ direction, choice: pickWalk(regularAnimations, direction, currentEntry) }))
    : [];
  const stateEntry = (shortcutsPaused ? stateActions?.["shortcuts-paused"] : undefined) ??
    (recording ? stateActions?.recording : null);

  const autonomy = usePetAutonomy({
    enabled: !behavior && !motionReduced(),
    wander: petWander,
    gravity: petGravity,
    hasVerticalWalk: !custom || hasVerticalWalk,
    randomActions: custom && petRandomActions,
    canWalk: !custom || walks.some((walk) => Boolean(walk.choice)),
    actions: custom ? cycle.filter((entry) => entry !== resting) : [],
    paused: dragging || falling || manualAction || recording || shortcutsPaused || Boolean(stateEntry) || Boolean(eventEntry),
    setWalking,
    onAction: showAutoEntry,
    actionDuration: (entry) => petActionDuration(appearanceId, entry),
    contentBounds: () => visibleBounds.current,
    groundY: () => groundOffset.current,
    frameShift: () => frameShift.current,
  });

  const shownWalk = stateEntry || eventEntry ? null : walks.find((walk) => walk.direction === walking && walk.choice)?.direction ?? null;
  const shownChoice = walks.find((walk) => walk.direction === shownWalk)?.choice ?? null;
  const normalEntry = behavior
    ? (dragging && dragEntry ? dragEntry : sleepState ? sleepState.entry : manualAction ? currentEntry : eventEntry ?? stateEntry ?? currentEntry)
    : stateEntry ?? eventEntry ?? currentEntry;
  const isInstantHit = Boolean(
    activeHitPulse.current !== null &&
    ((behavior && (manualAction || (dragging && dragEntry && behavior.hit.includes(dragEntry)))) || (!behavior && eventEntry)),
  );
  const normalPulse = behavior && dragging && dragEntry
    ? (behavior.hit.includes(dragEntry) ? hitPulse : 0)
    : (activeHitPulse.current ?? actionPulse);
  const normalFrame = custom
    ? petImageFrame(
        appearanceId,
        normalEntry,
        false,
        Boolean(behavior && behaviorFacing === "right"),
        normalPulse,
        isInstantHit || Boolean(behavior && dragging && dragEntry && behavior.hit.includes(dragEntry)),
      )
    : null;
  if (normalFrame && behavior) {
    // usePetImages retains the displayed/leaving frame object. Keep its original
    // playback mode after the request settles; deriving loop from the current
    // request during the hand-off would restart a completed clip at frame zero.
    normalFrame.loop = !playback.matches(normalFrame.key) && normalEntry !== eventEntry;
  } else if (normalFrame && normalEntry === eventEntry && isWebmEntry(normalEntry)) {
    normalFrame.loop = false;
  }
  const dragHeldFrame = custom && behavior && dragging && (sleepState?.entry ?? stateEntry ?? resting)
    ? [petImageFrame(appearanceId, sleepState?.entry ?? stateEntry ?? resting, false, behaviorFacing === "right", 0)]
    : [];
  const spriteHitClip = custom && !behavior ? pickHitAnimation(latestAsset.current, resting, () => 0) : null;
  const behaviorPreloadHits = behavior
    ? [...new Set([
        pickPetHitEntry(behavior, "left", resting, hitRoll(hitPulse)),
        pickPetHitEntry(behavior, "ceiling", resting, hitRoll(hitPulse)),
        pickPetHitEntry(behavior, "floor", resting, hitRoll(hitPulse)),
      ].filter((item): item is string => Boolean(item)))]
    : [];
  const hitFrames = custom
    ? behavior
      ? behaviorPreloadHits.map((entry) => {
          const frame = petImageFrame(appearanceId, entry, false, behaviorFacing === "right", hitPulse, true);
          frame.loop = false;
          return frame;
        })
      : spriteHitClip
        ? (() => {
            const frame = petImageFrame(appearanceId, spriteHitClip, false, false, hitPulse, true);
            if (isWebmEntry(spriteHitClip)) frame.loop = false;
            return [frame];
          })()
        : []
    : [];
  const walkFrames = walks.flatMap(({ choice }) => choice ? [petImageFrame(appearanceId, choice.entry, true, choice.flip)] : []);
  const dragFrames = behavior?.drag.map((entry) => petImageFrame(appearanceId, entry, false, behaviorFacing === "right")) ?? [];
  const targetFrame = shownWalk && shownChoice ? petImageFrame(appearanceId, shownChoice.entry, true, shownChoice.flip) : normalFrame;
  const { frames, displayed, leaving, onReady: onPetImageReady } = usePetImages(
    targetFrame,
    [...(normalFrame ? [normalFrame] : []), ...dragHeldFrame, ...walkFrames, ...dragFrames, ...hitFrames],
  );
  const displayedRef = useRef<PetImageFrame | null>(null);
  displayedRef.current = displayed;
  const visibleEntry = displayed?.entry ?? null;
  const visibleFlip = displayed?.flip ?? false;
  const screenEdge = Math.min(window.screen.availWidth, window.screen.availHeight);
  const fittedSize = petScale === null ? null : petWindowSize(screenEdge, petScale, custom ? "pet" : "app-icon", baseScale);
  const rawPlacement = fittedSize === null ? null : viewportPlacement(fittedSize, layout, displayed, leaving, mediaShapes, squashing);
  // 拖动期间只扩大、不收缩包围盒：180ms 叠化结束时不重建原生窗口外框，松手后再收紧
  if (!dragging || fittedSize === null) {
    dragEnvelope.current = null;
  } else if (rawPlacement) {
    const place = dragEnvelope.current?.side === fittedSize
      ? coverPetPlacements(dragEnvelope.current.place, rawPlacement)
      : rawPlacement;
    dragEnvelope.current = { side: fittedSize, place };
  }
  const visiblePlacement = dragging && dragEnvelope.current?.side === fittedSize ? dragEnvelope.current.place : rawPlacement;
  const fittedGround = fittedSize === null ? null : viewportGround(fittedSize, layout, displayed, visiblePlacement);
  // On macOS, media never follows the changing alpha crop in the DOM. AppKit
  // crops/moves a fixed-size WebView instead, in the same native transaction
  // as the window; an IPC reply/flushSync cannot make two processes paint atomically.
  const renderCanvas = !hasLaunchpad && custom && fittedSize !== null ? petRenderCanvas(fittedSize, layout) : null;
  const fittedKey = fittedSize === null ? "pending" : windowKey(fittedSize, visiblePlacement, renderCanvas);

  const behaviorAutonomy = usePetBehaviorAutonomy({
    behavior,
    enabled: custom && !motionReduced(),
    paused: pressed || dragging || falling || manualAction || Boolean(sleepState) || recording || shortcutsPaused || Boolean(stateEntry) || Boolean(eventEntry),
    wander: petWander,
    gravity: petGravity,
    randomActions: petRandomActions,
    current: () => targetEntry.current,
    play: (entry, facing, onReady) => playBehavior(entry, facing, "auto", onReady),
    cancelPlayback: cancelBehaviorAuto,
    contentBounds: () => visibleBounds.current,
    groundY: () => groundOffset.current,
    frameShift: () => frameShift.current,
    canvasWidth: () => fittedSize ?? petSize,
  });

  function reportPlaybackReady() {
    const frame = displayedRef.current;
    if (!behaviorRef.current || !windowFrameReady.current || !frame || frame.assetId !== latestAsset.current?.id) return;
    const media = readyMedia.current.get(frame.key);
    if (media instanceof HTMLVideoElement) playback.ready(frame.key, media);
  }

  useLayoutEffect(() => {
    for (const [key, media] of readyMedia.current) {
      if (!media.isConnected) readyMedia.current.delete(key);
    }
    reportPlaybackReady();
  });

  useEffect(() => {
    if (recording || shortcutsPaused) clearHurtExpression();
    if (!behaviorRef.current || sleepRef.current) return;
    cancelBehaviorPlayback();
    setManualAction(false);
  }, [recording, shortcutsPaused]);

  function onBehaviorEnded(frame: PetImageFrame) {
    if (frame.key !== displayed?.key) return;
    if (!behavior) {
      if (eventEntry === frame.entry) {
        if (activeHitPulse.current !== null) {
          activeHitPulse.current = null;
          hitPulseRef.current += 1;
          setHitPulse(hitPulseRef.current);
        }
        clearHurtExpression();
        setEventEntry(null);
      }
      return;
    }
    playback.ended(frame.key);
    if (eventEntry === frame.entry) setEventEntry(null);
  }

  // 从动作真正显示到屏幕上的那一刻开始计时，完整走完一轮 GIF 后再返回待机。
  useEffect(() => {
    window.clearTimeout(returnTimer.current);
    if (behavior) return;
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
  }, [appearanceId, behavior, currentEntry, displayed?.key, manualAction, normalFrame?.key, resting]);

  useEffect(() => {
    window.clearTimeout(eventTimer.current);
    if (!eventEntry || !normalFrame || displayed?.key !== normalFrame.key) return;
    if (behavior) {
      const media = readyMedia.current.get(displayed.key);
      const duration = media instanceof HTMLVideoElement && Number.isFinite(media.duration) ? media.duration * 1000 : 0;
      eventTimer.current = window.setTimeout(() => setEventEntry(null), Math.min(120_000, Math.max(30_000, duration * 2 + 5000)));
      return () => window.clearTimeout(eventTimer.current);
    }
    let cancelled = false;
    void petActionDuration(appearanceId, eventEntry).then((duration) => {
      if (cancelled) return;
      eventTimer.current = window.setTimeout(() => {
        if (!cancelled) {
          if (activeHitPulse.current !== null) {
            activeHitPulse.current = null;
            hitPulseRef.current += 1;
            setHitPulse(hitPulseRef.current);
          }
          clearHurtExpression();
          setEventEntry(null);
        }
      }, duration);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(eventTimer.current);
    };
  }, [appearanceId, behavior, displayed?.key, eventEntry, normalFrame?.key]);

  function cancelGravity() {
    gravityToken.current += 1;
    cancelAnimationFrame(gravityFrame.current);
    flyingRef.current = false;
    setFalling(false);
  }

  function computeThrowBounds(originNormal: { x: number; y: number }, geometry: DragGeometry): ThrowBounds {
    const scale = geometry.scale > 0 ? geometry.scale : 1;
    const shift = frameShift.current;
    const currentOuter = { x: originNormal.x + shift.x, y: originNormal.y + shift.y };
    const hLimits = petHorizontalLimits(geometry.areas, currentOuter, geometry.size, visibleBounds.current, scale);
    const minX = hLimits ? (hLimits.minX - shift.x) / scale : originNormal.x / scale - 2000;
    const maxX = Math.max(minX, hLimits ? (hLimits.maxX - shift.x) / scale : originNormal.x / scale + 2000);
    const minY = geometry.ceilingY !== null ? (geometry.ceilingY - shift.y) / scale : originNormal.y / scale - 2000;
    const maxY = Math.max(minY, geometry.floorY !== null ? (geometry.floorY - shift.y) / scale : originNormal.y / scale + 2000);
    return { minX, maxX, minY, maxY };
  }

  function launchThrow(
    originNormal: { x: number; y: number },
    vx: number,
    vy: number,
    geometry: DragGeometry,
    initialAway?: Partial<Record<ContactEdge, boolean>>,
  ) {
    const petWindow = getCurrentWindow();
    const token = ++gravityToken.current;
    cancelAnimationFrame(gravityFrame.current);
    const scale = geometry.scale > 0 ? geometry.scale : 1;
    const bounds = computeThrowBounds(originNormal, geometry);

    if (motionReduced()) {
      const restY = gravityEnabled.current ? bounds.maxY : Math.min(bounds.maxY, Math.max(bounds.minY, originNormal.y / scale));
      const restX = Math.min(bounds.maxX, Math.max(bounds.minX, originNormal.x / scale));
      void petWindow.setPosition(new PhysicalPosition(
        Math.round(restX * scale + frameShift.current.x),
        Math.round(restY * scale + frameShift.current.y),
      )).catch(() => {});
      return;
    }

    const syncFacing = (nextVx: number) => {
      if (Math.abs(nextVx) > 30 && !sleepRef.current && !playback.active()) {
        const nextFacing: PetFacing = nextVx > 0 ? "right" : "left";
        if (facingRef.current !== nextFacing) {
          facingRef.current = nextFacing;
          setBehaviorFacing(nextFacing);
        }
      }
    };
    syncFacing(vx);

    flyingRef.current = true;
    setFalling(true);
    let state = { x: originNormal.x / scale, y: originNormal.y / scale, vx, vy };
    let previous = performance.now();
    let lastSquashAt = -Infinity;
    let hitClipTriggered = false;
    const awayMargin = 36;
    const approachedFromAway: Record<ContactEdge, boolean> = {
      left: Boolean(initialAway?.left) || state.x > bounds.minX + awayMargin,
      right: Boolean(initialAway?.right) || state.x < bounds.maxX - awayMargin,
      ceiling: Boolean(initialAway?.ceiling) || state.y > bounds.minY + awayMargin,
      floor: Boolean(initialAway?.floor) || state.y < bounds.maxY - awayMargin,
    };
    let writing = false;

    const step = (now: number) => {
      if (token !== gravityToken.current || pointerHeld.current) {
        if (token === gravityToken.current) {
          flyingRef.current = false;
          setFalling(false);
        }
        return;
      }
      const dt = (now - previous) / 1000;
      previous = now;
      const next = stepThrow(state, dt, bounds, gravityEnabled.current);
      state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy };
      if (state.x > bounds.minX + awayMargin) approachedFromAway.left = true;
      if (state.x < bounds.maxX - awayMargin) approachedFromAway.right = true;
      if (state.y > bounds.minY + awayMargin) approachedFromAway.ceiling = true;
      if (state.y < bounds.maxY - awayMargin) approachedFromAway.floor = true;
      if (next.bounced) syncFacing(state.vx);
      if (!writing || next.atRest) {
        writing = true;
        void petWindow.setPosition(new PhysicalPosition(
          Math.round(state.x * scale + frameShift.current.x),
          Math.round(state.y * scale + frameShift.current.y),
        )).catch(() => {}).finally(() => { writing = false; });
      }
      if (next.hit && approachedFromAway[next.hit.edge] && (next.hit.edge === "floor" ? next.hit.speed >= 260 : next.hit.speed >= 300)) {
        approachedFromAway[next.hit.edge] = false;
        if (now - lastSquashAt >= 120) {
          lastSquashAt = now;
          triggerCurrentImpact(next.hit.edge, next.hit.speed);
        }
        if (!hitClipTriggered && next.hit.speed >= HIT_ACTION_MIN_SPEED) {
          hitClipTriggered = true;
          triggerCharacterHitClip(next.hit.edge, next.hit.speed);
        }
      }
      if (next.atRest) {
        flyingRef.current = false;
        setFalling(false);
        return;
      }
      gravityFrame.current = requestAnimationFrame(step);
    };
    gravityFrame.current = requestAnimationFrame(step);
  }

  async function dropToFloor(canMove = () => true, allowImpact = true) {
    const petWindow = getCurrentWindow();
    const token = ++gravityToken.current;
    const shift = { ...frameShift.current };
    const [monitor, position, size, scale] = await Promise.all([
      currentMonitor(),
      petWindow.outerPosition(),
      petWindow.outerSize(),
      petWindow.scaleFactor(),
    ]);
    if (!monitor || token !== gravityToken.current || !canMove()) return;
    const { position: origin } = monitor.workArea;
    const floor = petFloorY(monitor.workArea, size.height, visibleBounds.current, scale, groundOffset.current);
    if (floor === null) return;
    // 重力只负责竖直落地；横向已在拖动或素材尺寸校准时限制。
    const x = position.x;
    let y = Math.min(floor, Math.max(origin.y, position.y));
    if (x !== position.x || y !== position.y) {
      await petWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
    }
    if (!gravityEnabled.current || y >= floor) return;
    if (motionReduced()) {
      await petWindow.setPosition(new PhysicalPosition(x, floor)).catch(() => {});
      return;
    }

    const dropDistance = (floor - y) / (scale > 0 ? scale : 1);
    setFalling(true);
    let velocity = 0;
    let previous = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        if (token !== gravityToken.current || !gravityEnabled.current || !canMove()) {
          resolve();
          return;
        }
        const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
        previous = now;
        velocity += 2600 * scale * dt;
        y += velocity * dt;
        const landed = y >= floor;
        if (landed) y = floor;
        void petWindow.setPosition(new PhysicalPosition(
          Math.round(x + frameShift.current.x - shift.x), Math.round(y + frameShift.current.y - shift.y),
        )).catch(() => {});
        if (landed) {
          if (allowImpact && dropDistance >= 120) {
            const impactSpeed = velocity / scale;
            if (impactSpeed >= 420) triggerCurrentImpact("floor", impactSpeed);
            if (impactSpeed >= 520) triggerCharacterHitClip("floor", impactSpeed);
          }
          resolve();
        } else {
          gravityFrame.current = requestAnimationFrame(step);
        }
      };
      gravityFrame.current = requestAnimationFrame(step);
    });
    if (token === gravityToken.current) setFalling(false);
  }

  async function fitOnScreen(content: MediaBounds | null, canMove: () => boolean) {
    await keepOnScreen(getCurrentWindow(), content, true, canMove, groundOffset.current);
    if (canMove() && gravityEnabled.current) {
      // 校准改变了 x 或窗口尺寸时，正在进行的下落不能继续写入旧坐标；尺寸微调绝不触发受击动作。
      cancelGravity();
      void dropToFloor(canMove, false).catch(() => {});
    }
  }

  finishDrag.current = () => {
    const revision = positionRevision.current;
    const canMove = () => revision === positionRevision.current && !pointerHeld.current;
    if (gravityEnabled.current) void dropToFloor(canMove).catch(() => {});
    else void keepOnScreen(getCurrentWindow(), visibleBounds.current, false, canMove, groundOffset.current).catch(() => {});
  };

  useEffect(() => {
    if (petScale === null) return;
    cancelGravity();
    if (petGravity) void dropToFloor().catch(() => {});
  }, [petGravity, petScale, baseScale]);

  useEffect(
    () => () => {
      gravityToken.current += 1;
      cancelAnimationFrame(gravityFrame.current);
    },
    [],
  );

  // 物理像素。紧致窗口相对虚拟画布的偏移；存位置和拖动都使用未裁切的稳定原点。
  const frameShift = useRef({ x: 0, y: 0 });
  const viewOffset = useRef({ x: 0, y: 0 });
  const appliedKey = useRef("");
  const appliedDragPlace = useRef<{ side: number; place: PetPlacement } | null>(null);
  const frameModel = useRef({ appearanceId, petScale, baseScale, custom, layout, displayed, leaving, mediaShapes, squashing, dragging });
  frameModel.current = { appearanceId, petScale, baseScale, custom, layout, displayed, leaving, mediaShapes, squashing, dragging };
  const frameApplying = useRef(false);
  const frameAgain = useRef(false);
  const frameFromNonMove = useRef(false);

  useLayoutEffect(() => {
    if (fittedSize === null || petScale === null) return;
    const petWindow = getCurrentWindow();
    let active = true;
    const apply = async (fromMove = false) => {
      if (!fromMove) frameFromNonMove.current = true;
      if (frameApplying.current) {
        frameAgain.current = true;
        return;
      }
      frameApplying.current = true;
      try {
        do {
          const forceReport = frameFromNonMove.current;
          frameFromNonMove.current = false;
          frameAgain.current = false;
          const model = frameModel.current;
          if (model.petScale === null) return;
          const shortEdge = Math.min(window.screen.availWidth, window.screen.availHeight);
          const side = petWindowSize(shortEdge, model.petScale, model.custom ? "pet" : "app-icon", model.baseScale);
          if (active) setPetSize(side);
          const rawPlace = viewportPlacement(side, model.layout, model.displayed, model.leaving, model.mediaShapes, model.squashing);
          if (!model.dragging) {
            appliedDragPlace.current = null;
          } else if (rawPlace) {
            appliedDragPlace.current = {
              side,
              place: appliedDragPlace.current?.side === side
                ? coverPetPlacements(appliedDragPlace.current.place, rawPlace)
                : rawPlace,
            };
          }
          const place = model.dragging && appliedDragPlace.current?.side === side ? appliedDragPlace.current.place : rawPlace;
          const groundY = viewportGround(side, model.layout, model.displayed, place);
          const canvas = !hasLaunchpad && model.custom ? petRenderCanvas(side, model.layout) : null;
          const key = windowKey(side, place, canvas);
          const appearance = `${model.appearanceId}|${side}`;
          if (appearance !== fittedAppearance.current) {
            fittedAppearance.current = appearance;
            visibleBounds.current = null;
            needsHorizontalFit.current = !pointerHeld.current;
          }
          if (key === appliedKey.current) {
            groundOffset.current = groundY;
            if (place && model.displayed) visibleBounds.current = viewportContent(place, model.displayed, model.mediaShapes);
            if (forceReport) requestBoundsReport.current();
            continue;
          }
          appliedKey.current = key;
          windowFrameReady.current = false;
          const offset = await commitPetWindow(
            petWindow, side, place, frameShift, t, groundY, () => !pointerHeld.current, canvas, () => dragNormalPosition.current?.() ?? null,
          );
          viewOffset.current = offset ?? { x: 0, y: 0 };
          if (appliedKey.current === key) {
            groundOffset.current = groundY;
            if (place && model.displayed) visibleBounds.current = viewportContent(place, model.displayed, model.mediaShapes);
            windowFrameReady.current = true;
            reframeDrag.current();
            reportPlaybackReady();
            if (!model.custom && needsHorizontalFit.current && !pointerHeld.current) {
              needsHorizontalFit.current = false;
              const revision = positionRevision.current;
              await fitOnScreen(null, () => revision === positionRevision.current && !pointerHeld.current);
            }
            requestBoundsReport.current();
          }
        } while (frameAgain.current);
      } catch (error) {
        appliedKey.current = "";
        console.error("snapshot: pet window resize failed", error);
      } finally {
        frameApplying.current = false;
      }
    };

    void apply();
    const movedListener = petWindow.onMoved(() => {
      void apply(true);
    });
    const scaleListener = petWindow.onScaleChanged(() => {
      void apply();
    });
    return () => {
      active = false;
      void movedListener.then((unlisten) => unlisten());
      void scaleListener.then((unlisten) => unlisten());
    };
  }, [appearanceId, fittedSize, petScale, fittedKey, fittedGround, t]);

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    cancelPointerDrag.current?.();
    pointerHeld.current = true;
    setPressed(true);
    positionRevision.current += 1;
    needsHorizontalFit.current = false;
    const profile = behaviorRef.current;
    const pressNow = performance.now();
    const wasFlying = flyingRef.current;
    const hasDoubleGesture = Boolean(profile && (profile.interactions.slingshot || profile.interactions.sleep));
    const isDoublePress = hasDoubleGesture && lastPressAtRef.current !== null && pressNow - lastPressAtRef.current <= SLINGSHOT_DOUBLE_MS;
    lastPressAtRef.current = isDoublePress ? null : pressNow;
    const sling = isDoublePress && Boolean(profile?.interactions.slingshot) && !sleepRef.current;

    autonomy.cancel();
    if (profile) {
      behaviorAutonomy.cancel();
      if (!sleepRef.current) {
        cancelBehaviorPlayback();
        setEventEntry(null);
      }
    }
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
    // 拖动记录虚拟画布的原点。动作/alpha 外框改变窗口偏移时，鼠标抓住的仍是同一只宠物。
    const dragShift = { ...frameShift.current };
    let placedShift = { ...dragShift };
    let lastScreenX = startScreenX;
    let lastScreenY = startScreenY;
    let geometry: DragGeometry | null = null;
    let target: { x: number; y: number } | null = null;
    let trail: PointerSample[] = [{ t: pressNow, x: startScreenX, y: startScreenY }];
    const armedEdges: Record<ContactEdge, boolean> = { left: false, right: false, ceiling: false, floor: false };
    const visitedAway: Record<ContactEdge, boolean> = { left: false, right: false, ceiling: false, floor: false };
    let lastDragHitAt = -Infinity;
    let dragHitTimer: number | undefined;
    let heldWallHit: { edge: ContactEdge; speed: number; clip: string | null; at: number } | null = null;
    let frame = 0;
    let finished = false;
    const moved = { x: startScreenX, y: startScreenY };

    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // 老 WebView 没实现指针捕获时仍可继续用窗口级监听。
    }

    const cleanup = () => {
      if (cancelPointerDrag.current === dispose) cancelPointerDrag.current = null;
      if (reframeDrag.current === reframe) reframeDrag.current = () => {};
      if (dragNormalPosition.current === liveNormalPosition) dragNormalPosition.current = null;
      window.removeEventListener("pointermove", markDrag);
      window.removeEventListener("pointerup", finishPress);
      window.removeEventListener("pointercancel", cancelPress);
      element.removeEventListener("lostpointercapture", loseCapture);
      window.clearTimeout(dragHitTimer);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      setPullTension(0, fittedSize ?? petSize);
      try {
        if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // 窗口已经失去捕获时，释放会抛错，可以直接忽略。
      }
    };

    const dispose = () => {
      finished = true;
      pointerHeld.current = false;
      cleanup();
    };
    cancelPointerDrag.current = dispose;

    const placeTarget = () => {
      if (finished || !geometry || !target) return;
      const previousX = moved.x;
      const previousY = moved.y;
      const allowVerticalWalk = !custom || (hasVerticalWalk && !gravityEnabled.current);
      const next = nextDragWalk(dragMotion.current, target.x - previousX, target.y - previousY, allowVerticalWalk);
      moved.x = target.x;
      moved.y = target.y;
      if (next && !behaviorRef.current) {
        dragMotion.current = next;
        setWalking(next.direction);
      }
      const shift = frameShift.current;
      const x = Math.round(target.x + shift.x);
      const y = Math.round(target.y + shift.y);
      if (Math.round(target.x) === Math.round(previousX) && Math.round(target.y) === Math.round(previousY) &&
        shift.x === placedShift.x && shift.y === placedShift.y) return;
      placedShift = { ...shift };
      void petWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
    };

    const schedulePlace = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeTarget();
      });
    };

    const detectHeldWallHit = (screenX: number, screenY: number, now: number) => {
      if (!geometry || sling || sleepRef.current) return;
      const armMargin = 48 * geometry.scale;
      const rawX = geometry.position.x + (screenX - startScreenX) * geometry.scale;
      const rawY = geometry.position.y + (screenY - startScreenY) * geometry.scale;
      const clampedY = geometry.floorY === null ? rawY : Math.min(rawY, geometry.floorY);
      const hLimits = petHorizontalLimits(geometry.areas, { x: rawX, y: clampedY }, geometry.size, geometry.content, geometry.scale);
      if (hLimits) {
        if (rawX > hLimits.minX + armMargin) { armedEdges.left = true; visitedAway.left = true; }
        if (rawX < hLimits.maxX - armMargin) { armedEdges.right = true; visitedAway.right = true; }
      }
      if (geometry.ceilingY !== null && rawY > geometry.ceilingY + armMargin) { armedEdges.ceiling = true; visitedAway.ceiling = true; }
      if (geometry.floorY !== null && rawY < geometry.floorY - armMargin) { armedEdges.floor = true; visitedAway.floor = true; }

      const recent = trail.filter((item) => now - item.t <= 110);
      if (recent.length < 2) return;
      const first = recent[0];
      const dtMs = now - first.t;
      if (dtMs < 10 || now - lastDragHitAt < 450) return;
      const dx = screenX - first.x;
      const dy = screenY - first.y;
      const vxPerp = (Math.abs(dx) / dtMs) * 1000;
      const vyPerp = (Math.abs(dy) / dtMs) * 1000;

      let hitEdge: ContactEdge | null = null;
      let perpSpeed = 0;
      if (hLimits && armedEdges.left && dx < -18 && vxPerp >= 420 && rawX <= hLimits.minX + 1.5) {
        hitEdge = "left";
        perpSpeed = vxPerp;
        armedEdges.left = false;
      } else if (hLimits && armedEdges.right && dx > 18 && vxPerp >= 420 && rawX >= hLimits.maxX - 1.5) {
        hitEdge = "right";
        perpSpeed = vxPerp;
        armedEdges.right = false;
      } else if (geometry.ceilingY !== null && armedEdges.ceiling && dy < -18 && vyPerp >= 420 && rawY <= geometry.ceilingY + 1.5) {
        hitEdge = "ceiling";
        perpSpeed = vyPerp;
        armedEdges.ceiling = false;
      } else if (geometry.floorY !== null && armedEdges.floor && dy > 18 && vyPerp >= 420 && rawY >= geometry.floorY - 1.5) {
        hitEdge = "floor";
        perpSpeed = vyPerp;
        armedEdges.floor = false;
      }
      if (!hitEdge) return;

      lastDragHitAt = now;
      const effectiveSpeed = Math.max(perpSpeed * 1.35, 540);
      triggerCurrentImpact(hitEdge, effectiveSpeed);
      if (behaviorRef.current) {
        const roll = hitRoll(hitPulseRef.current);
        const hitClip = (hitEdge === "floor"
          ? pickPetHitEntry(behaviorRef.current, "floor", restingRef.current, roll)
          : hitEdge === "ceiling"
            ? pickPetHitEntry(behaviorRef.current, "ceiling", restingRef.current, roll)
            : pickPetHitEntry(behaviorRef.current, "left", restingRef.current, roll))
          ?? pickPetHitEntry(behaviorRef.current, hitEdge, targetEntry.current);
        if (hitClip) {
          window.clearTimeout(dragHitTimer);
          heldWallHit = { edge: hitEdge, speed: effectiveSpeed, clip: hitClip, at: now };
          activeHitPulse.current = hitPulseRef.current;
          setDragEntry(hitClip);
          dragHitTimer = window.setTimeout(() => {
            heldWallHit = null;
            activeHitPulse.current = null;
            hitPulseRef.current += 1;
            setHitPulse(hitPulseRef.current);
            if (!finished && dragged.current && behaviorRef.current && !sleepRef.current) {
              setDragEntry(pickPetEntry(behaviorRef.current.drag, hitClip));
            }
          }, 2200);
        }
      } else {
        triggerCharacterHitClip(hitEdge, effectiveSpeed);
      }
    };

    const clampTarget = (screenX: number, screenY: number) => {
      if (!geometry) return null;
      const rawX = geometry.position.x + (screenX - startScreenX) * geometry.scale;
      const rawY = geometry.position.y + (screenY - startScreenY) * geometry.scale;
      // 透明留白可以跨过 Dock，只有角色脚底到达工作区底边时才停止。
      const y = geometry.floorY === null ? rawY : Math.min(rawY, geometry.floorY);
      const position = { x: rawX, y };
      const x = clampPetX(rawX, petHorizontalLimits(geometry.areas, position, geometry.size, geometry.content, geometry.scale));
      return { x: x - dragShift.x, y: y - dragShift.y };
    };

    const reframe = () => {
      if (finished || !dragged.current || !geometry) return;
      target = clampTarget(lastScreenX, lastScreenY);
      schedulePlace();
    };
    reframeDrag.current = reframe;

    const liveNormalPosition = () => {
      if (finished || !dragged.current || !geometry) return null;
      return clampTarget(lastScreenX, lastScreenY);
    };
    dragNormalPosition.current = liveNormalPosition;

    const startMoving = () => {
      if (dragged.current) return;
      dragged.current = true;
      setDragging(true);
      if (behaviorRef.current && !sleepRef.current) {
        setDragEntry(pickPetEntry(behaviorRef.current.drag, targetEntry.current));
      }
      window.clearTimeout(clickTimer.current);
      clickTimer.current = undefined;
      dragMotion.current = STANDING;
      moved.x = geometry ? geometry.position.x - dragShift.x : startScreenX;
      moved.y = geometry ? geometry.position.y - dragShift.y : startScreenY;
    };

    const markDrag = (move: PointerEvent) => {
      if (finished || move.pointerId !== pointerId) return;
      lastScreenX = move.screenX;
      lastScreenY = move.screenY;
      if (!dragged.current) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < (behaviorRef.current ? 5 : 4)) return;
        startMoving();
      }
      const now = performance.now();
      trail = trimPointerTrail([...trail, { t: now, x: move.screenX, y: move.screenY }], now);
      if (sling) {
        setPullTension(Math.hypot(move.screenX - startScreenX, move.screenY - startScreenY), fittedSize ?? petSize);
      }
      if (!geometry) return;
      detectHeldWallHit(lastScreenX, lastScreenY, now);
      target = clampTarget(lastScreenX, lastScreenY);
      schedulePlace();
    };

    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      pointerHeld.current = false;
      setPressed(false);
      cleanup();
      if (!dragged.current) {
        if (cancelled) return;
        clearHurtExpression();
        if (!behaviorRef.current && eventEntryRef.current && isBuiltinHurtEntry(eventEntryRef.current)) {
          window.clearTimeout(eventTimer.current);
          eventEntryRef.current = null;
          activeHitPulse.current = null;
          setEventEntry(null);
        }
        if (wasFlying) {
          // 飞行途中点中 = 空中接住停稳，不触发普通点击动作，若开启重力则自然落地
          if (behaviorRef.current && !sleepRef.current) showManualEntry(restingRef.current);
          const revision = positionRevision.current;
          if (gravityEnabled.current) {
            void dropToFloor(() => revision === positionRevision.current && !pointerHeld.current, false).catch(() => {});
          }
          return;
        }
        if (sleepRef.current) {
          wakeFromSleep();
          return;
        }
        const interceptsDoubleClick = Boolean(behaviorRef.current?.interactions.sleep && behaviorRef.current.sleep);
        if (isDoublePress && interceptsDoubleClick) {
          enterSleep();
          return;
        }
        if (!hasLaunchpad || interceptsDoubleClick) {
          switchOnClick();
          return;
        }
        if (clickTimer.current !== undefined) {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = undefined;
          if (behaviorRef.current) {
            cancelBehaviorPlayback();
            setManualAction(false);
            showManualEntry(restingRef.current);
          }
          void showLaunchpad(event.screenX, event.screenY);
          return;
        }
        if (behaviorRef.current) {
          switchOnClick();
          clickTimer.current = window.setTimeout(() => { clickTimer.current = undefined; }, CLICK_DELAY_MS);
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
      setDragEntry(null);
      dragMotion.current = STANDING;
      const releaseNow = performance.now();
      const pendingWallHit = !cancelled && heldWallHit && releaseNow - heldWallHit.at <= 1800 ? heldWallHit : null;

      const canThrow = behaviorRef.current ? behaviorRef.current.interactions.throw : true;
      if (!cancelled && geometry && target && !sleepRef.current) {
        if (sling && behaviorRef.current) {
          const launch = slingshotLaunchVelocity(
            lastScreenX - startScreenX,
            lastScreenY - startScreenY,
            fittedSize ?? petSize,
          );
          if (launch) {
            if (behaviorRef.current) showManualEntry(restingRef.current);
            launchThrow(target, launch.vx, launch.vy, geometry, visitedAway);
            return;
          }
        } else if (canThrow) {
          const rawVelocity = estimateThrowVelocity(trail, releaseNow);
          if (rawVelocity) {
            const scale = geometry.scale > 0 ? geometry.scale : 1;
            const bounds = computeThrowBounds(target, geometry);
            const { velocity: clamped, blockedHit } = clampLaunchAtBounds(
              { x: target.x / scale, y: target.y / scale },
              rawVelocity,
              bounds,
            );
            if (clamped) {
              if (behaviorRef.current) showManualEntry(restingRef.current);
              launchThrow(target, clamped.vx, clamped.vy, geometry, visitedAway);
              return;
            }
            if (blockedHit && !pendingWallHit && visitedAway[blockedHit.edge] && blockedHit.speed >= 420) {
              triggerCurrentImpact(blockedHit.edge, blockedHit.speed);
              triggerCharacterHitClip(blockedHit.edge, blockedHit.speed);
              const revision = positionRevision.current;
              const landing = petWindow.setPosition(new PhysicalPosition(Math.round(target.x + frameShift.current.x), Math.round(target.y + frameShift.current.y))).catch(() => {});
              void landing.then(() => {
                if (revision === positionRevision.current && !pointerHeld.current) finishDrag.current();
              });
              return;
            }
          }
        }
      }

      if (behaviorRef.current && !sleepRef.current) {
        if (pendingWallHit?.clip) {
          playBehaviorInteraction(pendingWallHit.clip, "hit", undefined, activeHitPulse.current ?? undefined);
        } else {
          showManualEntry(restingRef.current);
        }
      }

      const revision = positionRevision.current;
      const landing = target && geometry
        ? petWindow.setPosition(new PhysicalPosition(Math.round(target.x + frameShift.current.x), Math.round(target.y + frameShift.current.y))).catch(() => {})
        : Promise.resolve();
      void landing.then(() => {
        if (revision === positionRevision.current && !pointerHeld.current) finishDrag.current();
      });
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

    void readDragGeometry(petWindow, visibleBounds.current, groundOffset.current).then((result) => {
      if (finished) return;
      geometry = result;
      if (geometry) {
        const armMargin = 48 * geometry.scale;
        const hLimits = petHorizontalLimits(geometry.areas, geometry.position, geometry.size, geometry.content, geometry.scale);
        if (hLimits) {
          armedEdges.left = visitedAway.left = geometry.position.x > hLimits.minX + armMargin;
          armedEdges.right = visitedAway.right = geometry.position.x < hLimits.maxX - armMargin;
        }
        if (geometry.ceilingY !== null) armedEdges.ceiling = visitedAway.ceiling = geometry.position.y > geometry.ceilingY + armMargin;
        if (geometry.floorY !== null) armedEdges.floor = visitedAway.floor = geometry.position.y < geometry.floorY - armMargin;
      }
      if (dragged.current && geometry) {
        moved.x = geometry.position.x - dragShift.x;
        moved.y = geometry.position.y - dragShift.y;
        target = clampTarget(lastScreenX, lastScreenY);
        schedulePlace();
      }
    }).catch(() => {});
  }

  // 平时停在默认待机。点一下换到下一个非走路动作，完整播放一轮后回到待机。
  function switchOnClick() {
    const profile = behaviorRef.current;
    if (profile) {
      const entry = pickPetEntry(profile.clicks, targetEntry.current);
      if (!entry) return;
      playBehaviorInteraction(entry);
      return;
    }
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
  const framedStyle = (entry: string, flip: boolean, walk: boolean) => {
    if (fittedSize === null || !visiblePlacement) return undefined;
    const shape = mediaShapes.get(JSON.stringify([appearanceId, entry, walk]));
    const place = placementForEntry(fittedSize, layout, entry, flip) ??
      (shape ? mediaPlacement(fittedSize, shape.width, shape.height) : null);
    if (!place) return undefined;
    return {
      left: place.imageX - (renderCanvas?.left ?? visiblePlacement.shiftX),
      top: place.imageY - (renderCanvas?.top ?? visiblePlacement.shiftY),
      width: place.imageWidth,
      height: place.imageHeight,
    };
  };
  const framed = visiblePlacement != null;

  // 测量 alpha 并缓存每个动作的外框；原生窗口和输入命中区都围住实际形象。
  useLayoutEffect(() => {
    const root = petRootRef.current;
    if (!root) return;
    const displayedFrame = displayed;
    let animationFrame = 0;
    let videoFrame = 0;
    let observer: ResizeObserver | null = null;
    let alphaBounds: MediaBounds | null = null;
    let lastHitbox = "";
    let lastScan = 0;
    let alphaScanUnavailable = false;
    let videoObservedFromStart: boolean | null = null;
    let videoWasPlayed = false;
    let videoEnded = false;
    let lastVideoTime: number | null = null;
    const initialShape = displayedFrame
      ? mediaShapes.get(mediaShapeKey(displayedFrame.assetId, displayedFrame.entry ?? "", displayedFrame.walk))
      : null;
    let videoCommitted = Boolean(initialShape?.bounds);

    const send = (bounds: { left: number; top: number; width: number; height: number }) => {
      const key = [bounds.left, bounds.top, bounds.width, bounds.height].map(Math.round).join("/");
      if (key === lastHitbox) return;
      lastHitbox = key;
      void setPetHitbox(bounds.left, bounds.top, bounds.width, bounds.height).catch(() => {});
    };

    const scanAlpha = (media: PetMediaElement, content: { left: number; top: number; width: number; height: number }) => {
      if (alphaScanUnavailable) return null;
      try {
        const sample = readAlpha(media);
        if (!sample) return null;
        alphaBounds = unionMediaBounds(alphaBounds, sample);
        return {
          left: content.left + (visibleFlip ? 1 - alphaBounds.left - alphaBounds.width : alphaBounds.left) * content.width,
          top: content.top + alphaBounds.top * content.height,
          width: alphaBounds.width * content.width,
          height: alphaBounds.height * content.height,
        };
      } catch {
        // 老 WebView 或跨域限制读不到像素时，退回整块媒体矩形。
        alphaScanUnavailable = true;
        return null;
      }
    };

    const commitCompleteVideo = (media: HTMLVideoElement) => {
      if (videoCommitted || !videoObservedFromStart || !alphaBounds || !displayedFrame) return;
      videoCommitted = true;
      rememberCompleteMediaShape(displayedFrame, media, alphaBounds);
    };

    const report = () => {
      if (!custom) {
        visibleBounds.current = null;
        lastHitbox = "";
        void setPetHitbox(0, 0, 0, 0).catch(() => {});
        return;
      }
      const media = root.querySelector<PetMediaElement>(".pet-current");
      if (!media) {
        visibleBounds.current = null;
        lastHitbox = "";
        void setPetHitbox(0, 0, 0, 0).catch(() => {});
        return;
      }
      const pixels = media instanceof HTMLVideoElement ? petVideoPixels(media) : media;
      const rect = (pixels instanceof HTMLElement ? pixels : media).getBoundingClientRect();
      // DOM coordinates are relative to the stable WebView, not the cropped
      // native window. Drag/floor limits and hit boxes still use window space.
      const box = { left: rect.left + viewOffset.current.x, top: rect.top + viewOffset.current.y,
        width: rect.width, height: rect.height };
      const naturalWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
      const naturalHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
      const content = framed
        ? { left: box.left, top: box.top, width: box.width, height: box.height }
        : containedMediaBounds(box, naturalWidth, naturalHeight);
      if (!content || !(content.width > 0) || !(content.height > 0)) {
        visibleBounds.current = null;
        lastHitbox = "";
        void setPetHitbox(0, 0, 0, 0).catch(() => {});
        return;
      }
      const scanned = scanAlpha(media, content);
      if (media instanceof HTMLVideoElement) {
        const currentTime = media.currentTime;
        const duration = media.duration;
        if (videoObservedFromStart === null) {
          videoObservedFromStart = currentTime <= 0.15 &&
            typeof media.requestVideoFrameCallback === "function";
        }
        if (currentTime > 0.02) videoWasPlayed = true;
        const wrapped = videoWasPlayed && lastVideoTime !== null && currentTime + 0.05 < lastVideoTime;
        const reachedEnd = videoEnded || media.ended ||
          (Number.isFinite(duration) && duration > 0 && currentTime >= duration - 0.02);
        if (wrapped || reachedEnd) commitCompleteVideo(media);
        lastVideoTime = currentTime;
      }
      const measured = scanned ?? content;
      visibleBounds.current = measured;
      send(measured);
      // 只在导入、切换形象或调整大小后校准一次；动画呼吸和松手不会重新推挤位置。
      const measuredVideo = !(media instanceof HTMLVideoElement) || scanned || alphaScanUnavailable ||
        typeof media.requestVideoFrameCallback !== "function";
      if (needsHorizontalFit.current && windowFrameReady.current && !pointerHeld.current && measuredVideo) {
        needsHorizontalFit.current = false;
        const revision = positionRevision.current;
        const appearance = fittedAppearance.current;
        void fitOnScreen(measured,
          () => revision === positionRevision.current && appearance === fittedAppearance.current && !pointerHeld.current).catch(() => {});
      }
    };

    const schedule = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(report);
    };

    requestBoundsReport.current = schedule;
    // Read the ready frame synchronously before playback advances. This makes
    // the first-frame sample part of the complete WebM envelope.
    report();
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(root);
      const media = root.querySelector<PetMediaElement>(".pet-current");
      if (media) observer.observe(media);
    }
    const media = root.querySelector<PetMediaElement>(".pet-current");
    const onVideoEnded = () => {
      videoEnded = true;
      report();
    };
    if (media instanceof HTMLVideoElement) media.addEventListener("ended", onVideoEnded);
    if (media instanceof HTMLVideoElement && typeof media.requestVideoFrameCallback === "function") {
      const scanFrame = (now: number) => {
        // Before an action has a complete envelope, inspect every presented
        // frame so a one-frame effect cannot disappear from the measured union.
        if (!videoCommitted || now - lastScan >= 100) {
          lastScan = now;
          report();
        }
        videoFrame = media.requestVideoFrameCallback(scanFrame);
      };
      videoFrame = media.requestVideoFrameCallback(scanFrame);
    }
    const scanTimer = custom && !(media instanceof HTMLVideoElement && typeof media.requestVideoFrameCallback === "function")
      ? window.setInterval(report, 100) : undefined;
    window.addEventListener("resize", schedule);
    return () => {
      if (requestBoundsReport.current === schedule) requestBoundsReport.current = () => {};
      cancelAnimationFrame(animationFrame);
      if (media instanceof HTMLVideoElement && typeof media.cancelVideoFrameCallback === "function") {
        media.cancelVideoFrameCallback(videoFrame);
      }
      if (media instanceof HTMLVideoElement) media.removeEventListener("ended", onVideoEnded);
      observer?.disconnect();
      window.clearInterval(scanTimer);
      window.removeEventListener("resize", schedule);
    };
  }, [custom, displayed?.key, fittedKey, framed, visibleFlip]);

  useEffect(() => () => {
    void setPetHitbox(0, 0, 0, 0).catch(() => {});
  }, []);

  function onContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    // 菜单入口只打开功能窗口，当前媒体节点、播放进度和动作收尾继续由各自的驱动管理。
    void showQuickMenu(event.screenX, event.screenY);
  }

  return (
    <div
      ref={petRootRef}
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
              const style = framedStyle(frame.entry ?? "", frame.flip, frame.walk);
              return (
                <PetMedia
                  key={frame.key}
                  className={[
                    frame.walk ? "pet-walk" : "pet-action",
                    frame.flip ? "pet-flip" : "",
                    style ? "pet-framed" : "",
                    isBuiltinHurtEntry(frame.entry) ? "pet-builtin-hit" : "",
                    frame.key === displayed?.key ? "pet-current" : frame.key === leaving?.key ? "pet-crossfade-out" : "",
                  ].filter(Boolean).join(" ")}
                  style={style}
                  src={frame.src}
                  entry={frame.entry}
                  hidden={displayed?.key !== frame.key && leaving?.key !== frame.key}
                  // Keep the outgoing video on its last composited frame. In
                  // particular, a finished one-shot must not restart as a loop
                  // underneath its fade while the next action becomes active.
                   playing={frame.key !== leaving?.key}
                   loop={frame.loop}
                   onReady={(element) => {
                     readyMedia.current.set(frame.key, element);
                     rememberMediaDimensions(frame, element);
                     void onPetImageReady(frame, element);
                   }}
                  onEnded={() => onBehaviorEnded(frame)}
                  onError={() => {
                    playback.failed(frame.key);
                    if (behavior && frame.key === targetFrame?.key && frame.entry === eventEntry) setEventEntry(null);
                  }}
                />
              );
            })}
            {!displayed && <PawPrint size={petSize - 10} style={{ gridArea: "1 / 1" }} />}
          </>
        ) : (
          <div className={[
            "pet-icon-actor",
            walking && !motionReduced() ? `is-walking is-${walking}` : "",
          ].filter(Boolean).join(" ")}>
            <MediaImage
              key={app.pid ?? "none"}
              src={app.pid === null ? null : iconUrl(app.pid, petSize)}
              alt={app.name}
              fallback={<AppWindow size={petSize - 12} />}
            />
            <div ref={iconFaceRef} className="pet-icon-face" hidden aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <g className="face-wince">
                  <path d="M16 25 L25 30 L16 35 M48 25 L39 30 L48 35" fill="none" stroke="#FFF" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M16 25 L25 30 L16 35 M48 25 L39 30 L48 35" fill="none" stroke="#231815" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M25 43 Q32 37 39 43" fill="none" stroke="#FFF" strokeWidth="4.2" strokeLinecap="round" />
                  <path d="M25 43 Q32 37 39 43" fill="none" stroke="#231815" strokeWidth="2.4" strokeLinecap="round" />
                  <path d="M46 10 L46 15 L41 15 M52 10 L52 15 L57 15 M46 24 L46 19 L41 19 M52 24 L52 19 L57 19" fill="none" stroke="#EF3340" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </g>
                <g className="face-dizzy">
                  <path d="M16 24 L25 33 M25 24 L16 33 M39 24 L48 33 M48 24 L39 33" fill="none" stroke="#FFF" strokeWidth="4.6" strokeLinecap="round" />
                  <path d="M16 24 L25 33 M25 24 L16 33 M39 24 L48 33 M48 24 L39 33" fill="none" stroke="#231815" strokeWidth="2.6" strokeLinecap="round" />
                  <circle cx="32" cy="42" r="4.2" fill="#EF5350" stroke="#231815" strokeWidth="2" />
                  <path d="M51 11 C54 16 55 19 55 21 A4 4 0 1 1 47 21 C47 19 48 16 51 11 Z" fill="#74D2FF" stroke="#1E6EB8" strokeWidth="1.8" />
                </g>
              </svg>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
