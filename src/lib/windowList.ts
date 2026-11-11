import { listWindows } from "./backend";
import type { CapturableWindow } from "../types";

/**
 * 「截取」「录屏」下拉和快捷菜单共用的窗口列表缓存（每个 WebView 各一份）。
 *
 * 读一次窗口列表要几百毫秒（起组件进程、问 ScreenCaptureKit、问辅助功能），每次点开都等就会看到
 * 「正在读取窗口」。这里先给出上一次的列表，同时在后台重读，读完就地替换（stale-while-revalidate）；
 * 指针移到按钮上、按下、主窗口获得焦点时还会提前读一次。
 *
 * 旧列表里的窗口可能已经关了：选中时如果还有一次重读没回来，先等它，再确认这个窗口（id + 进程）还在；
 * 后端截图/录制本来也会按 id 重新找窗口，找不到就报「目标窗口已经关闭」。
 */

/** 这么短时间内读过就不再重读：悬停、按下、点开会接连触发。 */
export const WINDOW_LIST_FRESH_MS = 1500;
/** 第一次读还没回来时，过这么久才显示「正在读取窗口」，快的时候就不闪那一下。 */
export const WINDOW_LIST_LOADING_DELAY_MS = 150;

let cached: CapturableWindow[] | null = null;
let fetchedAt = 0;
let inflight: Promise<CapturableWindow[]> | null = null;
const listeners = new Set<() => void>();

export const isScreenCapturePermissionError = (error: unknown) =>
  typeof error === "object" && error !== null && "kind" in error && (error as { kind?: unknown }).kind === "screenCapturePermission";

function emit() {
  for (const listener of [...listeners]) listener();
}

/** 上一次成功读到的列表；从没读到过（或没有权限）是 null。 */
export const cachedWindows = () => cached;

/** 正在进行的那次重读；没有就是 null。 */
export const pendingWindowRefresh = () => inflight;

/** 重读一次；已有一次在路上就复用它。没有权限时清掉缓存，免得继续展示读不到的列表。 */
export function refreshWindows(): Promise<CapturableWindow[]> {
  if (inflight) return inflight;
  const request = listWindows().then(
    (list) => {
      cached = Array.isArray(list) ? list : [];
      fetchedAt = Date.now();
      emit();
      return cached;
    },
    (error: unknown) => {
      if (isScreenCapturePermissionError(error) && cached !== null) {
        cached = null;
        emit();
      }
      throw error;
    },
  );
  const tracked = request.finally(() => {
    if (inflight === tracked) inflight = null;
  });
  inflight = tracked;
  return tracked;
}

/** 列表足够新就直接用，否则重读。打开下拉时用它。 */
export function ensureFreshWindows(now = Date.now()): Promise<CapturableWindow[]> {
  if (!inflight && cached !== null && now - fetchedAt < WINDOW_LIST_FRESH_MS) return Promise.resolve(cached);
  return refreshWindows();
}

/** 提前读一次（悬停/按下/获得焦点），失败不打扰用户：真正打开时会再读并报错。 */
export function prefetchWindows(now = Date.now()) {
  void ensureFreshWindows(now).catch(() => {});
}

export function subscribeWindows(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 选中一项时确认它还在。有重读在路上就等它回来再看；列表里已经没有这个窗口（或 id 换了进程）时返回 null，
 * 调用方提示「窗口已经关闭」而不是去截一个可能不对的窗口。重读失败时退回原样交给后端校验。
 */
export function confirmWindow(item: CapturableWindow): CapturableWindow | null | Promise<CapturableWindow | null> {
  const find = (list: CapturableWindow[] | null) =>
    list === null ? item : list.find((window) => window.id === item.id && window.pid === item.pid) ?? null;
  if (!inflight) return find(cached);
  return inflight.then(find, () => item);
}

/** 测试用：回到刚加载时的状态。 */
export function resetWindowListCache() {
  cached = null;
  fetchedAt = 0;
  inflight = null;
  listeners.clear();
}
