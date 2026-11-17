/**
 * 历史截图墙的「同行等高自适应拼图（Justified）」排版与无级缩放参数：
 * - 按日期分组，每组内用动态规划选最优断行，让每行高度贴近当前缩放目标行高，且整行严丝合缝铺满容器宽度；
 * - 最后一行不足整行宽度时保持目标高度靠左自然排列，不强行拉伸放大；
 * - 兼容旧版本地存储的档位索引（0–6）与连续行高像素值。
 */

export const PHOTO_SIZES = [76, 100, 128, 160, 200, 248, 300] as const;
export const PHOTO_SIZE_MIN = PHOTO_SIZES[0];
export const PHOTO_SIZE_MAX = PHOTO_SIZES[PHOTO_SIZES.length - 1];
export const DEFAULT_PHOTO_SIZE: number = PHOTO_SIZES[3];

export type JustifiedRow = { height: number; widths: number[] };

export function justifyGap(targetHeight: number): number {
  return targetHeight < 100 ? 6 : 8;
}

/** 宽高比：无尺寸时默认 16:9；超长竖图与超宽横幅夹在 0.32–5.5 之间，防止单张挤成细缝或独占窄条。 */
export function aspectOf(width: number, height: number): number {
  if (!width || !height) return 16 / 9;
  return Math.min(5.5, Math.max(0.32, width / height));
}

/**
 * ratios：每张媒体的宽高比；width：容器可用宽度；target：目标行高（随触控板捏合连续变化）。
 * 返回每行高度与每格精确整数像素宽度（填满行的宽度和 + 间距严格等于 width）。
 */
export function justify(
  ratios: number[],
  width: number,
  target = DEFAULT_PHOTO_SIZE,
  gap = justifyGap(target),
): JustifiedRow[] {
  const n = ratios.length;
  if (!n || width <= 0) return [];
  const safeTarget = Math.max(PHOTO_SIZE_MIN, Math.min(PHOTO_SIZE_MAX, target));
  const cap = safeTarget * 1.55;
  const maxPerRow = Math.max(4, Math.min(14, Math.ceil(width / Math.max(36, safeTarget * 0.42)) + 3));
  const cost = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(0);
  cost[0] = 0;

  for (let end = 1; end <= n; end++) {
    let sum = 0;
    for (let start = end - 1; start >= Math.max(0, end - maxPerRow); start--) {
      sum += ratios[start];
      const count = end - start;
      const height = (width - (count - 1) * gap) / sum;
      if (height <= 0) break;
      const last = end === n;
      const penalty = Math.log(Math.min(height, cap) / safeTarget) ** 2 + (height > cap && !last ? 4 : 0);
      if (cost[start] + penalty < cost[end]) {
        cost[end] = cost[start] + penalty;
        prev[end] = start;
      }
    }
  }

  const breaks: Array<[number, number]> = [];
  for (let end = n; end > 0; end = prev[end]) breaks.unshift([prev[end], end]);

  return breaks.map(([start, end]) => {
    const slice = ratios.slice(start, end);
    const sum = slice.reduce((total, ratio) => total + ratio, 0);
    const free = width - (slice.length - 1) * gap;
    const natural = free / sum;
    const isLast = end === n;
    const height = Math.max(48, Math.round(isLast ? Math.min(natural, safeTarget) : Math.min(natural, cap)));
    const widths = slice.map((ratio) => Math.max(1, Math.floor(ratio * height)));
    if (height === Math.round(natural) && widths.length > 0) {
      const used = widths.reduce((total, w) => total + w, 0);
      widths[widths.length - 1] += Math.max(0, free - used);
    }
    return { height, widths };
  });
}
