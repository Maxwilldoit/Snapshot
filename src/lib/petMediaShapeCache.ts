import type { PetAsset } from "../types";
import type { MediaBounds } from "./petSize";

export type PetMediaShape = {
  width: number;
  height: number;
  bounds: MediaBounds | null;
};

const CACHE_PREFIX = "snapshot-pet-media-shapes:";
const CACHE_VERSION = 1;

export function mediaShapeKey(assetId: string, entry: string, walk = false): string {
  return JSON.stringify([assetId, entry, walk]);
}

function validShape(shape: unknown): shape is PetMediaShape {
  if (!shape || typeof shape !== "object") return false;
  const value = shape as Partial<PetMediaShape>;
  if (!(Number.isFinite(value.width) && Number.isFinite(value.height) &&
    (value.width ?? 0) > 0 && (value.height ?? 0) > 0)) return false;
  if (value.bounds === null) return true;
  const bounds = value.bounds;
  return Boolean(bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.left >= 0 && bounds.top >= 0 && bounds.width > 0 && bounds.height > 0 &&
    bounds.left + bounds.width <= 1 + 1e-6 && bounds.top + bounds.height <= 1 + 1e-6);
}

function sourceKey(asset: PetAsset): string {
  return JSON.stringify([asset.path, asset.sizeBytes ?? 0, asset.importedAt ?? 0, asset.layout ?? null]);
}

type CachedShapes = {
  version: number;
  source: string;
  shapes: Record<string, PetMediaShape>;
};

function readCache(asset: PetAsset): CachedShapes | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_PREFIX + asset.id) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<CachedShapes>;
    if (record.version !== CACHE_VERSION || record.source !== sourceKey(asset) ||
      !record.shapes || typeof record.shapes !== "object" || Array.isArray(record.shapes)) return null;
    const shapes: Record<string, PetMediaShape> = {};
    for (const [entry, shape] of Object.entries(record.shapes)) {
      if (validShape(shape)) shapes[entry] = shape;
    }
    return { version: CACHE_VERSION, source: record.source, shapes };
  } catch {
    return null;
  }
}

/** Import-time GIF bounds are authoritative; only uncached actions (usually WebM)
 * use the renderer's completed playback envelope. */
export function loadPetMediaShapes(asset: PetAsset | null | undefined): Map<string, PetMediaShape> {
  const shapes = new Map<string, PetMediaShape>();
  if (!asset) return shapes;
  for (const [entry, shape] of Object.entries(asset.actionBounds ?? {})) {
    const value = { width: shape.width, height: shape.height, bounds: shape.bounds };
    if (validShape(value)) shapes.set(mediaShapeKey(asset.id, entry), value);
  }
  for (const [entry, shape] of Object.entries(readCache(asset)?.shapes ?? {})) {
    const key = mediaShapeKey(asset.id, entry);
    if (!shapes.has(key)) shapes.set(key, shape);
  }
  return shapes;
}

export function cachePetMediaShape(
  asset: PetAsset | null | undefined,
  entry: string | null | undefined,
  shape: PetMediaShape,
): void {
  if (!asset || !entry || !validShape(shape)) return;
  try {
    const current = readCache(asset);
    const shapes = { ...(current?.shapes ?? {}), [entry]: shape };
    localStorage.setItem(CACHE_PREFIX + asset.id, JSON.stringify({
      version: CACHE_VERSION,
      source: sourceKey(asset),
      shapes,
    } satisfies CachedShapes));
  } catch {
    // Storage being disabled only forfeits the optimization; the full action
    // canvas remains a safe envelope for the next playback.
  }
}
