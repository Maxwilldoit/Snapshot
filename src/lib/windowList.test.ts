import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturableWindow } from "../types";

const listWindows = vi.fn<() => Promise<CapturableWindow[]>>();
vi.mock("./backend", () => ({ listWindows: () => listWindows() }));

const {
  WINDOW_LIST_FRESH_MS,
  cachedWindows,
  confirmWindow,
  ensureFreshWindows,
  pendingWindowRefresh,
  prefetchWindows,
  refreshWindows,
  resetWindowListCache,
  subscribeWindows,
} = await import("./windowList");

const notes: CapturableWindow = { id: 73, pid: 4242, appName: "Code", title: "notes.md", minimized: false };
const chat: CapturableWindow = { id: 74, pid: 4243, appName: "ChatGPT", title: "ChatGPT", minimized: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetWindowListCache();
  listWindows.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("窗口列表缓存", () => {
  it("同时发起的几次读取只调一次后端，读完通知订阅者并留下缓存", async () => {
    const request = deferred<CapturableWindow[]>();
    listWindows.mockReturnValue(request.promise);
    const listener = vi.fn();
    subscribeWindows(listener);
    const first = refreshWindows();
    const second = refreshWindows();
    prefetchWindows();
    expect(listWindows).toHaveBeenCalledTimes(1);
    expect(pendingWindowRefresh()).not.toBeNull();
    request.resolve([notes]);
    await expect(first).resolves.toEqual([notes]);
    await expect(second).resolves.toEqual([notes]);
    expect(cachedWindows()).toEqual([notes]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pendingWindowRefresh()).toBeNull();
  });

  it("刚读过就直接用缓存，过了新鲜期才重读", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    listWindows.mockResolvedValue([notes]);
    await refreshWindows();
    await ensureFreshWindows(10_000 + WINDOW_LIST_FRESH_MS - 1);
    prefetchWindows(10_000 + WINDOW_LIST_FRESH_MS - 1);
    expect(listWindows).toHaveBeenCalledTimes(1);
    listWindows.mockResolvedValue([notes, chat]);
    await expect(ensureFreshWindows(10_000 + WINDOW_LIST_FRESH_MS)).resolves.toEqual([notes, chat]);
    expect(listWindows).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("没有权限时清掉旧列表；其它错误保留旧列表", async () => {
    listWindows.mockResolvedValue([notes]);
    await refreshWindows();
    listWindows.mockRejectedValue("组件崩了");
    await expect(refreshWindows()).rejects.toBe("组件崩了");
    expect(cachedWindows()).toEqual([notes]);
    listWindows.mockRejectedValue({ kind: "screenCapturePermission", message: "需要权限" });
    await expect(refreshWindows()).rejects.toMatchObject({ kind: "screenCapturePermission" });
    expect(cachedWindows()).toBeNull();
  });

  it("预取失败不会抛到外面", async () => {
    listWindows.mockRejectedValue("boom");
    prefetchWindows();
    await Promise.resolve();
    await expect(pendingWindowRefresh() ?? Promise.resolve()).rejects.toBe("boom");
    expect(cachedWindows()).toBeNull();
  });
});

describe("选中旧列表里的窗口", () => {
  it("没有重读在路上时同步确认：还在就原样返回，id 不在或换了进程就返回 null", async () => {
    listWindows.mockResolvedValue([notes]);
    await refreshWindows();
    expect(confirmWindow(notes)).toBe(notes);
    expect(confirmWindow(chat)).toBeNull();
    expect(confirmWindow({ ...notes, pid: 9999 })).toBeNull();
  });

  it("从没读到过列表时交给后端按 id 校验", () => {
    expect(confirmWindow(notes)).toBe(notes);
  });

  it("有重读在路上就等它，按新列表判断已经关掉的窗口", async () => {
    listWindows.mockResolvedValue([notes, chat]);
    await refreshWindows();
    const request = deferred<CapturableWindow[]>();
    listWindows.mockReturnValue(request.promise);
    void refreshWindows();
    const pending = confirmWindow(notes);
    expect(pending).toBeInstanceOf(Promise);
    request.resolve([chat]);
    await expect(pending).resolves.toBeNull();
    expect(confirmWindow(chat)).toEqual(chat);
  });

  it("重读失败时退回原样，让后端去校验", async () => {
    listWindows.mockResolvedValue([notes]);
    await refreshWindows();
    const request = deferred<CapturableWindow[]>();
    listWindows.mockReturnValue(request.promise);
    void refreshWindows().catch(() => {});
    const pending = confirmWindow(notes);
    request.reject("boom");
    await expect(pending).resolves.toBe(notes);
  });
});
