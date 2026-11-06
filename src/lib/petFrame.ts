/**
 * 带 pet.json 的桌宠：每张 GIF 可以有自己的画布，人物按同一个像素比例画，
 * 脚底锚在屏幕上的同一点。先按虚拟方窗确定素材比例，再用 alpha 外框裁出实际窗口；
 * 某一张画到基准画布外（扣篮的篮筐）时，仍按相同比例把多出来的部分包进去。
 *
 * 算法见 README「超出基准画布的动作」。这里只算几何，不碰窗口。
 */

import type { PetLayout, PetLayoutFrame } from "../types";
import type { MediaBounds } from "./petSize";

/** 和 .pet-window 的 padding 一致：图像缩在去掉这一圈的方框里 */
export const PET_WINDOW_PAD = 2;

export interface PetPlacement {
  /** 窗口外框，逻辑像素 */
  width: number;
  height: number;
  /**
   * 窗口左上角相对「平时那个方窗」左上角的偏移，逻辑像素。
   * 往上、往左长是负数。存位置时减掉它，存下来的仍是方窗的位置。
   */
  shiftX: number;
  shiftY: number;
  /** 图的左上角，相对平时那个方窗的左上角（不是相对长高后的窗口） */
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
}

function finite(value: number) {
  return Number.isFinite(value);
}

/** 浮点误差贴着整数时收进去，免得 200 变成 200.0000001 之后被 ceil 成 201 */
function snapFloor(value: number) {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) < 1e-6 ? nearest : Math.floor(value);
}

function snapCeil(value: number) {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) < 1e-6 ? nearest : Math.ceil(value);
}

export function frameOf(layout: PetLayout, entry: string): PetLayoutFrame | null {
  return layout.frames.find((frame) => frame.entry === entry) ?? null;
}

/**
 * 这张图在 `windowSide` 那么大的方窗下该怎么放。
 * 没有这张图的锚点、或者基准画布无效时返回 null，调用方按老办法把整张 GIF 缩进方窗。
 */
export function petPlacement(
  windowSide: number,
  layout: PetLayout,
  frame: PetLayoutFrame,
  flip = false,
): PetPlacement | null {
  const pad = PET_WINDOW_PAD;
  const { baseWidth, baseHeight, anchorX: baseAnchorX, anchorY: baseAnchorY } = layout;
  if (
    !(windowSide > 0) ||
    !(baseWidth > 0) ||
    !(baseHeight > 0) ||
    !(frame.width > 0) ||
    !(frame.height > 0) ||
    !finite(baseAnchorX) ||
    !finite(baseAnchorY) ||
    !finite(frame.anchorX) ||
    !finite(frame.anchorY)
  ) {
    return null;
  }

  const inner = Math.max(1, windowSide - pad * 2);
  // 和 object-fit: contain 一样，长边贴上内框
  const scale = inner / Math.max(baseWidth, baseHeight);
  const baseW = baseWidth * scale;
  const baseH = baseHeight * scale;
  const baseLeft = pad + (inner - baseW) / 2;
  const baseTop = pad + (inner - baseH) / 2;
  const feetX = baseLeft + baseAnchorX * scale;
  const feetY = baseTop + baseAnchorY * scale;

  // 镜像绕图的中心翻，脚的横坐标翻到另一边
  const anchorX = flip ? frame.width - frame.anchorX : frame.anchorX;
  const imageX = feetX - anchorX * scale;
  const imageY = feetY - frame.anchorY * scale;
  const imageWidth = frame.width * scale;
  const imageHeight = frame.height * scale;

  // 窗口至少要盖住平时的方窗，也要盖住这张图（再留一圈和方窗一样的内边距）
  const coverLeft = Math.min(0, imageX - pad);
  const coverTop = Math.min(0, imageY - pad);
  const coverRight = Math.max(windowSide, imageX + imageWidth + pad);
  const coverBottom = Math.max(windowSide, imageY + imageHeight + pad);
  const shiftX = snapFloor(coverLeft);
  const shiftY = snapFloor(coverTop);

  return {
    width: snapCeil(coverRight) - shiftX,
    height: snapCeil(coverBottom) - shiftY,
    shiftX,
    shiftY,
    imageX,
    imageY,
    imageWidth,
    imageHeight,
  };
}

/** 当前要显示的这张有锚点时给出摆放；否则 null（方窗、整张缩进去） */
export function placementForEntry(
  windowSide: number,
  layout: PetLayout | null | undefined,
  entry: string | null | undefined,
  flip = false,
): PetPlacement | null {
  if (!layout || !entry) return null;
  const frame = frameOf(layout, entry);
  if (!frame) return null;
  return petPlacement(windowSide, layout, frame, flip);
}

/** 脚底相对平时那个方窗左上角的位置。每张图算出来应该是同一个点 */
export function feetInNormalWindow(placement: PetPlacement, frame: PetLayoutFrame, flip = false) {
  const anchorX = flip ? frame.width - frame.anchorX : frame.anchorX;
  const scale = placement.imageWidth / frame.width;
  return {
    x: placement.imageX + anchorX * scale,
    y: placement.imageY + frame.anchorY * scale,
  };
}

/** 当前窗口内的稳定脚底位置；窗口为大动作向上扩展时也要抵消 shiftY。 */
export function groundForEntry(
  windowSide: number,
  layout: PetLayout | null | undefined,
  entry: string | null | undefined,
  flip = false,
): number | null {
  const place = placementForEntry(windowSide, layout, entry, flip);
  const frame = layout && entry ? frameOf(layout, entry) : null;
  return place && frame ? feetInNormalWindow(place, frame, flip).y - place.shiftY : null;
}

/** 没有作者锚点时仍在虚拟方窗里 contain，裁窗口不能反过来把图重新缩放。 */
export function mediaPlacement(side: number, width: number, height: number): PetPlacement | null {
  if (![side, width, height].every(Number.isFinite) || side <= 4 || width <= 0 || height <= 0) return null;
  const inner = side - PET_WINDOW_PAD * 2;
  const scale = inner / Math.max(width, height);
  return {
    width: side, height: side, shiftX: 0, shiftY: 0,
    imageX: PET_WINDOW_PAD + (inner - width * scale) / 2,
    imageY: side - PET_WINDOW_PAD - height * scale,
    imageWidth: width * scale, imageHeight: height * scale,
  };
}

/** bounds 为未镜像的归一化 alpha 外框；只裁透明外圈，画图比例和脚底位置不变。 */
export function cropPetPlacement(place: PetPlacement, bounds: MediaBounds | null = null, flip = false): PetPlacement {
  const valid = bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.left >= 0 && bounds.top >= 0 && bounds.width > 0 && bounds.height > 0 &&
    bounds.left + bounds.width <= 1 + 1e-6 && bounds.top + bounds.height <= 1 + 1e-6;
  const visible = valid ? bounds : { left: 0, top: 0, width: 1, height: 1 };
  // alpha 在缩略画布中测量，额外留 4px，包住抗锯齿、呼吸和采样误差。
  const pad = valid ? 4 : PET_WINDOW_PAD;
  const left = place.imageX + (flip ? 1 - visible.left - visible.width : visible.left) * place.imageWidth;
  const top = place.imageY + visible.top * place.imageHeight;
  const shiftX = snapFloor(left - pad);
  const shiftY = snapFloor(top - pad);
  return { ...place, shiftX, shiftY,
    width: snapCeil(left + visible.width * place.imageWidth + pad) - shiftX,
    height: snapCeil(top + visible.height * place.imageHeight + pad) - shiftY };
}

/** 叠化期间也包住旧图，淡出结束再收紧，不能裁掉还看得见的上一动作。 */
export function coverPetPlacements(current: PetPlacement, previous: PetPlacement | null): PetPlacement {
  if (!previous) return current;
  const shiftX = Math.min(current.shiftX, previous.shiftX);
  const shiftY = Math.min(current.shiftY, previous.shiftY);
  return { ...current, shiftX, shiftY,
    width: Math.max(current.shiftX + current.width, previous.shiftX + previous.width) - shiftX,
    height: Math.max(current.shiftY + current.height, previous.shiftY + previous.height) - shiftY };
}
