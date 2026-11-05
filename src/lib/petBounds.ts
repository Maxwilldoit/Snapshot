import type { MediaBounds } from "./petSize";

export type PetWorkArea = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

type HorizontalLimits = { minX: number; maxX: number };

/** 输入及返回值均为物理像素，只有 content 使用 CSS 逻辑像素。 */
export function petHorizontalLimits(
  areas: readonly PetWorkArea[],
  position: { x: number; y: number },
  windowSize: { width: number; height: number },
  content: MediaBounds | null,
  scale: number,
): HorizontalLimits | null {
  if (
    ![position.x, position.y, windowSize.width, windowSize.height, scale].every(Number.isFinite) ||
    windowSize.width <= 0 || windowSize.height <= 0 || scale <= 0
  ) return null;

  let left = 0;
  let right = windowSize.width;
  let centerY = windowSize.height / 2;
  if (
    content && [content.left, content.top, content.width, content.height].every(Number.isFinite) &&
    content.width > 0 && content.height > 0
  ) {
    const mappedLeft = content.left * scale;
    const mappedRight = mappedLeft + content.width * scale;
    const mappedCenterY = content.top * scale + (content.height * scale) / 2;
    if ([mappedLeft, mappedRight, mappedCenterY].every(Number.isFinite) && mappedRight > mappedLeft) {
      left = mappedLeft;
      right = mappedRight;
      centerY = mappedCenterY;
    }
  }
  centerY += position.y;
  if (!Number.isFinite(centerY)) return null;

  // 忽略尚未取得有效尺寸的工作区；竖向距离为零即中心 y 落在该工作区内。
  let nearestY = Infinity;
  const intervals: Array<{ left: number; right: number; distanceY: number }> = [];
  for (const area of areas) {
    const { x, y } = area.position;
    const { width, height } = area.size;
    const endX = x + width;
    const endY = y + height;
    if (
      ![x, y, width, height, endX, endY].every(Number.isFinite) ||
      width <= 0 || height <= 0 || endX <= x || endY <= y
    ) continue;
    const distanceY = Math.max(y - centerY, centerY - endY, 0);
    nearestY = Math.min(nearestY, distanceY);
    intervals.push({ left: x, right: endX, distanceY });
  }
  const selected = intervals.filter((interval) => interval.distanceY === nearestY)
    .sort((a, b) => a.left - b.left);
  const merged: Array<{ left: number; right: number }> = [];
  for (const interval of selected) {
    const last = merged[merged.length - 1];
    if (last && interval.left <= last.right) last.right = Math.max(last.right, interval.right);
    else merged.push({ left: interval.left, right: interval.right });
  }

  let best: HorizontalLimits | null = null;
  let leastMove = Infinity;
  for (const interval of merged) {
    let minX = interval.left - left;
    let maxX = interval.right - right;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) continue;
    // 可见内容比整个区间还宽时居中，避免反转范围导致反复校准抖动。
    if (minX > maxX) minX = maxX = minX / 2 + maxX / 2;
    const limits = { minX, maxX };
    const move = Math.abs(clampPetX(position.x, limits) - position.x);
    // 等距时保留左侧区间，使结果不依赖显示器枚举顺序。
    if (best === null || move < leastMove) {
      best = limits;
      leastMove = move;
    }
  }
  return best;
}

export function clampPetX(x: number, limits: HorizontalLimits | null): number {
  return limits === null ? x : Math.min(limits.maxX, Math.max(limits.minX, x));
}
