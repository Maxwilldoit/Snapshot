/** 历史网格的格位边长；复用旧版缩放档位，保留本机存储兼容。 */
export const PHOTO_SIZES = [44, 64, 92, 128, 172, 228, 300] as const;
export const PHOTO_SIZE_MIN = PHOTO_SIZES[0];
export const PHOTO_SIZE_MAX = PHOTO_SIZES[PHOTO_SIZES.length - 1];
export const DEFAULT_PHOTO_SIZE: number = PHOTO_SIZES[3];

/** 缩到最小时格位紧邻；正常大小保留细窄间距。 */
export function photoGridGap(size: number): number {
  return size < 56 ? 0 : 6;
}
