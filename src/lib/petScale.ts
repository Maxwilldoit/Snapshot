import { emit, listen } from "@tauri-apps/api/event";
import type { PetAsset } from "../types";
import { PET_SCALE } from "./petSize";
import { measurePetScale } from "./petAutoScale";

const STORAGE_KEY = "snapshot-pet-base-scales";
const AUTO_KEY = "snapshot-pet-auto-scale:";
const CHANGED_EVENT = "pet-base-scale-changed";
const pending = new Map<string, { source: string; task: Promise<void> }>();
const retryAfter = new Map<string, number>();

function sourceKey(asset: PetAsset): string {
  return JSON.stringify([asset.path, asset.entry, asset.sizeBytes, asset.importedAt]);
}

function cachedScale(asset: PetAsset, source = sourceKey(asset)): number | null {
  try {
    const record = JSON.parse(localStorage.getItem(AUTO_KEY + asset.id) ?? "null");
    if (record?.version === 1 && record.source === source && Number.isFinite(record.scale)
      && record.scale >= PET_SCALE.default && record.scale <= PET_SCALE.max) {
      return record.scale;
    }
  } catch {
    // 旧缓存、损坏或不可用的存储不会阻止显示素材。
  }
  return null;
}

function announce(id: string): void {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: id }));
  if ("__TAURI_INTERNALS__" in window) void emit(CHANGED_EVENT, id).catch(() => {});
}

function storedScales(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 作者的画布优先；普通素材按待机画面的可见范围适配，手动值仍按 id 独立覆盖。 */
export function readPetBaseScale(asset: PetAsset | null | undefined): number {
  if (!asset) return PET_SCALE.default;
  const value = storedScales()[asset.id];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(PET_SCALE.min, Math.min(PET_SCALE.max, value))
    : asset.layout ? PET_SCALE.default : cachedScale(asset) ?? PET_SCALE.default;
}

/** 导入和旧素材首次显示时后台测量一次，不阻塞导入，也不随每个动作重新缩放。 */
export function ensurePetAutoScale(asset: PetAsset): Promise<void> {
  if (asset.layout || asset.missing) return Promise.resolve();
  const source = sourceKey(asset);
  const current = pending.get(asset.id);
  if (current?.source === source) return current.task;
  if (cachedScale(asset, source) !== null) return Promise.resolve();
  const attempt = asset.id + source;
  if ((retryAfter.get(attempt) ?? 0) > Date.now()) return Promise.resolve();
  const job = { source, task: Promise.resolve() };
  job.task = Promise.resolve().then(async () => {
    try {
      const scale = await measurePetScale(asset);
      if (pending.get(asset.id) !== job) return;
      if (scale === null || !Number.isFinite(scale) || scale < PET_SCALE.default || scale > PET_SCALE.max) {
        retryAfter.set(attempt, Date.now() + 30_000);
        return;
      }
      localStorage.setItem(AUTO_KEY + asset.id, JSON.stringify({ version: 1, source, scale }));
      retryAfter.delete(attempt);
      announce(asset.id);
    } catch {
      retryAfter.set(attempt, Date.now() + 30_000);
    } finally {
      if (pending.get(asset.id) === job) pending.delete(asset.id);
    }
  });
  pending.set(asset.id, job);
  return job.task;
}

export function persistPetBaseScale(id: string, scale: number): void {
  const value = Number.isFinite(scale) ? Math.max(PET_SCALE.min, Math.min(PET_SCALE.max, scale)) : PET_SCALE.default;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...storedScales(), [id]: value }));
  announce(id);
}

/** 取消手动覆盖，恢复当前素材测得的默认基准。 */
export function resetPetBaseScale(id: string): void {
  const scales = storedScales();
  delete scales[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scales));
  announce(id);
}

/** 同窗口、其它 WebView 和普通浏览器标签页都能即时同步，不需要后端设置命令。 */
export function watchPetBaseScales(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key?.startsWith(AUTO_KEY) || event.key === null) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  const pending = "__TAURI_INTERNALS__" in window ? listen(CHANGED_EVENT, onChange) : null;
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    if (pending) void pending.then((unlisten) => unlisten()).catch(() => {});
  };
}
