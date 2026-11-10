/**
 * 截图墙的「两端对齐」排版：每行高度略有不同，但每一行都正好铺满容器宽度。
 * 按天分组后各组单独排；对每组做一次动态规划选断行位置，让每行高度尽量接近目标高度。
 */

export const JUSTIFY_GAP = 6;
const MAX_PER_ROW = 9;

/** 容器越宽，目标行高越高 */
export function targetRowHeight(width: number): number {
  if (width > 980) return 184;
  if (width > 720) return 160;
  return 132;
}

export type JustifiedRow = { height: number; widths: number[] };

/** 宽高比：拿不到尺寸时按 16:9；极端长条和超宽图夹在 0.25–6 之间，免得一张占满一行或细成一根线 */
export function aspectOf(width: number, height: number): number {
  if (!width || !height) return 16 / 9;
  return Math.min(6, Math.max(0.25, width / height));
}

/**
 * ratios：每张图的宽高比；width：可用宽度。
 * 返回每行的高度和行内每张的宽度（整数像素，行内宽度和 + 间距正好等于 width）。
 */
export function justify(ratios: number[], width: number, gap = JUSTIFY_GAP, target = targetRowHeight(width)): JustifiedRow[] {
  const n = ratios.length;
  if (!n || width <= 0) return [];
  const cap = target * 1.6;
  const cost = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(0);
  cost[0] = 0;
  for (let end = 1; end <= n; end++) {
    let sum = 0;
    for (let start = end - 1; start >= Math.max(0, end - MAX_PER_ROW); start--) {
      sum += ratios[start];
      const count = end - start;
      const height = (width - (count - 1) * gap) / sum;
      if (height <= 0) break;
      // 最后一行不够宽时按目标高度靠左排（画的时候不拉伸），但照样按偏离目标计分，
      // 这样不会为了「最后一行随便放」而把前面拆得零零碎碎
      const last = end === n;
      const penalty = Math.log(Math.min(height, cap) / target) ** 2 + (height > cap && !last ? 4 : 0);
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
    const height = Math.round(isLast ? Math.min(natural, target) : Math.min(natural, cap));
    const widths = slice.map((ratio) => Math.max(1, Math.floor(ratio * height)));
    // 填满的行把取整丢掉的几个像素补给最后一张，右边缘才齐
    if (height === Math.round(natural)) {
      const used = widths.reduce((total, w) => total + w, 0);
      widths[widths.length - 1] += Math.max(0, free - used);
    }
    return { height, widths };
  });
}
