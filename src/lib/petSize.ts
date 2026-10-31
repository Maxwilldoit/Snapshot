/** 偏好里「桌宠大小」能调的范围（百分比），和 Rust settings.rs 的 PET_SCALE_RANGE 一致 */
export const PET_SCALE = { min: 30, max: 200, step: 10, default: 100 } as const;

/**
 * 悬浮窗口的边长（逻辑像素）。应用图标基准为屏幕短边的 8%，宠物为 19%。
 * 每个宠物的 baseScale 单独修正其基准大小，再乘用户的缩放百分比。
 */
export function petWindowSize(
  shortEdge: number,
  scalePercent: number,
  appearance: "app-icon" | "pet",
  baseScale: number = PET_SCALE.default,
): number {
  const baseline = Number.isFinite(baseScale) ? Math.min(PET_SCALE.max, Math.max(PET_SCALE.min, baseScale)) : PET_SCALE.default;
  const base = shortEdge * (appearance === "app-icon" ? 0.08 : 0.19 * (baseline / 100));
  return Math.round(base * (scalePercent / 100));
}

export type MediaBounds = { left: number; top: number; width: number; height: number };

/** object-fit: contain + object-position: center bottom 后，媒体真正占用的矩形。 */
export function containedMediaBounds(
  box: MediaBounds,
  mediaWidth: number,
  mediaHeight: number,
): MediaBounds | null {
  if (!(box.width > 0) || !(box.height > 0) || !(mediaWidth > 0) || !(mediaHeight > 0)) return null;
  const scale = Math.min(box.width / mediaWidth, box.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + box.height - height,
    width,
    height,
  };
}
