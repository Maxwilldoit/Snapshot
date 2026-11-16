/**
 * 滚轮定速：把系统滚轮的原始增量收进来，按固定步长逐帧释放。
 *
 * - 跟手：第一帧立即走一小步，之后的追赶用指数趋近（约 70ms 时间常数），
 *   停手后余量在一百多毫秒内走完，不拖尾。
 * - 不快：每格滚轮固定 48px（系统原始一格常是 100px 还带惯性加速），
 *   连续快滚时排队总量封顶在两屏内，甩动滚轮不会一下飞出几屏。
 * - 触控板（像素级连续增量）保持系统原生手感，不拦截。
 * - 尊重 reduced-motion：直接按缩放后的步长瞬移，不做逐帧动画。
 */

/** 每格滚轮走的像素 */
export const WHEEL_STEP_PX = 48;
/** 一格的名义增量：把不同设备的 delta 归一成「格数」 */
const NOTCH_DELTA = 100;
/** 排队余量上限：约两屏 */
const MAX_PENDING_SCREENS = 2;
/** 指数趋近时间常数（毫秒）：越小越跟手，越大越绵 */
const SETTLE_MS = 70;
/** 余量小于该像素数时直接落定，避免长尾抖动 */
const EPSILON_PX = 0.5;

export function wheelNotches(delta: number, mode: number): number {
  if (mode === 1) return delta / 3; // 常见滚轮一格为三行，归一后约 48px
  if (mode === 2) return delta * 3; // 页：一页按三格折算，配合封顶不至于翻页失控
  return delta / NOTCH_DELTA;
}

export function wheelStep(delta: number, mode: number, viewport: number): number {
  const notches = wheelNotches(delta, mode);
  const cap = Math.max(viewport * MAX_PENDING_SCREENS, WHEEL_STEP_PX);
  return Math.max(-cap, Math.min(cap, notches * WHEEL_STEP_PX));
}

/** 判定一次 wheel 是否走定速通道：鼠标滚轮（行/页/大颗粒像素）才拦。 */
export function isNotchedWheel(event: Pick<WheelEvent, "deltaMode" | "deltaY" | "deltaX" | "ctrlKey" | "shiftKey">): boolean {
  if (event.ctrlKey || event.shiftKey) return false; // 缩放与横向滚动交给原生
  if (event.deltaY === 0) return false;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  if (event.deltaMode !== 0) return true; // 行 / 页模式一定是滚轮
  // 像素模式：整数且步幅大的是鼠标滚轮；触控板是带小数的连续小步
  return Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 40;
}

type Scrollable = HTMLElement;

/** 从事件目标向上找最近的竖向可滚动容器；到 stopAt 为止。 */
function findWheelScroller(target: EventTarget | null, stopAt: HTMLElement): HTMLElement | null {
  let node = target instanceof Element ? target : null;
  while (node && node !== stopAt.parentElement) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 挂到某个窗口根上：滚轮事件在捕获阶段拦截，命中可滚容器时走定速。
 * 返回卸载函数。同一容器的连续滚动共享一个余量池。
 */
export function installWheelPace(root: HTMLElement): () => void {
  let scroller: Scrollable | null = null;
  let pending = 0;
  let raf = 0;
  let last = 0;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const settle = (now: number) => {
    raf = 0;
    const target = scroller;
    if (!target || pending === 0) return;
    const dt = Math.min(now - last, 64);
    last = now;
    const max = target.scrollHeight - target.clientHeight;
    // 朝边界滚时把余量裁掉，不在墙上积累「欠账」
    if ((pending > 0 && target.scrollTop >= max - EPSILON_PX) || (pending < 0 && target.scrollTop <= EPSILON_PX)) {
      pending = 0;
      return;
    }
    const share = 1 - Math.exp(-dt / SETTLE_MS);
    let step = pending * share;
    if (Math.abs(pending) - Math.abs(step) < EPSILON_PX) step = pending;
    // 至少走 1px，防止指数趋近在低刷新率下停滞
    if (step !== 0 && Math.abs(step) < 1) step = Math.sign(step) * Math.min(1, Math.abs(pending));
    target.scrollTop = Math.max(0, Math.min(max, target.scrollTop + step));
    pending -= step;
    if (pending !== 0) raf = requestAnimationFrame(settle);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !isNotchedWheel(event)) return;
    const target = findWheelScroller(event.target, root);
    if (!target) return;
    event.preventDefault();
    const step = wheelStep(event.deltaY, event.deltaMode, target.clientHeight);
    if (step === 0) return;
    if (reduced) {
      target.scrollTop += step;
      return;
    }
    if (target !== scroller) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scroller = target;
      pending = 0;
    }
    const cap = Math.max(target.clientHeight * MAX_PENDING_SCREENS, WHEEL_STEP_PX);
    pending = Math.max(-cap, Math.min(cap, pending + step));
    if (!raf) {
      last = performance.now();
      // 首帧立即释放约 1/4，让手指一动画面就动
      const head = pending * 0.25;
      target.scrollTop += head;
      pending -= head;
      if (pending !== 0) raf = requestAnimationFrame(settle);
    }
  };

  const cancelFor = (target: EventTarget | null) => {
    if (target === scroller) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = 0;
    }
  };
  // 原生滚动条拖动、点击轨道与切换页面均优先于滚轮余量。
  const onPointerDown = () => cancelFor(scroller);
  const onKeyDown = () => {
    if (scroller) cancelFor(scroller);
  };
  root.addEventListener("wheel", onWheel, { capture: true, passive: false });
  root.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  root.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  return () => {
    root.removeEventListener("wheel", onWheel, { capture: true });
    root.removeEventListener("pointerdown", onPointerDown, { capture: true });
    root.removeEventListener("keydown", onKeyDown, { capture: true });
    if (raf) cancelAnimationFrame(raf);
    scroller = null;
    pending = 0;
  };
}
