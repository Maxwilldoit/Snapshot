/**
 * 「照片」App 式查看器的纯数学层：坐标钳制、指数缩放锚点补偿、越界橡皮筋、
 * 临界阻尼弹簧与惯性衰减的解析步进、手势速度采样。全部不碰 DOM，便于单测。
 *
 * 坐标约定：视口左上角为原点，图片元素 transform-origin 固定 0 0，
 * 渲染只用 translate3d(tx, ty, 0) scale(s)；(tx, ty) 是图左上角在视口里的位置。
 */

export type Transform = { scale: number; tx: number; ty: number };
export type Size = { w: number; h: number };
export type Bounds = { minTx: number; maxTx: number; minTy: number; maxTy: number };

/** 手势中越界最多能拖出这么远（渐近线），松手后弹簧收回 */
const OVERSCROLL_LIMIT_PX = 140;
/** 离散鼠标滚轮单次事件的缩放变化上限 ±15% */
const NOTCHED_ZOOM_CLAMP = Math.log(1.15);

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 给定缩放下的合法平移范围：比视口小的轴强制居中（min == max），比视口大的轴限制在两端之间 */
export function boundsFor(scale: number, view: Size, base: Size): Bounds {
  const scaledW = base.w * scale;
  const scaledH = base.h * scale;
  const minTx = scaledW <= view.w ? (view.w - scaledW) / 2 : view.w - scaledW;
  const maxTx = scaledW <= view.w ? (view.w - scaledW) / 2 : 0;
  const minTy = scaledH <= view.h ? (view.h - scaledH) / 2 : view.h - scaledH;
  const maxTy = scaledH <= view.h ? (view.h - scaledH) / 2 : 0;
  return { minTx, maxTx, minTy, maxTy };
}

/** 动态边界：把任意 (scale, tx, ty) 投影回合法域 */
export function getClampedTransform(scale: number, tx: number, ty: number, view: Size, base: Size, maxScale: number): Transform {
  const s = clamp(scale, 1, maxScale);
  const b = boundsFor(s, view, base);
  return { scale: s, tx: clamp(tx, b.minTx, b.maxTx), ty: clamp(ty, b.minTy, b.maxTy) };
}

/**
 * 光标锚点不变性：以视口内 (cx, cy) 为锚做指数缩放。
 * nextScale = scale * exp(delta)；nextT = c - (c - t) * ratio。
 */
export function zoomAnchored(current: Transform, delta: number, cx: number, cy: number): Transform {
  const nextScale = current.scale * Math.exp(delta);
  const ratio = nextScale / current.scale;
  return {
    scale: nextScale,
    tx: cx - (cx - current.tx) * ratio,
    ty: cy - (cy - current.ty) * ratio,
  };
}

/**
 * 对数阻尼橡皮筋：越界距离 x 映射为 limit * (1 - 1/(x*c/limit + 1))。
 * 起点斜率为 c（跟手），越远越拖不动，渐近 limit。
 */
export function rubberBand(overflow: number, limit: number = OVERSCROLL_LIMIT_PX, c = 0.55): number {
  if (overflow <= 0) return 0;
  return (overflow * c * limit) / (overflow * c + limit);
}

/** 手势进行中：界内原样、越界部分按对数阻尼衰减（对称处理两端） */
export function rubberClamp(value: number, min: number, max: number, limit?: number): number {
  if (value < min) return min - rubberBand(min - value, limit);
  if (value > max) return max + rubberBand(value - max, limit);
  return value;
}

/**
 * 临界阻尼弹簧的解析解（无过冲）。omega 为固有角频率（rad/s），
 * 越大收得越快；30 左右约 150ms 内基本落定，接近 macOS 的回弹手感。
 * x 为相对目标的位移，v 为速度（单位/秒）。返回 dt 秒后的新状态。
 */
export function springStep(x: number, v: number, dt: number, omega: number): { x: number; v: number } {
  if (dt <= 0) return { x, v };
  const decay = Math.exp(-omega * dt);
  const tmp = v + omega * x;
  return {
    x: (x + tmp * dt) * decay,
    v: (v - omega * tmp * dt) * decay,
  };
}

/** 弹簧是否已落定（位移与速度都足够小） */
export function springSettled(x: number, v: number, epsilonX: number, epsilonV: number): boolean {
  return Math.abs(x) < epsilonX && Math.abs(v) < epsilonV;
}

/**
 * 惯性滑行：速度按时间常数指数衰减（UIScrollView 正常减速约 0.998/ms）。
 * 返回 dt 毫秒内的位移与衰减后的速度。
 */
export function momentumStep(v: number, dtMs: number, tauMs = 325): { delta: number; v: number } {
  const decay = Math.exp(-dtMs / tauMs);
  return { delta: v * tauMs * (1 - decay), v: v * decay };
}

/** 区分细腻触控板信号与离散鼠标滚轮（行/页模式或大颗粒整数像素） */
export function isNotchedZoom(event: Pick<WheelEvent, "deltaMode" | "deltaY">): boolean {
  return event.deltaMode !== 0 || Math.abs(event.deltaY) >= 40;
}

/**
 * 把 wheel 增量归一为对数缩放倍率。ctrl+wheel 是浏览器合成的捏合信号：
 * 触控板颗粒细、直接指数映射；鼠标滚轮降权并限幅单次 ±15%。
 */
export function zoomDeltaOf(deltaY: number, deltaMode: number, notched: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  if (notched) return clamp(-pixels * 0.0022, -NOTCHED_ZOOM_CLAMP, NOTCHED_ZOOM_CLAMP);
  return clamp(-pixels * 0.01, -0.45, 0.45);
}

export type VelocitySample = { t: number; tx: number; ty: number; scale: number };

/**
 * 手势速度环形缓冲区：保留最近 5 帧样本，用最小二乘线性回归求松手瞬间速度。
 * scale 用对数域回归（指数手势下 ln(s) 随时间近似线性），返回 vScale 为倍率/秒。
 */
export class VelocityTracker {
  private samples: VelocitySample[] = [];

  push(sample: VelocitySample): void {
    // 时间戳必须单调；同帧多个 wheel 事件合并成一条
    const last = this.samples[this.samples.length - 1];
    if (last && sample.t <= last.t) this.samples[this.samples.length - 1] = sample;
    else this.samples.push(sample);
    if (this.samples.length > 5) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  /** 最近一次样本距今超过 gapMs 视为手势已停，速度归零 */
  velocity(now: number, gapMs = 100): { vx: number; vy: number; vScale: number } {
    const n = this.samples.length;
    if (n < 2 || now - this.samples[n - 1].t > gapMs) return { vx: 0, vy: 0, vScale: 0 };
    let sumT = 0;
    let sumTT = 0;
    for (const s of this.samples) {
      const t = (s.t - this.samples[0].t) / 1000;
      sumT += t;
      sumTT += t * t;
    }
    const meanT = sumT / n;
    const denom = sumTT - n * meanT * meanT;
    if (denom < 1e-9) return { vx: 0, vy: 0, vScale: 0 };
    const slope = (pick: (s: VelocitySample) => number) => {
      let sum = 0;
      for (const s of this.samples) sum += ((s.t - this.samples[0].t) / 1000 - meanT) * pick(s);
      return sum / denom;
    };
    const vScaleLog = slope((s) => Math.log(Math.max(1e-4, s.scale)));
    const lastScale = this.samples[n - 1].scale;
    return {
      vx: slope((s) => s.tx),
      vy: slope((s) => s.ty),
      vScale: vScaleLog * lastScale,
    };
  }
}

/**
 * 双击缩放的直线轨迹：对数缩放进度 p 驱动（p 由弹簧推进），
 * 每一帧的平移由「锚点像素保持在从起点到终点的直线插值位置」反推，
 * 避免对 tx/ty/scale 各自独立缓动造成的弧线漂移。
 *
 * anchor 为视口内锚点；start/target 都是已钳制的合法变换。
 * u = (s - s0) / (s1 - s0) 是线性缩放进度，锚点像素位置按 u 直线插值。
 */
export function straightZoomFrame(
  start: Transform,
  target: Transform,
  anchor: { x: number; y: number },
  scale: number,
): Transform {
  const span = target.scale - start.scale;
  if (Math.abs(span) < 1e-6) return target;
  const u = clamp((scale - start.scale) / span, 0, 1);
  // 锚点在两张变换下的内容坐标一致（同一像素），屏幕位置从 anchor 直线滑向 target 下的位置
  const startPx = { x: anchor.x, y: anchor.y };
  const endPx = {
    x: target.tx + ((anchor.x - start.tx) / start.scale) * target.scale,
    y: target.ty + ((anchor.y - start.ty) / start.scale) * target.scale,
  };
  const px = startPx.x + (endPx.x - startPx.x) * u;
  const py = startPx.y + (endPx.y - startPx.y) * u;
  const contentX = (anchor.x - start.tx) / start.scale;
  const contentY = (anchor.y - start.ty) / start.scale;
  return { scale, tx: px - contentX * scale, ty: py - contentY * scale };
}

/** 1:1 原始分辨率或 8x 取大者，保证 retina 截图能放到原生像素。base 是已适应视口的显示尺寸 */
export function maxScaleFor(base: Size, natural: Size): number {
  if (!base.w || !natural.w) return 8;
  return Math.max(8, natural.w / base.w);
}
