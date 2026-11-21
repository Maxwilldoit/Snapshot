import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { recordingUrl, snapshotUrl } from "../lib/media";
import { annotateSnapshot, copySnapshot } from "../lib/backend";
import { errorText } from "../app/context";
import { formatBytes, formatClock, formatDuration, formatCalendarDate } from "../lib/format";
import { motionReduced } from "../lib/motion";
import { useI18n } from "../lib/i18n";
import type { MediaItem } from "../lib/mediaTimeline";
import {
  VelocityTracker,
  boundsFor,
  clamp,
  getClampedTransform,
  isNotchedZoom,
  maxScaleFor,
  momentumStep,
  rubberClamp,
  springStep,
  straightZoomFrame,
  zoomAnchored,
  zoomDeltaOf,
  type Transform,
} from "../lib/photoPhysics";

/** 相邻两张图之间的固定间距 */
const PAGE_GAP = 24;
/** 松手判定：距最后一次滚轮手势输入超过这个毫秒数就进入惯性/回弹 */
const GESTURE_IDLE_MS = 110;
/** 弹簧固有角频率：约 150ms 落定 */
const OMEGA = 26;
/** 惯性速度低于该值（px/s）就交给弹簧收尾 */
const MOMENTUM_MIN_V = 24;
/** 捏合退场阈值：松手时缩放低于它就收起查看器 */
const DISMISS_SCALE = 0.82;
/** 下拉退场阈值（px） */
const DISMISS_DRAG_PX = 140;
/** 甩动翻页的速度阈值（px/s） */
const FLING_VX = 550;
/** 滚轮越界原始位移封顶，保证松手或反向滑动立即响应 */
const RAW_OVERSCROLL_CAP = 420;
/** Quick Look 风格进退场时长（ms）：原位轻快微缩放 + 淡入淡出，干净不晃眼 */
const QUICKLOOK_OPEN_MS = 160;
const QUICKLOOK_CLOSE_MS = 140;
const QUICKLOOK_SCALE_FROM = 0.95;

const SCALE_SOFT_MIN = 0.55;
const SCALE_SOFT_MAX = 1.35;

type GestureEventLike = Event & { scale?: number; clientX?: number; clientY?: number };
type WheelAxis = "page" | "dismiss" | "pan" | null;

type EnginePhase =
  | { kind: "idle" }
  | { kind: "gesture"; last: number }
  | { kind: "momentum"; vx: number; vy: number }
  | { kind: "spring"; vx: number; vy: number; vs: number; target: Transform }
  | { kind: "zoom"; start: Transform; target: Transform; anchor: { x: number; y: number }; p: number; vp: number }
  | { kind: "page"; from: number; to: number; v: number; commit: number | null }
  | {
      kind: "quicklook";
      mode: "open" | "close";
      start: number;
      duration: number;
      anchorTransform: Transform;
      startBackdrop: number;
    };

type Engine = {
  view: { w: number; h: number };
  base: { w: number; h: number };
  maxScale: number;
  cur: Transform;
  raw: Transform;
  pageX: number;
  rawPageX: number;
  wheelAxis: WheelAxis;
  phase: EnginePhase;
  tracker: VelocityTracker;
  raf: number;
  lastFrame: number;
  mediaOpacity: number;
  dismissing: boolean;
};

function fitTransform(view: { w: number; h: number }, base: { w: number; h: number }): Transform {
  return { scale: 1, tx: (view.w - base.w) / 2, ty: (view.h - base.h) / 2 };
}

function scaleAround(base: Transform, factor: number, cx: number, cy: number): Transform {
  const scale = base.scale * factor;
  return {
    scale,
    tx: cx - (cx - base.tx) * factor,
    ty: cy - (cy - base.ty) * factor,
  };
}

function dismissDrag(overflow: number) {
  return overflow <= 240 ? overflow * 0.9 : 216 + rubberClamp(overflow - 240, 0, 0, 160);
}

function fitBoxFor(item: MediaItem, view: { w: number; h: number }): { width: number; height: number } | null {
  if (!view.w || !view.h || !item.width || !item.height) return null;
  const scale = Math.min(view.w / item.width, view.h / item.height, 1);
  return { width: Math.max(1, Math.round(item.width * scale)), height: Math.max(1, Math.round(item.height * scale)) };
}

/**
 * Quick Look 式图片与录屏查看器：
 * - 打开与关闭采用原位 160ms/140ms 轻快微缩放（95% ↔ 100%）+ 淡入淡出，不做跨屏飞入飞出；
 * - 查看时完整支持 macOS 原生触控板双指捏合（GestureEvent）、Ctrl/Cmd+滚轮无级缩放、双击定点放大、惯性平移与左右翻页。
 */
export function PhotoViewer({
  records,
  startId,
  onClose,
}: {
  records: MediaItem[];
  startId: string;
  onClose: () => void;
}) {
  const [currentId, setCurrentId] = useState(startId);
  const [stageWidth, setStageWidth] = useState(0);
  const [boxes, setBoxes] = useState<Record<string, { width: number; height: number }>>({});
  const [videoDims, setVideoDims] = useState<Record<string, { width: number; height: number }>>({});
  const [isClosing, setIsClosing] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const { t, language } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const mediaRefs = useRef(new Map<string, HTMLElement>());
  const rootRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const openedRef = useRef(false);
  const indexRef = useRef(0);
  const dragRef = useRef<{ id: number; x: number; y: number; tx: number; ty: number; pageX: number; moved: boolean } | null>(null);

  const displayRecords = useMemo(
    () =>
      records.map((item) => {
        const dims = item.kind === "recording" ? videoDims[item.id] : undefined;
        return dims ? { ...item, width: dims.width, height: dims.height } : item;
      }),
    [records, videoDims],
  );
  const foundIndex = displayRecords.findIndex((item) => item.id === currentId);
  const index = Math.max(0, foundIndex);
  indexRef.current = index;
  const record = displayRecords[index];
  const isRecording = record?.kind === "recording";
  const neighbors = [displayRecords[index - 1], record, displayRecords[index + 1]].filter(Boolean) as MediaItem[];

  useEffect(() => {
    if (foundIndex < 0 && displayRecords[0] && displayRecords[0].id !== currentId) {
      setCurrentId(displayRecords[0].id);
    }
  }, [foundIndex, displayRecords, currentId]);

  useEffect(() => {
    for (const [id, node] of mediaRefs.current) {
      if (id !== currentId && node instanceof HTMLVideoElement && !node.paused) {
        node.pause();
      }
    }
  }, [currentId]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stageRef.current?.focus({ preventScroll: true });
    return () => {
      const activeId = currentIdRef.current;
      const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(activeId) : activeId;
      const target =
        document.querySelector<HTMLElement>(`[data-thumb-id="${safe}"]`)
        ?? (previousFocusRef.current?.isConnected ? previousFocusRef.current : null)
        ?? document.querySelector<HTMLElement>(".history-scroll");
      target?.focus({ preventScroll: true });
    };
  }, []);

  const engineRef = useRef<Engine>({
    view: { w: 0, h: 0 },
    base: { w: 0, h: 0 },
    maxScale: 8,
    cur: { scale: 1, tx: 0, ty: 0 },
    raw: { scale: 1, tx: 0, ty: 0 },
    pageX: 0,
    rawPageX: 0,
    wheelAxis: null,
    phase: { kind: "idle" },
    tracker: new VelocityTracker(),
    raf: 0,
    lastFrame: 0,
    mediaOpacity: 1,
    dismissing: false,
  });

  const currentBackdropOf = (engine: Engine) => {
    let opacity = 1;
    if (engine.dismissing) {
      const shrink = clamp((1 - engine.cur.scale) / (1 - DISMISS_SCALE), 0, 1);
      const drag = clamp((engine.cur.ty - (engine.view.h - engine.base.h) / 2) / DISMISS_DRAG_PX, 0, 1);
      opacity = 1 - Math.max(shrink, drag) * 0.9;
    }
    const phase = engine.phase;
    if (phase.kind === "quicklook") {
      opacity = engine.mediaOpacity * phase.startBackdrop;
    }
    return opacity;
  };

  const paint = useCallback(() => {
    const engine = engineRef.current;
    const current = currentIdRef.current;
    for (const [id, node] of mediaRefs.current) {
      let transform = engine.cur;
      if (id !== current) {
        const item = recordsRef.current.find((r) => r.id === id);
        const neighborBase = item ? fitBoxFor(item, engine.view) : null;
        transform = fitTransform(engine.view, neighborBase ? { w: neighborBase.width, h: neighborBase.height } : engine.base);
        node.style.opacity = "";
      } else {
        node.style.opacity = engine.mediaOpacity < 0.999 ? engine.mediaOpacity.toFixed(3) : "";
      }
      node.style.transform = `translate3d(${transform.tx}px, ${transform.ty}px, 0) scale(${transform.scale})`;
    }
    if (stripRef.current) stripRef.current.style.transform = `translate3d(${engine.pageX}px, 0, 0)`;
    if (rootRef.current) {
      rootRef.current.style.setProperty("--viewer-backdrop", currentBackdropOf(engine).toFixed(3));
    }
  }, []);

  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const recordsRef = useRef(displayRecords);
  recordsRef.current = displayRecords;
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const commitPageRef = useRef<(next: number) => void>(() => {});
  const settleRef = useRef<(now: number, immediate: boolean) => void>(() => {});

  const stopAnimation = useCallback(() => {
    const engine = engineRef.current;
    if (engine.raf) cancelAnimationFrame(engine.raf);
    engine.raf = 0;
  }, []);

  const kick = useCallback(() => {
    const engine = engineRef.current;
    if (engine.raf) return;
    engine.lastFrame = performance.now();
    const frame = (now: number) => {
      engine.raf = 0;
      const dtMs = clamp(now - engine.lastFrame, 0, 64);
      engine.lastFrame = now;
      const dt = dtMs / 1000;
      const phase = engine.phase;
      const { view, base, maxScale } = engine;
      const reduced = motionReduced();

      const springTo = (target: Transform, vx: number, vy: number, vs: number) => {
        engine.phase = reduced
          ? { kind: "idle" }
          : { kind: "spring", vx, vy, vs, target };
        if (reduced) {
          engine.cur = target;
          paint();
        }
      };

      if (phase.kind === "gesture") {
        if (dragRef.current) return;
        if (now - phase.last > GESTURE_IDLE_MS) {
          settleRef.current(now, false);
          return;
        }
        engine.raf = requestAnimationFrame(frame);
        return;
      } else if (phase.kind === "momentum") {
        const bounds = boundsFor(engine.cur.scale, view, base);
        const stepX = momentumStep(phase.vx, dtMs);
        const stepY = momentumStep(phase.vy, dtMs);
        let tx = engine.cur.tx + stepX.delta;
        let ty = engine.cur.ty + stepY.delta;
        const vx = stepX.v;
        const vy = stepY.v;
        const hitX = tx < bounds.minTx || tx > bounds.maxTx;
        const hitY = ty < bounds.minTy || ty > bounds.maxTy;
        if (hitX || hitY) {
          if (hitX) tx = rubberClamp(tx, bounds.minTx, bounds.maxTx, 60);
          if (hitY) ty = rubberClamp(ty, bounds.minTy, bounds.maxTy, 60);
          engine.cur = { ...engine.cur, tx, ty };
          springTo(getClampedTransform(engine.cur.scale, tx, ty, view, base, maxScale), hitX ? vx : 0, hitY ? vy : 0, 0);
        } else if (Math.abs(vx) < MOMENTUM_MIN_V && Math.abs(vy) < MOMENTUM_MIN_V) {
          engine.cur = { ...engine.cur, tx, ty };
          engine.phase = { kind: "idle" };
        } else {
          engine.cur = { ...engine.cur, tx, ty };
          engine.phase = { kind: "momentum", vx, vy };
        }
      } else if (phase.kind === "spring") {
        const sx = springStep(engine.cur.tx - phase.target.tx, phase.vx, dt, OMEGA);
        const sy = springStep(engine.cur.ty - phase.target.ty, phase.vy, dt, OMEGA);
        const logX = Math.log(engine.cur.scale / phase.target.scale);
        const sv = springStep(logX, phase.vs / Math.max(engine.cur.scale, 1e-4), dt, OMEGA);
        const scale = phase.target.scale * Math.exp(sv.x);
        engine.cur = { scale, tx: phase.target.tx + sx.x, ty: phase.target.ty + sy.x };
        const done =
          Math.abs(sx.x) < 0.1 && Math.abs(sx.v) < 2 &&
          Math.abs(sy.x) < 0.1 && Math.abs(sy.v) < 2 &&
          Math.abs(sv.x) < 0.0005 && Math.abs(sv.v) < 0.005;
        if (done) {
          engine.cur = phase.target;
          engine.phase = { kind: "idle" };
        } else {
          engine.phase = { kind: "spring", vx: sx.v, vy: sy.v, vs: sv.v * scale, target: phase.target };
        }
      } else if (phase.kind === "zoom") {
        const step = springStep(phase.p - 1, phase.vp, dt, OMEGA);
        const p = 1 + step.x;
        const scale = phase.start.scale * Math.exp(Math.log(phase.target.scale / phase.start.scale) * p);
        engine.cur = straightZoomFrame(phase.start, phase.target, phase.anchor, scale);
        if (Math.abs(step.x) < 0.0008 && Math.abs(step.v) < 0.02) {
          engine.cur = phase.target;
          engine.phase = { kind: "idle" };
        } else {
          engine.phase = { ...phase, p, vp: step.v };
        }
      } else if (phase.kind === "page") {
        const step = springStep(engine.pageX - phase.to, phase.v, dt, OMEGA);
        engine.pageX = phase.to + step.x;
        if (Math.abs(step.x) < 0.2 && Math.abs(step.v) < 4) {
          engine.pageX = phase.to;
          engine.phase = { kind: "idle" };
          if (phase.commit !== null) commitPageRef.current(phase.commit);
        } else {
          engine.phase = { ...phase, v: step.v };
        }
      } else if (phase.kind === "quicklook") {
        const u = clamp((now - phase.start) / phase.duration, 0, 1);
        const cx = view.w / 2;
        const cy = view.h / 2;
        if (phase.mode === "open") {
          const eased = 1 - (1 - u) ** 3;
          const factor = QUICKLOOK_SCALE_FROM + (1 - QUICKLOOK_SCALE_FROM) * eased;
          engine.cur = scaleAround(phase.anchorTransform, factor, cx, cy);
          engine.mediaOpacity = eased;
          if (u >= 1) {
            engine.cur = phase.anchorTransform;
            engine.mediaOpacity = 1;
            engine.phase = { kind: "idle" };
          }
        } else {
          const eased = u * u;
          const factor = 1 - (1 - QUICKLOOK_SCALE_FROM) * eased;
          engine.cur = scaleAround(phase.anchorTransform, factor, cx, cy);
          engine.mediaOpacity = 1 - eased;
          if (u >= 1) {
            engine.mediaOpacity = 0;
            engine.phase = { kind: "idle" };
            paint();
            onCloseRef.current();
            return;
          }
        }
      }

      paint();
      if (engine.phase.kind !== "idle") engine.raf = requestAnimationFrame(frame);
    };
    engine.raf = requestAnimationFrame(frame);
  }, [paint]);

  const interrupt = useCallback(() => {
    const engine = engineRef.current;
    stopAnimation();
    engine.dismissing = false;
    engine.wheelAxis = null;
    engine.mediaOpacity = 1;
    if (engine.phase.kind === "page" && engine.phase.commit !== null) {
      const commit = engine.phase.commit;
      engine.pageX = engine.phase.to;
      engine.phase = { kind: "idle" };
      commitPageRef.current(commit);
    } else if (engine.phase.kind === "quicklook" && engine.phase.mode === "close") {
      onCloseRef.current();
      return false;
    }
    engine.phase = { kind: "idle" };
    return true;
  }, [stopAnimation]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !record) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      const view = { w: rect.width, h: rect.height };
      const scale = Math.min(view.w / record.width, view.h / record.height, 1);
      const next = { width: Math.max(1, Math.round(record.width * scale)), height: Math.max(1, Math.round(record.height * scale)) };
      const engine = engineRef.current;
      const changed = engine.base.w !== next.width || engine.base.h !== next.height || engine.view.w !== view.w || engine.view.h !== view.h;
      engine.view = view;
      engine.base = { w: next.width, h: next.height };
      engine.maxScale = maxScaleFor(engine.base, { w: record.width, h: record.height });
      if (changed) {
        const phase = engine.phase;
        if (phase.kind === "idle" || phase.kind === "spring") {
          engine.cur = getClampedTransform(engine.cur.scale, engine.cur.tx, engine.cur.ty, view, engine.base, engine.maxScale);
          engine.raw = { ...engine.cur };
          if (engine.phase.kind === "spring") engine.phase = { kind: "idle" };
        } else if (phase.kind === "quicklook" && phase.mode === "open") {
          engine.phase = { ...phase, anchorTransform: fitTransform(view, engine.base) };
        } else if (phase.kind === "zoom") {
          engine.phase = { ...phase, target: getClampedTransform(phase.target.scale, phase.target.tx, phase.target.ty, view, engine.base, engine.maxScale) };
        }
        paint();
      }
      setStageWidth((prev) => (prev === view.w ? prev : view.w));
      setBoxes((current) => current[record.id]?.width === next.width && current[record.id]?.height === next.height
        ? current
        : { ...current, [record.id]: next });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [record, paint]);

  /** Quick Look 原位进场：居中直接微缩放（95% → 100%）+ 160ms 渐显，无跨屏飞行与弹跳 */
  useLayoutEffect(() => {
    const box = record ? boxes[record.id] : undefined;
    if (!box || openedRef.current || !record) return;
    const pane = mediaRefs.current.get(record.id);
    const stage = stageRef.current;
    if (!pane || !stage) return;
    openedRef.current = true;
    const engine = engineRef.current;
    const target = fitTransform(engine.view, engine.base);
    engine.raw = { ...target };
    if (motionReduced()) {
      engine.cur = target;
      engine.mediaOpacity = 1;
      paint();
      return;
    }
    const cx = engine.view.w / 2;
    const cy = engine.view.h / 2;
    engine.cur = scaleAround(target, QUICKLOOK_SCALE_FROM, cx, cy);
    engine.mediaOpacity = 0;
    engine.phase = {
      kind: "quicklook",
      mode: "open",
      start: performance.now(),
      duration: QUICKLOOK_OPEN_MS,
      anchorTransform: target,
      startBackdrop: 1,
    };
    paint();
    kick();
  }, [boxes, record, kick, paint]);

  /** Quick Look 原位收起：从当前姿态原位 140ms 轻缩淡出 */
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    const engine = engineRef.current;
    const startBackdrop = currentBackdropOf(engine);
    stopAnimation();
    if (motionReduced() || !stageRef.current) {
      onCloseRef.current();
      return;
    }
    engine.dismissing = false;
    engine.mediaOpacity = 1;
    engine.phase = {
      kind: "quicklook",
      mode: "close",
      start: performance.now(),
      duration: QUICKLOOK_CLOSE_MS,
      anchorTransform: { ...engine.cur },
      startBackdrop: Math.max(0.15, startBackdrop),
    };
    paint();
    kick();
  }, [stopAnimation, paint, kick]);

  const commitPage = useCallback((next: number) => {
    const item = recordsRef.current[next];
    if (!item) return;
    const engine = engineRef.current;
    const fit = fitBoxFor(item, engine.view);
    if (fit) {
      engine.base = { w: fit.width, h: fit.height };
      engine.maxScale = maxScaleFor(engine.base, { w: item.width, h: item.height });
    }
    engine.pageX = 0;
    engine.rawPageX = 0;
    engine.wheelAxis = null;
    engine.mediaOpacity = 1;
    engine.cur = fitTransform(engine.view, engine.base);
    engine.raw = { ...engine.cur };
    engine.tracker.clear();
    setCurrentId(item.id);
    setCopyError(null);
    setCopyMessage(null);
    requestAnimationFrame(() => paintRef.current());
  }, []);
  commitPageRef.current = commitPage;

  const step = useCallback((delta: number) => {
    const next = indexRef.current + delta;
    if (!recordsRef.current[next]) return;
    const engine = engineRef.current;
    if (!interrupt()) return;
    if (motionReduced()) {
      commitPage(next);
      return;
    }
    const width = engine.view.w + PAGE_GAP;
    engine.phase = { kind: "page", from: engine.pageX, to: -delta * width, v: 0, commit: next };
    kick();
  }, [interrupt, commitPage, kick]);

  const zoomAtPoint = useCallback((cx: number, cy: number) => {
    const engine = engineRef.current;
    if (!interrupt()) return;
    const start = { ...engine.cur };
    let target: Transform;
    if (start.scale > 1.05) {
      target = fitTransform(engine.view, engine.base);
    } else {
      const oneToOne = engine.maxScale >= 1 ? Math.min(2.5, Math.max(1.6, engine.maxScale)) : 2.5;
      const zoomed = zoomAnchored(start, Math.log(oneToOne / start.scale), cx, cy);
      target = getClampedTransform(zoomed.scale, zoomed.tx, zoomed.ty, engine.view, engine.base, engine.maxScale);
    }
    engine.raw = { ...target };
    if (motionReduced()) {
      engine.cur = target;
      paint();
      return;
    }
    engine.phase = { kind: "zoom", start, target, anchor: { x: cx, y: cy }, p: 0, vp: 0 };
    kick();
  }, [interrupt, paint, kick]);

  const copy = useCallback(async () => {
    const item = recordsRef.current[indexRef.current];
    if (!item || item.kind !== "snapshot") return;
    setCopyMessage(null);
    setCopyError(null);
    try {
      setCopyMessage(await copySnapshot(item.id));
    } catch (error) {
      setCopyError(errorText(error));
    }
  }, []);

  const annotate = useCallback(() => {
    const item = recordsRef.current[indexRef.current];
    if (!item || item.kind !== "snapshot") return;
    void annotateSnapshot(item.id).catch((error) => setCopyError(errorText(error)));
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !record) return;
    const engine = engineRef.current;
    let webkitGestureActive = false;
    let lastGestureScale = 1;

    const pointIn = (clientX: number, clientY: number) => {
      const rect = stage.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const beginWheelGesture = (now: number) => {
      if (!interrupt()) return false;
      engine.raw = { ...engine.cur };
      engine.rawPageX = engine.pageX;
      engine.wheelAxis = null;
      engine.tracker.clear();
      engine.phase = { kind: "gesture", last: now };
      return true;
    };

    const pushWheelSample = (now: number, keepRaf = true) => {
      engine.tracker.push({ t: now, tx: engine.cur.tx, ty: engine.cur.ty, scale: engine.cur.scale });
      engine.phase = { kind: "gesture", last: now };
      paint();
      if (keepRaf) kick();
    };

    const applyZoomDelta = (delta: number, clientX: number, clientY: number, now: number, keepRaf: boolean) => {
      const { view, base, maxScale } = engine;
      const { x: cx, y: cy } = pointIn(clientX, clientY);
      const next = zoomAnchored(engine.raw, delta, cx, cy);
      const scale = clamp(next.scale, SCALE_SOFT_MIN, maxScale * SCALE_SOFT_MAX);
      const ratio = scale / engine.raw.scale;
      const rawTx = cx - (cx - engine.raw.tx) * ratio;
      const rawTy = cy - (cy - engine.raw.ty) * ratio;
      engine.raw = { scale, tx: rawTx, ty: rawTy };

      if (scale < 1) {
        engine.cur = { scale, tx: rawTx, ty: rawTy };
        engine.dismissing = true;
      } else {
        const bounds = boundsFor(clamp(scale, 1, maxScale), view, base);
        engine.cur = {
          scale,
          tx: rubberClamp(rawTx, bounds.minTx, bounds.maxTx),
          ty: rubberClamp(rawTy, bounds.minTy, bounds.maxTy),
        };
        engine.dismissing = false;
      }
      pushWheelSample(now, keepRaf);
    };

    const onWheel = (event: WheelEvent) => {
      if (closingRef.current || dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (event.ctrlKey || event.metaKey) {
        if (webkitGestureActive) return;
        if (engine.phase.kind !== "gesture" && !beginWheelGesture(now)) return;
        const notched = isNotchedZoom(event);
        const delta = zoomDeltaOf(event.deltaY, event.deltaMode, notched);
        applyZoomDelta(delta, event.clientX, event.clientY, now, true);
        return;
      }

      if (engine.phase.kind !== "gesture" && !beginWheelGesture(now)) return;
      const { view, base, maxScale } = engine;
      const dx = -event.deltaX;
      const dy = -event.deltaY;
      if (engine.cur.scale <= 1.001) {
        if (engine.wheelAxis === null && (dx !== 0 || dy !== 0)) {
          if (Math.abs(dx) > Math.abs(dy)) engine.wheelAxis = "page";
          else if (dy > 0) engine.wheelAxis = "dismiss";
          else engine.wheelAxis = "pan";
        }
        if (engine.wheelAxis === "page") {
          engine.rawPageX = clamp(engine.rawPageX + dx, -(view.w + PAGE_GAP + RAW_OVERSCROLL_CAP), view.w + PAGE_GAP + RAW_OVERSCROLL_CAP);
          const dir = engine.rawPageX < 0 ? 1 : -1;
          const hasNext = Boolean(recordsRef.current[indexRef.current + dir]);
          const limit = hasNext ? view.w + PAGE_GAP : 80;
          engine.pageX = rubberClamp(engine.rawPageX, -limit, limit);
          engine.tracker.push({ t: now, tx: engine.pageX, ty: 0, scale: 1 });
          engine.phase = { kind: "gesture", last: now };
          paint();
          kick();
          return;
        }
        const bounds = boundsFor(1, view, base);
        engine.raw = {
          ...engine.raw,
          tx: clamp(engine.raw.tx + dx, bounds.minTx - RAW_OVERSCROLL_CAP, bounds.maxTx + RAW_OVERSCROLL_CAP),
          ty: clamp(engine.raw.ty + dy, bounds.minTy - RAW_OVERSCROLL_CAP, bounds.maxTy + 480),
        };
        if (engine.raw.ty > bounds.maxTy) {
          engine.dismissing = true;
          engine.cur = {
            ...engine.cur,
            tx: rubberClamp(engine.raw.tx, bounds.minTx, bounds.maxTx),
            ty: bounds.maxTy + dismissDrag(engine.raw.ty - bounds.maxTy),
          };
        } else {
          engine.dismissing = false;
          engine.cur = {
            ...engine.cur,
            tx: rubberClamp(engine.raw.tx, bounds.minTx, bounds.maxTx),
            ty: rubberClamp(engine.raw.ty, bounds.minTy, bounds.maxTy),
          };
        }
        pushWheelSample(now, true);
      } else {
        const bounds = boundsFor(clamp(engine.cur.scale, 1, maxScale), view, base);
        const rawTx = clamp(engine.raw.tx + dx, bounds.minTx - RAW_OVERSCROLL_CAP, bounds.maxTx + RAW_OVERSCROLL_CAP);
        const rawTy = clamp(engine.raw.ty + dy, bounds.minTy - RAW_OVERSCROLL_CAP, bounds.maxTy + RAW_OVERSCROLL_CAP);
        engine.raw = { ...engine.raw, tx: rawTx, ty: rawTy };
        engine.cur = {
          ...engine.cur,
          tx: rubberClamp(rawTx, bounds.minTx, bounds.maxTx),
          ty: rubberClamp(rawTy, bounds.minTy, bounds.maxTy),
        };
        pushWheelSample(now, true);
      }
    };

    // macOS WKWebView 原生双指捏合手势驱动锚点无级缩放，松手立即结算
    const onGestureStart = (event: Event) => {
      if (closingRef.current || dragRef.current) return;
      event.preventDefault();
      const gesture = event as GestureEventLike;
      const now = performance.now();
      if (!beginWheelGesture(now)) return;
      webkitGestureActive = true;
      lastGestureScale = typeof gesture.scale === "number" && gesture.scale > 0 ? gesture.scale : 1;
    };

    const onGestureChange = (event: Event) => {
      if (closingRef.current || !webkitGestureActive) return;
      event.preventDefault();
      const gesture = event as GestureEventLike;
      const scale = gesture.scale;
      if (typeof scale !== "number" || scale <= 0 || lastGestureScale <= 0) return;
      const delta = Math.log(scale / lastGestureScale);
      lastGestureScale = scale;
      const rect = stage.getBoundingClientRect();
      const clientX = gesture.clientX ?? (rect.left + rect.width / 2);
      const clientY = gesture.clientY ?? (rect.top + rect.height / 2);
      applyZoomDelta(delta, clientX, clientY, performance.now(), false);
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      if (!webkitGestureActive) return;
      webkitGestureActive = false;
      if (!closingRef.current) settleGesture(performance.now(), true);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (closingRef.current || event.button !== 0 || dragRef.current !== null) return;
      if ((event.target as HTMLElement).closest("video")) return;
      if (!interrupt()) return;
      try { stage.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
      dragRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        tx: engine.cur.tx,
        ty: engine.cur.ty,
        pageX: engine.pageX,
        moved: false,
      };
      engine.tracker.clear();
      engine.phase = { kind: "gesture", last: performance.now() };
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== event.pointerId || closingRef.current) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      const now = performance.now();
      const { view, base, maxScale } = engine;
      const bounds = boundsFor(clamp(engine.cur.scale, 1, maxScale), view, base);
      const atFit = engine.cur.scale <= 1.001;
      if (atFit && Math.abs(dx) > Math.abs(dy) && Math.abs(engine.cur.tx - bounds.maxTx) < 1) {
        const dir = dx < 0 ? 1 : -1;
        const hasNext = Boolean(recordsRef.current[indexRef.current + dir]);
        const limit = hasNext ? view.w + PAGE_GAP : 80;
        engine.pageX = rubberClamp(drag.pageX + dx, -limit, limit);
        engine.tracker.push({ t: now, tx: engine.pageX, ty: 0, scale: 1 });
        engine.phase = { kind: "gesture", last: now };
        paint();
        return;
      }
      let tx = drag.tx + dx;
      let ty = drag.ty + dy;
      if (atFit && dy > 0 && dy > Math.abs(dx)) {
        engine.dismissing = true;
        ty = bounds.maxTy + dismissDrag(ty - bounds.maxTy);
        tx = rubberClamp(tx, bounds.minTx, bounds.maxTx);
      } else {
        tx = rubberClamp(tx, bounds.minTx, bounds.maxTx);
        ty = rubberClamp(ty, bounds.minTy, bounds.maxTy);
      }
      engine.cur = { ...engine.cur, tx, ty };
      engine.tracker.push({ t: now, tx, ty, scale: engine.cur.scale });
      engine.phase = { kind: "gesture", last: now };
      paint();
    };

    const endDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== event.pointerId) return;
      dragRef.current = null;
      try {
        if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      } catch { /* unsupported */ }
      if (!drag.moved) {
        engine.phase = { kind: "idle" };
        return;
      }
      settleGesture(performance.now(), true);
    };

    const settleGesture = (now: number, immediate: boolean) => {
      const { view, base, maxScale, cur } = engine;
      const { vx, vy, vScale } = engine.tracker.velocity(now, immediate ? 160 : GESTURE_IDLE_MS + 40);
      const atFit = cur.scale <= 1.001;
      engine.wheelAxis = null;
      if ((engine.dismissing || cur.scale < 1) && (cur.scale < DISMISS_SCALE || cur.ty - (view.h - base.h) / 2 > DISMISS_DRAG_PX)) {
        close();
        return;
      }
      if (atFit && Math.abs(engine.pageX) > 1) {
        const width = view.w + PAGE_GAP;
        const dir = engine.pageX < 0 ? 1 : -1;
        const next = indexRef.current + dir;
        const fling = dir === 1 ? vx < -FLING_VX : vx > FLING_VX;
        const passed = Math.abs(engine.pageX) > view.w * 0.3 || fling;
        const commit = passed && recordsRef.current[next] ? next : null;
        engine.rawPageX = 0;
        engine.phase = motionReduced()
          ? { kind: "idle" }
          : { kind: "page", from: engine.pageX, to: commit !== null ? -dir * width : 0, v: vx, commit };
        if (motionReduced()) {
          engine.pageX = 0;
          if (commit !== null) commitPage(commit);
          paint();
        } else kick();
        return;
      }
      engine.dismissing = false;
      const legalScale = clamp(cur.scale, 1, maxScale);
      if (cur.scale < 1 || cur.scale > maxScale) {
        const ratio = legalScale / cur.scale;
        const cx = view.w / 2;
        const cy = view.h / 2;
        const target = getClampedTransform(legalScale, cx - (cx - cur.tx) * ratio, cy - (cy - cur.ty) * ratio, view, base, maxScale);
        engine.raw = { ...target };
        engine.phase = motionReduced() ? { kind: "idle" } : { kind: "spring", vx, vy, vs: vScale, target };
        if (motionReduced()) { engine.cur = target; paint(); } else kick();
        return;
      }
      const bounds = boundsFor(cur.scale, view, base);
      const outside = cur.tx < bounds.minTx - 0.5 || cur.tx > bounds.maxTx + 0.5 || cur.ty < bounds.minTy - 0.5 || cur.ty > bounds.maxTy + 0.5;
      const target = getClampedTransform(cur.scale, cur.tx, cur.ty, view, base, maxScale);
      engine.raw = { ...target };
      if (!outside && cur.scale > 1.001 && (Math.abs(vx) > MOMENTUM_MIN_V || Math.abs(vy) > MOMENTUM_MIN_V) && !motionReduced()) {
        engine.phase = { kind: "momentum", vx, vy };
        kick();
        return;
      }
      engine.phase = motionReduced() ? { kind: "idle" } : { kind: "spring", vx, vy, vs: 0, target };
      if (motionReduced()) { engine.cur = target; paint(); } else kick();
    };
    settleRef.current = settleGesture;

    const onDoubleClick = (event: MouseEvent) => {
      if (closingRef.current || (event.target as HTMLElement).closest("video")) return;
      event.preventDefault();
      const { x, y } = pointIn(event.clientX, event.clientY);
      zoomAtPoint(x, y);
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart, { passive: false });
    stage.addEventListener("gesturechange", onGestureChange, { passive: false });
    stage.addEventListener("gestureend", onGestureEnd, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("dblclick", onDoubleClick);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", endDrag);
      stage.removeEventListener("pointercancel", endDrag);
      stage.removeEventListener("dblclick", onDoubleClick);
    };
  }, [record, interrupt, kick, paint, zoomAtPoint, close, commitPage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab" && rootRef.current) {
        const focusable = [...rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), video[controls], [tabindex="0"]',
        )];
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement as HTMLElement | null;
          if (!active || !rootRef.current.contains(active)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
          } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus({ preventScroll: true });
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus({ preventScroll: true });
          }
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const inVideo = (event.target as HTMLElement | null)?.tagName === "VIDEO";
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowLeft" && !inVideo) {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight" && !inVideo) {
        event.preventDefault();
        step(1);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        if (isRecording) return;
        event.preventDefault();
        void copy();
      } else if (event.key === "Enter" || event.key === " ") {
        if ((event.target as HTMLElement | null)?.tagName === "BUTTON" || inVideo) return;
        event.preventDefault();
        const engine = engineRef.current;
        zoomAtPoint(engine.view.w / 2, engine.view.h / 2);
      } else if (event.key === "+" || event.key === "=") {
        const engine = engineRef.current;
        zoomAtPoint(engine.view.w / 2, engine.view.h / 2);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, copy, step, isRecording, zoomAtPoint]);

  useEffect(() => () => stopAnimation(), [stopAnimation]);

  if (!record) return null;

  const width = (stageWidth || engineRef.current.view.w) + PAGE_GAP;

  return createPortal(
    <div
      ref={rootRef}
      className={`lightbox photo-viewer ${isClosing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t(isRecording ? "录屏：{appName}" : "放大查看：{appName}", { appName: record.appName })}
    >
      <div className="lightbox-head">
        <button type="button" className="lightbox-back" onClick={close}>
          <svg width="7" height="12" viewBox="0 0 7 12" aria-hidden="true"><path d="M6 1L1 6l5 5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          {t("返回")}
        </button>
        <span className="lightbox-title" title={record.appName}>{record.appName}</span>
        {!isRecording && (
          <button type="button" className="lightbox-annotate" onClick={annotate}>{t("标注")}</button>
        )}
        <span className="lightbox-count mono">{index + 1} / {records.length}</span>
      </div>

      <div className="lightbox-body">
        <button type="button" className="lightbox-arrow" aria-label={t("上一张")} disabled={index === 0} onClick={() => step(-1)}>
          <svg width="12" height="22" viewBox="0 0 12 22" aria-hidden="true"><path d="M11 1L1 11l10 10" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
        <div className="lightbox-stage photo-stage" ref={stageRef} tabIndex={0} aria-label={t("放大查看：{appName}", { appName: record.appName })}>
          <div className="photo-strip" ref={stripRef}>
            {neighbors.map((item) => {
              const slot = displayRecords.findIndex((r) => r.id === item.id) - index;
              const itemBox = boxes[item.id] ?? fitBoxFor(item, engineRef.current.view);
              return (
                <div
                  key={item.id}
                  className="photo-pane"
                  ref={(node) => { if (node) paneRefs.current.set(item.id, node); else paneRefs.current.delete(item.id); }}
                  style={{ width: width || "100%", transform: `translate3d(${slot * width}px, 0, 0)` }}
                  aria-hidden={slot !== 0 || undefined}
                >
                  {itemBox && (item.kind === "recording" ? (
                    <video
                      ref={(node) => { if (node) mediaRefs.current.set(item.id, node); else mediaRefs.current.delete(item.id); }}
                      className="lightbox-image photo-media"
                      src={recordingUrl(item.id)}
                      style={{ width: itemBox.width, height: itemBox.height }}
                      controls={slot === 0}
                      playsInline
                      aria-label={item.appName}
                      onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        if (video.videoWidth > 0 && video.videoHeight > 0) {
                          setVideoDims((current) => current[item.id] ? current : { ...current, [item.id]: { width: video.videoWidth, height: video.videoHeight } });
                        }
                      }}
                    />
                  ) : (
                    <img
                      ref={(node) => { if (node) mediaRefs.current.set(item.id, node); else mediaRefs.current.delete(item.id); }}
                      className="lightbox-image photo-media"
                      src={snapshotUrl(item.id)}
                      alt={slot === 0 ? item.appName : ""}
                      style={{ width: itemBox.width, height: itemBox.height }}
                      draggable={false}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <button type="button" className="lightbox-arrow" aria-label={t("下一张")} disabled={index >= records.length - 1} onClick={() => step(1)}>
          <svg width="12" height="22" viewBox="0 0 12 22" aria-hidden="true"><path d="M1 1l10 10L1 21" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
      </div>

      <div className="lightbox-foot">
        {copyError && <span role="alert">{copyError}</span>}
        {copyMessage && <span role="status">{copyMessage}</span>}
        <span className="mono lightbox-meta">
          {isRecording
            ? `${record.durationMs != null ? `${formatDuration(record.durationMs)} · ` : ""}${formatBytes(record.sizeBytes)} · MP4`
            : `${record.width} × ${record.height} · ${formatBytes(record.sizeBytes)} · ${record.fileName.split(".").pop()?.toUpperCase()}`}
          {" · "}
          <time dateTime={new Date(record.createdAt).toISOString()}>
            {formatCalendarDate(record.createdAt, Date.now(), language)} {formatClock(record.createdAt)}
          </time>
        </span>
      </div>
    </div>,
    document.body,
  );
}
