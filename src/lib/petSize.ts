/** 偏好里「桌宠大小」能调的范围（百分比），和 Rust settings.rs 的 PET_SCALE_RANGE 一致 */
export const PET_SCALE = { min: 30, max: 200, step: 10, default: 100 } as const;

/**
 * 悬浮窗口的边长（逻辑像素）。100% 时应用图标为屏幕短边的 8%，宠物为 19%；
 * 换屏幕跟着变，偏好里的百分比在各自的基准上缩放。
 */
export function petWindowSize(shortEdge: number, scalePercent: number, appearance: "app-icon" | "pet"): number {
  const base = shortEdge * (appearance === "app-icon" ? 0.08 : 0.19);
  return Math.round(base * (scalePercent / 100));
}
