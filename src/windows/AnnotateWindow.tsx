import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Check, Circle, Download, Eraser, Highlighter, MousePointer2, MoveUpRight, PenLine, Redo2, Square, Type, Undo2 } from "lucide-react";
import { localizeMessage, useI18n, useWindowTitle } from "../lib/i18n";
import {
  COLORS,
  handleAt,
  isTooSmall,
  lineHeight,
  moveShape,
  nextStep,
  resizeShape,
  snapAngle,
  squareFrom,
  topHit,
  type DrawTool,
  type Handle,
  type Point,
  type Shape,
  type Size,
  type TextShape,
  type Tool,
} from "../lib/annotate/model";
import { renderScene, textFont, textMeasurer, isLightColor } from "../lib/annotate/render";
import { fontSize } from "../lib/annotate/model";

/** 有标注时第一次按 Esc 只提示，这么久内再按一次才放弃并关闭 */
const ESC_CONFIRM_MS = 2000;
const HISTORY_LIMIT = 100;
/** 动效时长（毫秒）：都很短，只为看清发生了什么，不让人等 */
const MOTION = { appear: 140, fade: 120, handles: 120, pop: 110, toast: 140 };
/** 复制/保存成功后，按钮打勾 + 提示停留这么久再收起窗口 */
const DONE_MS = 450;
/** 点中对象的容差、把手的抓取半径（屏幕像素）：细箭头、小把手也好抓 */
const HIT_SLOP = 8;
const HANDLE_REACH = 11;
/** 拖拽小于这么多屏幕像素算误点，不留下对象 */
const MIN_DRAG = 4;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeOut = (value: number) => 1 - Math.pow(1 - value, 3);

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);
const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";

type Drag =
  | { kind: "draw"; id: number; before: Shape[]; anchor: Point }
  | { kind: "move"; id: number; before: Shape[]; start: Point; origin: Shape; moved: boolean }
  | { kind: "resize"; id: number; before: Shape[]; handle: Handle; origin: Shape; moved: boolean };
type Editing = { id: number; isNew: boolean; before: Shape[] };
type Finish = "annotate_copy" | "annotate_save_copy" | "annotate_save";
type Toast = { text: string; key: number; leaving: boolean };

const TOOL_KEYS: Record<string, Tool> = { v: "select", a: "arrow", r: "rect", o: "ellipse", p: "pen", h: "highlight", t: "text", n: "step", m: "mosaic" };

function StepIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="an-glyph">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 5.6 8.4 4.8v6.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MosaicIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="an-glyph">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 2.6h3.8v3.8H2.6zM6.4 6.4h3.2v3.2H6.4zM9.6 2.6h3.8v3.8H9.6zM2.6 9.6h3.8v3.8H2.6zM9.6 9.6h3.8v3.8H9.6z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/**
 * 截后标注：箭头、方框、椭圆、画笔、荧光笔、文字、步骤编号、马赛克。
 * 每个标注都是对象：点中可移动、拖把手改大小、换颜色粗细、Delete 删除、双击文字改字，撤销/重做覆盖全部操作。
 * 关闭用窗口自己的关闭键（或 Esc / ⌘W），工具栏里不重复一个「关闭」。
 */
export function AnnotateWindow() {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const original = useRef<HTMLImageElement | null>(null);
  const ratioRef = useRef(1);
  const loadVersion = useRef(0);
  const nextId = useRef(1);
  const drag = useRef<Drag | null>(null);
  const past = useRef<Shape[][]>([]);
  const future = useRef<Shape[][]>([]);
  const escArmedAt = useRef(0);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  // 只在屏幕上的动效状态：放在 ref 里，由逐帧绘制读取，不触发 React 重渲染
  const hoverRef = useRef<number | null>(null);
  const appearRef = useRef(new Map<number, { start: number; pop: boolean }>());
  const ghostsRef = useRef<Array<{ shape: Shape; index: number; start: number }>>([]);
  const selectionAnim = useRef<{ id: number; start: number } | null>(null);
  const frameRef = useRef(0);
  const toastTimer = useRef(0);
  const toastKey = useRef(0);

  const [shapes, setShapesState] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  const [selectedId, setSelectedState] = useState<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [historyTick, setHistoryTick] = useState(0);
  const [ready, setReady] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<Size>(1);
  const [styleOpen, setStyleOpenState] = useState(false);
  const [styleClosing, setStyleClosing] = useState(false);
  const [pill, setPill] = useState<{ x: number; width: number; animate: boolean } | null>(null);
  const [done, setDone] = useState<Finish | null>(null);
  const [title, setTitle] = useState("");
  // 工具栏放工具，来源应用名写进窗口标题（调度中心、窗口菜单里看得到）
  useWindowTitle(title ? t("标注 · {app}", { app: title }) : t("标注截图"));
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);

  /** 底部提示条：`hideAfter` 毫秒后淡出；不传就一直显示（读取中、没有截图） */
  const setStatus = useCallback((text: string, hideAfter?: number) => {
    window.clearTimeout(toastTimer.current);
    if (!text) {
      setToast((current) => (current ? { ...current, leaving: true } : null));
      toastTimer.current = window.setTimeout(() => setToast(null), reducedMotion() ? 0 : MOTION.toast);
      return;
    }
    setToast((current) => (current && current.text === text && !current.leaving ? current : { text, key: ++toastKey.current, leaving: false }));
    if (hideAfter) toastTimer.current = window.setTimeout(() => setStatus(""), hideAfter);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const setStyleOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setStyleOpenState((open) => {
      const value = typeof next === "function" ? next(open) : next;
      if (open && !value) setStyleClosing(true);
      if (value) setStyleClosing(false);
      return value;
    });
  }, []);
  // 弹层收起时先缩小淡出，再卸载
  useEffect(() => {
    if (!styleClosing) return;
    const timer = window.setTimeout(() => setStyleClosing(false), reducedMotion() ? 0 : MOTION.pop);
    return () => window.clearTimeout(timer);
  }, [styleClosing]);

  const setShapes = (next: Shape[]) => {
    shapesRef.current = next;
    setShapesState(next);
  };
  const select = (id: number | null) => {
    if (id != null && id !== selectedRef.current) selectionAnim.current = { id, start: performance.now() };
    selectedRef.current = id;
    setSelectedState(id);
  };
  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  /** 被删掉的淡出，被恢复的淡入：只做视觉，状态立即生效，连按撤销也不会被拖慢 */
  const animateDiff = (before: Shape[], after: Shape[]) => {
    if (reducedMotion()) return;
    const now = performance.now();
    const kept = new Set(after.map((shape) => shape.id));
    const had = new Set(before.map((shape) => shape.id));
    before.forEach((shape, index) => {
      if (!kept.has(shape.id)) ghostsRef.current.push({ shape, index, start: now });
    });
    ghostsRef.current = ghostsRef.current.slice(-40);
    for (const shape of after) if (!had.has(shape.id)) appearRef.current.set(shape.id, { start: now, pop: false });
  };

  /** 一步可撤销的编辑：记下编辑前的样子，新的编辑让重做失效 */
  const commit = (before: Shape[], next: Shape[]) => {
    past.current = [...past.current, before].slice(-HISTORY_LIMIT);
    future.current = [];
    setShapes(next);
    setHistoryTick((value) => value + 1);
  };

  const loadImage = useCallback(async () => {
    const version = ++loadVersion.current;
    setReady(false);
    setNatural(null);
    setStatus(t("正在读取截图…"));
    drag.current = null;
    original.current = null;
    past.current = [];
    future.current = [];
    escArmedAt.current = 0;
    shapesRef.current = [];
    setShapesState([]);
    selectedRef.current = null;
    setSelectedState(null);
    editingRef.current = null;
    setEditingState(null);
    setStyleOpenState(false);
    setStyleClosing(false);
    setDone(null);
    setBusy(false);
    hoverRef.current = null;
    appearRef.current.clear();
    ghostsRef.current = [];
    setHistoryTick((value) => value + 1);
    try {
      const [dataUrl, nextTitle] = await Promise.all([
        invoke<string | null>("get_annotate_image"),
        invoke<string>("annotate_get_title"),
      ]);
      if (version !== loadVersion.current) return;
      setTitle(nextTitle);
      if (!dataUrl) {
        const canvas = canvasRef.current;
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        setStatus(t("没有待标注的截图"));
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (version !== loadVersion.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        // 截图是按屏幕像素密度拍的：粗细、字号按逻辑点换算，Retina 上看起来和普通屏一样大
        ratioRef.current = Math.max(1, window.devicePixelRatio || 1);
        original.current = img;
        setNatural({ width: img.naturalWidth, height: img.naturalHeight });
        setReady(true);
        setStatus("");
      };
      img.onerror = () => {
        if (version === loadVersion.current) setStatus(t("图片加载失败"));
      };
      img.src = dataUrl;
    } catch (error) {
      if (version === loadVersion.current) setStatus(localizeMessage(error instanceof Error ? error.message : String(error)));
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen("annotate-ready", () => {
      void loadImage();
    }).then((fn) => {
      if (!alive) { fn(); return; }
      unlisten = fn;
      void loadImage();
    });
    return () => {
      alive = false;
      loadVersion.current++;
      unlisten?.();
    };
  }, [loadImage]);

  // 截图按逻辑像素 1:1 显示（Retina 上清晰），放不下才等比缩小；窗口由后端按图开好，通常正好装下。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !natural) {
      setDisplay(null);
      return;
    }
    const fit = () => {
      const style = getComputedStyle(stage);
      const width = stage.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      const height = stage.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
      const logicalWidth = natural.width / ratioRef.current;
      const logicalHeight = natural.height / ratioRef.current;
      const scale = width > 0 && height > 0 ? Math.min(1, width / logicalWidth, height / logicalHeight) : 1;
      setDisplay({ width: Math.max(1, Math.floor(logicalWidth * scale)), height: Math.max(1, Math.floor(logicalHeight * scale)) });
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [natural]);

  /** 一个屏幕像素对应多少原图像素 */
  const screenScale = () => {
    const canvas = canvasRef.current;
    if (!canvas) return 1;
    const width = canvas.getBoundingClientRect().width;
    return width > 0 ? canvas.width / width : 1;
  };

  const measure = () => {
    const ctx = canvasRef.current?.getContext("2d");
    return ctx && typeof ctx.measureText === "function" ? textMeasurer(ctx, ratioRef.current) : undefined;
  };

  // 逐帧绘制：读 ref 里的最新对象，拖拽时不经过 React，一帧最多画一次；有动效时继续下一帧
  const paint = () => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !original.current) return;
    const now = performance.now();
    const still = reducedMotion();
    let animating = false;
    const progress = (start: number, duration: number) => {
      if (still) return 1;
      const value = Math.min(1, Math.max(0, (now - start) / duration));
      if (value < 1) animating = true;
      return value;
    };
    const alpha = new Map<number, number>();
    const scale = new Map<number, number>();
    for (const [id, item] of appearRef.current) {
      const value = progress(item.start, MOTION.appear);
      if (value >= 1) {
        appearRef.current.delete(id);
        continue;
      }
      alpha.set(id, easeOut(value));
      if (item.pop) scale.set(id, 0.6 + 0.4 * easeOut(value));
    }
    const ghosts = ghostsRef.current
      .map((ghost) => ({ ...ghost, value: progress(ghost.start, MOTION.fade) }))
      .filter((ghost) => ghost.value < 1);
    ghostsRef.current = ghosts.map(({ shape, index, start }) => ({ shape, index, start }));
    const selection = selectionAnim.current;
    const selectedId = drag.current?.kind === "draw" ? null : selectedRef.current;
    const selectionProgress = selection && selection.id === selectedId ? easeOut(progress(selection.start, MOTION.handles)) : 1;
    renderScene(ctx, {
      image: original.current,
      width: canvas.width,
      height: canvas.height,
      shapes: shapesRef.current,
      ratio: ratioRef.current,
      selectedId,
      hiddenId: editingRef.current?.id ?? null,
      pixelsPerScreenPixel: screenScale(),
      hoverId: drag.current ? null : hoverRef.current,
      alpha,
      scale,
      ghosts: ghosts.map((ghost) => ({ shape: ghost.shape, index: ghost.index, alpha: 1 - easeOut(ghost.value) })),
      selectionProgress,
    });
    if (animating) schedule();
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  function schedule() {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => paintRef.current());
  }
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  /** 拖拽中的实时更新：只改 ref 并排一帧，松手时再一次性提交给 React */
  const setLive = (next: Shape[]) => {
    shapesRef.current = next;
    schedule();
  };

  // 对象、选中或尺寸变化时重画
  useEffect(() => {
    if (ready) schedule();
  }, [shapes, selectedId, editing, ready, display]);

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // 拖出画布也照样跟手，但点落在图片边上，不会画到图外面去
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * (canvas.height / rect.height))),
    };
  }

  /** 把手的抓取半径：一般 11px；对象很小时收窄，免得想拖边线移动却抓到了角 */
  const handleReach = (shape: Shape, unit: number) => {
    const size =
      shape.type === "arrow" ? Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1)
      : "w" in shape ? Math.min(shape.w, shape.h)
      : Infinity;
    return Math.min(HANDLE_REACH * unit, Math.max(6 * unit, size * 0.4));
  };
  const shapeById = (id: number | null) => (id == null ? null : shapesRef.current.find((shape) => shape.id === id) ?? null);
  const replace = (list: Shape[], next: Shape) => list.map((shape) => (shape.id === next.id ? next : shape));

  // ---------- 文字 ----------

  function startEditing(shape: TextShape, isNew: boolean, before: Shape[]) {
    setEditing({ id: shape.id, isNew, before });
    setDraft(shape.text);
    select(shape.id);
  }

  /** 回车或点别处：把输入框里的字落成对象；清空了就删掉这个文字 */
  function commitText(): Shape[] {
    const current = editingRef.current;
    if (!current) return shapesRef.current;
    setEditing(null);
    const text = (textRef.current?.value ?? draft).replace(/\s+$/, "");
    const shape = shapeById(current.id) as TextShape | null;
    let next: Shape[];
    if (!shape || !text.trim()) {
      next = shapesRef.current.filter((item) => item.id !== current.id);
      select(null);
    } else {
      next = replace(shapesRef.current, { ...shape, text });
    }
    const previous = current.before.find((item) => item.id === current.id);
    const unchanged = !current.isNew && shape && JSON.stringify(previous) === JSON.stringify({ ...shape, text });
    // 新建的文字没打字就点走了：等于没发生过，不占一步撤销
    if (unchanged || (current.isNew && (!shape || !text.trim()))) setShapes(current.before);
    else commit(current.before, next);
    return shapesRef.current;
  }

  function cancelText() {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    setShapes(current.before);
    if (current.isNew) select(null);
  }

  // ---------- 指针 ----------

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || busy || event.button !== 0 || drag.current) return;
    setStyleOpen(false);
    escArmedAt.current = 0;
    if (editingRef.current) {
      commitText();
      return;
    }
    const point = canvasPoint(event);
    const unit = screenScale();
    const ratio = ratioRef.current;
    const before = shapesRef.current;
    const selected = shapeById(selectedRef.current);
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const handle = selected ? handleAt(selected, point, handleReach(selected, unit)) : null;
    if (selected && handle) {
      drag.current = { kind: "resize", id: selected.id, before, handle, origin: selected, moved: false };
      return;
    }
    const hit = topHit(before, point, HIT_SLOP * unit, ratio, measure());
    if (hit) {
      if (tool === "text" && hit.type === "text") {
        startEditing(hit, false, before);
        return;
      }
      select(hit.id);
      drag.current = { kind: "move", id: hit.id, before, start: point, origin: hit, moved: false };
      return;
    }
    if (tool === "select") {
      select(null);
      return;
    }
    const id = nextId.current++;
    const base = { id, color, size };
    if (tool === "text") {
      const shape: TextShape = { ...base, type: "text", x: point.x, y: point.y - lineHeight(size, ratio) / 2, text: "" };
      setShapes([...before, shape]);
      startEditing(shape, true, before);
      return;
    }
    if (tool === "step") {
      if (!reducedMotion()) appearRef.current.set(id, { start: performance.now(), pop: true });
      commit(before, [...before, { ...base, type: "step", x: point.x, y: point.y, n: nextStep(before) }]);
      select(id);
      return;
    }
    const drawTool = tool as Exclude<DrawTool, "text" | "step">;
    const shape: Shape =
      drawTool === "arrow" ? { ...base, type: "arrow", x1: point.x, y1: point.y, x2: point.x, y2: point.y }
      : drawTool === "pen" || drawTool === "highlight" ? { ...base, type: drawTool, points: [point] }
      : { ...base, type: drawTool, x: point.x, y: point.y, w: 0, h: 0 };
    select(null);
    hoverRef.current = null;
    drag.current = { kind: "draw", id, before, anchor: point };
    setLive([...before, shape]);
  }

  function hoverCursor(point: Point) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const unit = screenScale();
    const selected = shapeById(selectedRef.current);
    const handle = selected ? handleAt(selected, point, handleReach(selected, unit)) : null;
    const hit = handle ? null : topHit(shapesRef.current, point, HIT_SLOP * unit, ratioRef.current, measure());
    const hoverId = hit?.id ?? null;
    if (hoverId !== hoverRef.current) {
      hoverRef.current = hoverId;
      schedule();
    }
    canvas.style.cursor =
      handle === "nw" || handle === "se" ? "nwse-resize"
      : handle === "ne" || handle === "sw" ? "nesw-resize"
      : handle ? "move"
      : hit ? (tool === "text" && hit.type === "text" ? "text" : "move")
      : tool === "select" ? "default"
      : tool === "text" ? "text"
      : "crosshair";
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event);
    const current = drag.current;
    if (!current) {
      if (ready) hoverCursor(point);
      return;
    }
    const shape = shapeById(current.id);
    if (!shape) return;
    if (current.kind === "draw") {
      let next: Shape = shape;
      if (shape.type === "arrow") {
        const end = event.shiftKey ? snapAngle(current.anchor, point) : point;
        next = { ...shape, x2: end.x, y2: end.y };
      } else if (shape.type === "pen" || shape.type === "highlight") {
        // 快速划动时一帧里会合并好几个点，全取上，线条不会变成折线
        const native = event.nativeEvent as PointerEvent;
        const extra = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents().map((item) => canvasPoint(item as unknown as React.PointerEvent<HTMLCanvasElement>)) : [];
        next = { ...shape, points: [...shape.points, ...(extra.length ? extra : [point])] };
      } else if (shape.type === "rect" || shape.type === "ellipse" || shape.type === "mosaic") {
        const end = event.shiftKey ? squareFrom(current.anchor, point) : point;
        next = { ...shape, x: Math.min(current.anchor.x, end.x), y: Math.min(current.anchor.y, end.y), w: Math.abs(end.x - current.anchor.x), h: Math.abs(end.y - current.anchor.y) };
      }
      setLive(replace(shapesRef.current, next));
    } else if (current.kind === "move") {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < 2 * screenScale()) return;
      current.moved = true;
      setLive(replace(shapesRef.current, moveShape(current.origin, dx, dy)));
    } else {
      current.moved = true;
      setLive(replace(shapesRef.current, resizeShape(current.origin, current.handle, point, event.shiftKey)));
    }
  }

  function onPointerUp() {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (current.kind === "draw") {
      const shape = shapeById(current.id);
      if (!shape || isTooSmall(shape, MIN_DRAG * screenScale())) {
        setShapes(current.before);
        schedule();
        return;
      }
      commit(current.before, shapesRef.current);
      select(shape.id);
    } else if (current.moved) {
      commit(current.before, shapesRef.current);
    }
  }

  /** 拖到一半按 Esc：这一笔/这次拖动作废，回到按下前 */
  function cancelDrag() {
    const current = drag.current;
    if (!current) return false;
    drag.current = null;
    setShapes(current.before);
    if (current.kind === "draw") select(null);
    schedule();
    return true;
  }

  function onPointerLeave() {
    if (drag.current || hoverRef.current == null) return;
    hoverRef.current = null;
    schedule();
  }

  function onDoubleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!ready || busy) return;
    const hit = topHit(shapesRef.current, canvasPoint(event), HIT_SLOP * screenScale(), ratioRef.current, measure());
    if (hit?.type === "text") startEditing(hit, false, shapesRef.current);
  }

  // ---------- 编辑命令 ----------

  function undo() {
    if (editingRef.current) commitText();
    if (!ready || busy || drag.current || !past.current.length) return;
    const previous = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, shapesRef.current];
    animateDiff(shapesRef.current, previous);
    setShapes(previous);
    if (!previous.some((shape) => shape.id === selectedRef.current)) select(null);
    setHistoryTick((value) => value + 1);
  }

  function redo() {
    if (editingRef.current) commitText();
    if (!ready || busy || drag.current || !future.current.length) return;
    const next = future.current[future.current.length - 1];
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, shapesRef.current];
    animateDiff(shapesRef.current, next);
    setShapes(next);
    if (!next.some((shape) => shape.id === selectedRef.current)) select(null);
    setHistoryTick((value) => value + 1);
  }

  function removeSelected() {
    const id = selectedRef.current;
    if (id == null || !shapeById(id)) return;
    const next = shapesRef.current.filter((shape) => shape.id !== id);
    animateDiff(shapesRef.current, next);
    commit(shapesRef.current, next);
    select(null);
  }

  function clearAll() {
    if (editingRef.current) cancelText();
    if (!ready || busy || !shapesRef.current.length) return;
    animateDiff(shapesRef.current, []);
    commit(shapesRef.current, []);
    select(null);
  }

  function nudge(dx: number, dy: number) {
    const shape = shapeById(selectedRef.current);
    if (!shape) return;
    commit(shapesRef.current, replace(shapesRef.current, moveShape(shape, dx, dy)));
  }

  /** 颜色、粗细：用于下一笔，也立即改到选中的那个 */
  function applyStyle(change: { color?: string; size?: Size }) {
    if (busy) return;
    if (change.color) setColor(change.color);
    if (change.size !== undefined) setSize(change.size);
    const shape = shapeById(selectedRef.current);
    if (!shape) return;
    const next = { ...shape, ...change } as Shape;
    if (editingRef.current?.id === shape.id) setShapes(replace(shapesRef.current, next));
    else commit(shapesRef.current, replace(shapesRef.current, next));
  }

  function chooseTool(next: Tool) {
    if (busy) return;
    if (editingRef.current) commitText();
    setTool(next);
    if (next !== "select") select(null);
  }

  // ---------- 导出 ----------

  /** 按原图分辨率重画一遍（不带选中框），所以 Retina 截图导出也是清晰的原尺寸 */
  async function exportPng(): Promise<string> {
    const canvas = canvasRef.current;
    if (!canvas || !ready || !original.current) throw new Error(t("截图尚未加载完成"));
    const list = editingRef.current ? commitText() : shapesRef.current;
    const output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = canvas.height;
    const ctx = output.getContext("2d");
    if (!ctx) throw new Error(t("截图尚未加载完成"));
    renderScene(ctx, { image: original.current, width: output.width, height: output.height, shapes: list, ratio: ratioRef.current });
    return output.toDataURL("image/png");
  }

  /**
   * 三个出口共用：导出当前画面交给后端。成功后按钮打勾、底部给一句结果，
   * 停留不到半秒再收起窗口，确认「真的复制/存好了」。另存为取消时什么都不收。
   */
  async function finish(command: Finish) {
    if (!ready || busy) return;
    const version = loadVersion.current;
    setBusy(true);
    setStatus("");
    try {
      const imageData = await exportPng();
      const message = await invoke<string | null>(command, { imageData });
      if (version !== loadVersion.current) return;
      if (message == null) {
        setStatus(t("已取消另存，标注仍保留"), 2400);
        setBusy(false);
        return;
      }
      setDone(command);
      setStatus(localizeMessage(message));
      window.setTimeout(() => {
        if (version === loadVersion.current) void close();
      }, reducedMotion() ? 200 : DONE_MS);
    } catch (error) {
      setStatus(localizeMessage(error instanceof Error ? error.message : String(error)), 4000);
      setBusy(false);
    }
  }

  async function close() {
    await invoke("annotate_close");
  }

  function onEscape() {
    if (busy) return;
    if (cancelDrag()) return;
    if (styleOpen) {
      setStyleOpen(false);
      return;
    }
    if (selectedRef.current != null) {
      select(null);
      return;
    }
    const now = Date.now();
    if (!shapesRef.current.length || now - escArmedAt.current < ESC_CONFIRM_MS) {
      escArmedAt.current = 0;
      void close();
      return;
    }
    escArmedAt.current = now;
    setStatus(t("再按一次 Esc 放弃标注并关闭"), ESC_CONFIRM_MS);
  }

  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event: KeyboardEvent) => {
    if (event.isComposing || event.target instanceof HTMLTextAreaElement) return;
    const command = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const step = (event.shiftKey ? 10 : 1) * ratioRef.current;
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
    } else if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (command && key === "y" && !isMac) {
      event.preventDefault();
      redo();
    } else if (command && key === "c" && !event.shiftKey) {
      event.preventDefault();
      void finish("annotate_copy");
    } else if (command && key === "s") {
      event.preventDefault();
      void finish(event.shiftKey ? "annotate_save" : "annotate_save_copy");
    } else if (command && key === "w") {
      event.preventDefault();
      void close();
    } else if (command || event.altKey || !ready || busy) {
      return;
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelected();
    } else if (event.key.startsWith("Arrow") && selectedRef.current != null) {
      event.preventDefault();
      nudge(event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
    } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      const selected = shapeById(selectedRef.current);
      if (selected?.type === "text") startEditing(selected, false, shapesRef.current);
      else void finish("annotate_copy");
    } else if (!event.shiftKey && TOOL_KEYS[key]) {
      event.preventDefault();
      chooseTool(TOOL_KEYS[key]);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 颜色/粗细弹层：点到外面就收起
  useEffect(() => {
    if (!styleOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!styleRef.current?.contains(event.target as Node)) setStyleOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [styleOpen]);

  // 输入框一出现就拿到焦点（等这次按下的默认行为过去，不然焦点会被画布抢走）
  const editingId = editing?.id ?? null;
  useLayoutEffect(() => {
    if (editingId == null) return;
    const focus = () => {
      const area = textRef.current;
      if (!area || document.activeElement === area) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    };
    focus();
    const timer = window.setTimeout(focus, 0);
    return () => window.clearTimeout(timer);
  }, [editingId]);

  // 输入框跟着字变宽变高
  const editingShape = editing ? (shapes.find((shape) => shape.id === editing.id) as TextShape | undefined) : undefined;
  useLayoutEffect(() => {
    const area = textRef.current;
    if (!area) return;
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.width = `${area.scrollWidth + 4}px`;
    area.style.height = `${area.scrollHeight}px`;
  }, [draft, editingShape?.size, display]);

  function textEditor() {
    const canvas = canvasRef.current;
    if (!editingShape || !canvas) return null;
    const unit = screenScale();
    const ratio = ratioRef.current;
    const font = fontSize(editingShape.size, ratio) / unit;
    const light = isLightColor(editingShape.color);
    return (
      <textarea
        ref={textRef}
        className={`annotate-text${light ? " is-light" : ""}`}
        aria-label={t("文字")}
        value={draft}
        rows={1}
        wrap="off"
        spellCheck={false}
        style={{
          left: canvas.offsetLeft + editingShape.x / unit,
          top: canvas.offsetTop + editingShape.y / unit,
          font: textFont(editingShape, ratio).replace(/[\d.]+px/, `${font}px`),
          lineHeight: `${lineHeight(editingShape.size, ratio) / unit}px`,
          color: editingShape.color,
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commitText()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commitText();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelText();
          }
        }}
      />
    );
  }

  // 工具栏选中底色：一块底色在工具之间滑动，而不是逐个按钮闪
  useLayoutEffect(() => {
    const group = toolsRef.current;
    const button = group?.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
    if (!group || !button) return;
    const next = { x: button.offsetLeft, width: button.offsetWidth };
    setPill((current) => (current && current.x === next.x && current.width === next.width ? current : { ...next, animate: current != null && !reducedMotion() }));
  }, [tool, ready]);

  // 导出和「已复制」确认这一小会儿只拦操作（各命令自己看 busy），不把整条工具栏变灰，免得闪一下
  const locked = !ready;
  void historyTick;
  const toolButton = (value: Tool, label: string, key: string, icon: ReactNode) => (
    <button
      type="button"
      className={`an-btn is-icon${tool === value ? " is-on" : ""}`}
      data-tool={value}
      aria-label={label}
      title={`${label}  ${key}`}
      aria-pressed={tool === value}
      disabled={locked}
      onClick={() => chooseTool(value)}
    >
      {icon}
    </button>
  );
  const colorNames: Record<string, string> = {
    "#ff3b30": t("红色"), "#ffcc00": t("黄色"), "#34c759": t("绿色"), "#007aff": t("蓝色"), "#1d1d1f": t("黑色"), "#ffffff": t("白色"),
  };
  const selectedShape = shapes.find((shape) => shape.id === selectedId);
  const shownColor = selectedShape?.color ?? color;
  const shownSize = selectedShape?.size ?? size;
  const sizeNames = [t("细"), t("中"), t("粗")];

  return (
    <div className={`annotate-root${isMac ? " is-mac" : ""}${busy ? " is-busy" : ""}`}>
      <header className="annotate-toolbar" data-tauri-drag-region>
        <div className="annotate-group is-tools" role="group" aria-label={t("标注工具")} ref={toolsRef}>
          {pill ? (
            <span
              className={`annotate-pill${pill.animate ? " is-moving" : ""}`}
              aria-hidden="true"
              style={{ width: pill.width, transform: `translateX(${pill.x}px)` }}
            />
          ) : null}
          {toolButton("select", t("选择"), "V", <MousePointer2 aria-hidden="true" />)}
          <span className="annotate-sep" aria-hidden="true" />
          {toolButton("arrow", t("箭头"), "A", <MoveUpRight aria-hidden="true" />)}
          {toolButton("rect", t("矩形"), "R", <Square aria-hidden="true" />)}
          {toolButton("ellipse", t("椭圆"), "O", <Circle aria-hidden="true" />)}
          {toolButton("pen", t("画笔"), "P", <PenLine aria-hidden="true" />)}
          {toolButton("highlight", t("荧光笔"), "H", <Highlighter aria-hidden="true" />)}
          <span className="annotate-sep" aria-hidden="true" />
          {toolButton("text", t("文字"), "T", <Type aria-hidden="true" />)}
          {toolButton("step", t("编号"), "N", <StepIcon />)}
          {toolButton("mosaic", t("马赛克"), "M", <MosaicIcon />)}
        </div>
        <span className="annotate-sep" aria-hidden="true" />
        <div className="annotate-style" ref={styleRef}>
          <button
            type="button"
            className="an-btn is-icon"
            aria-label={t("颜色和粗细")}
            title={t("颜色和粗细")}
            aria-haspopup="true"
            aria-expanded={styleOpen}
            disabled={locked}
            onClick={() => setStyleOpen((open) => !open)}
          >
            <span className={`an-swatch is-size-${shownSize}`} style={{ background: shownColor }} />
          </button>
          {(styleOpen || styleClosing) && (
            <div
              className={`annotate-pop${styleOpen ? "" : " is-closing"}`}
              role="dialog"
              aria-label={t("颜色和粗细")}
              aria-hidden={styleOpen ? undefined : true}
            >
              <div className="annotate-swatches" role="radiogroup" aria-label={t("颜色")}>
                {COLORS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={shownColor === value}
                    aria-label={colorNames[value]}
                    title={colorNames[value]}
                    className={`annotate-swatch${shownColor === value ? " is-on" : ""}`}
                    style={{ background: value }}
                    onClick={() => applyStyle({ color: value })}
                  />
                ))}
              </div>
              <div className="annotate-sizes" role="radiogroup" aria-label={t("粗细")}>
                {([0, 1, 2] as Size[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={shownSize === value}
                    aria-label={sizeNames[value]}
                    title={sizeNames[value]}
                    className={`annotate-size${shownSize === value ? " is-on" : ""}`}
                    onClick={() => applyStyle({ size: value })}
                  >
                    <span style={{ width: 4 + value * 4, height: 4 + value * 4 }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="annotate-sep" aria-hidden="true" />
        <div className="annotate-group">
          <button type="button" className="an-btn is-icon" aria-label={t("撤销")} title={`${t("撤销")}  ${mod}Z`} disabled={locked || !past.current.length} onClick={undo}>
            <Undo2 aria-hidden="true" />
          </button>
          <button type="button" className="an-btn is-icon" aria-label={t("重做")} title={`${t("重做")}  ${shift}${mod}Z`} disabled={locked || !future.current.length} onClick={redo}>
            <Redo2 aria-hidden="true" />
          </button>
          <button type="button" className="an-btn is-icon" aria-label={t("清空标注")} title={t("清空标注")} disabled={locked || !shapes.length} onClick={clearAll}>
            <Eraser aria-hidden="true" />
          </button>
        </div>
        <span className="annotate-fill" data-tauri-drag-region />
        <div className="annotate-group is-actions">
          <button type="button" className={`an-btn is-icon${done === "annotate_save" ? " is-done" : ""}`} aria-label={t("另存为…")} title={`${t("另存为…")}  ${shift}${mod}S`} disabled={locked} onClick={() => void finish("annotate_save")}>
            {done === "annotate_save" ? <Check aria-hidden="true" className="an-check" /> : <Download aria-hidden="true" />}
          </button>
          <button type="button" className={`an-btn is-icon${done === "annotate_save_copy" ? " is-done" : ""}`} aria-label={t("存入截图记录")} title={`${t("存入截图记录")}  ${mod}S`} disabled={locked} onClick={() => void finish("annotate_save_copy")}>
            {done === "annotate_save_copy" ? <Check aria-hidden="true" className="an-check" /> : <Archive aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`an-btn is-primary${done === "annotate_copy" ? " is-done" : ""}`}
            aria-label={t("复制")}
            title={`${t("复制")}  ${mod}C`}
            disabled={locked}
            onClick={() => void finish("annotate_copy")}
          >
            {done === "annotate_copy" ? (
              <>
                <Check aria-hidden="true" className="an-check" />
                {t("已复制")}
              </>
            ) : t("复制")}
          </button>
        </div>
      </header>
      <div className="annotate-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          aria-label={t("截图标注画布")}
          className={`annotate-canvas${ready ? "" : " is-empty"}`}
          style={display ? { width: display.width, height: display.height } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
          onContextMenu={(event) => event.preventDefault()}
        />
        {textEditor()}
        {toast ? (
          <div key={toast.key} className={`annotate-status${toast.leaving ? " is-leaving" : ""}`} role="status">
            {toast.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
