/**
 * 截图墙的「两端对齐」排版：每行高度略有不同，但每一行都正好铺满容器宽度。
 * 按天分组后各组单独排；对每组做一次动态规划选断行位置，让每行高度尽量接近目标高度。
 * 参照 macOS「照片」：缩略图保留原始宽高比；目标行高小到一定程度后间距归零，紧邻铺排。
 */

export const JUSTIFY_GAP = 6;
const MAX_PER_ROW = 9;

/** 历史墙缩放档位对应的目标行高（px）。最小档触发紧邻模式。 */
export const ZOOM_ROW_HEIGHTS = [44, 64, 92, 128, 172, 228, 300] as const;
export const DEFAULT_ZOOM = 3;
/** 行高低于该值时缩略图无缝紧邻（同「照片」缩到最小的效果） */
const FLUSH_ROW_HEIGHT = 56;

export function zoomGap(rowHeight: number): number {
  return rowHeight < FLUSH_ROW_HEIGHT ? 0 : JUSTIFY_GAP;
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
export function justify(ratios: number[], width: number, gap: number = JUSTIFY_GAP, target: number = ZOOM_ROW_HEIGHTS[DEFAULT_ZOOM]): JustifiedRow[] {
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
    // 填满的行把取整误差补给最后一张，右边缘才齐（±1px 内都算填满）
    if (!isLast && Math.abs(height - natural) <= 1) {
      const used = widths.reduce((total, w) => total + w, 0);
      widths[widths.length - 1] = Math.max(1, widths[widths.length - 1] + free - used);
    }
    return { height, widths };
  });
}
