import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { CapturableWindow } from "../types";
import { setupTauriMock } from "../test/tauri";
import type { AppContextValue } from "./context";

const notes: CapturableWindow = { id: 73, pid: 4242, appName: "Visual Studio Code", title: "notes.md", minimized: false };
const chat: CapturableWindow = { id: 74, pid: 4243, appName: "Safari", title: "Docs", minimized: false };

type Call = { command: string; payload?: InvokeArgs };

async function renderTools(handle: (command: string, payload?: InvokeArgs) => unknown) {
  const calls: Call[] = [];
  setupTauriMock((command, payload) => {
    calls.push({ command, payload });
    return handle(command, payload);
  });
  vi.resetModules();
  const [{ CaptureTools }, { AppContext }, cache] = await Promise.all([
    import("./CaptureTools"),
    import("./context"),
    import("../lib/windowList"),
  ]);
  const notify = vi.fn();
  const value = {
    settings: { shortcuts: [], recordSystemAudio: false, recordMicrophone: false },
    caps: null,
    recording: { active: false, target: null, startedAt: null },
    notify,
    onSaved: vi.fn(),
  } as unknown as AppContextValue;
  render(
    <AppContext.Provider value={value}>
      <CaptureTools />
    </AppContext.Provider>,
  );
  const listCalls = () => calls.filter((call) => call.command === "list_capturable_windows").length;
  return { calls, listCalls, notify, cache, user: userEvent.setup() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("工具栏截取/录屏：窗口列表秒开", () => {
  it("挂上时就预取，点开直接是列表，不再读一次也不显示「正在读取窗口」", async () => {
    const { listCalls, user } = await renderTools((command) => (command === "list_capturable_windows" ? [notes, chat] : undefined));
    await waitFor(() => expect(listCalls()).toBe(1));
    await user.click(screen.getByRole("button", { name: "截图" }));
    expect(await screen.findByRole("menuitem", { name: /Visual Studio Code/ })).toBeTruthy();
    expect(screen.queryByText("正在读取窗口…")).toBeNull();
    expect(listCalls()).toBe(1);
  });

  it("有旧列表时先给旧的，后台重读回来就地换成新的", async () => {
    let next: ReturnType<typeof deferred<CapturableWindow[]>> | null = null;
    const { listCalls, cache, user } = await renderTools((command) => {
      if (command !== "list_capturable_windows") return undefined;
      if (!next) return [notes];
      return next.promise;
    });
    await waitFor(() => expect(cache.cachedWindows()).toEqual([notes]));
    next = deferred<CapturableWindow[]>();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await user.click(screen.getByRole("button", { name: "录屏" }));
    expect(screen.getByRole("menuitem", { name: /Visual Studio Code/ })).toBeTruthy();
    expect(screen.queryByText("正在读取窗口…")).toBeNull();
    expect(listCalls()).toBe(2);
    await act(async () => next!.resolve([chat]));
    expect(await screen.findByRole("menuitem", { name: /Safari/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Visual Studio Code/ })).toBeNull();
    now.mockRestore();
  });

  it("悬停、按下按钮就开始读", async () => {
    const { listCalls, user } = await renderTools((command) => (command === "list_capturable_windows" ? [notes] : undefined));
    await waitFor(() => expect(listCalls()).toBe(1));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await user.hover(screen.getByRole("button", { name: "截图" }));
    await waitFor(() => expect(listCalls()).toBe(2));
    now.mockReturnValue(Date.now() + 120_000);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listCalls()).toBe(3));
    now.mockRestore();
  });

  it("第一次读很慢时，过 150ms 才显示「正在读取窗口」", async () => {
    const first = deferred<CapturableWindow[]>();
    const { user } = await renderTools((command) => (command === "list_capturable_windows" ? first.promise : undefined));
    await user.click(screen.getByRole("button", { name: "截图" }));
    expect(screen.queryByText("正在读取窗口…")).toBeNull();
    expect(screen.queryByText("没有找到可用的窗口")).toBeNull();
    expect(await screen.findByText("正在读取窗口…")).toBeTruthy();
    await act(async () => first.resolve([notes]));
    expect(await screen.findByRole("menuitem", { name: /Visual Studio Code/ })).toBeTruthy();
    expect(screen.queryByText("正在读取窗口…")).toBeNull();
  });

  it("旧列表里已经关掉的窗口：等重读确认后提示，不去截它", async () => {
    let next: ReturnType<typeof deferred<CapturableWindow[]>> | null = null;
    const { calls, cache, notify, user } = await renderTools((command) => {
      if (command === "run_action") return "ok";
      if (command !== "list_capturable_windows") return undefined;
      if (!next) return [notes, chat];
      return next.promise;
    });
    await waitFor(() => expect(cache.cachedWindows()).toHaveLength(2));
    next = deferred<CapturableWindow[]>();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await user.click(screen.getByRole("button", { name: "截图" }));
    await user.click(screen.getByRole("menuitem", { name: /Visual Studio Code/ }));
    expect(calls.some((call) => call.command === "run_action")).toBe(false);
    await act(async () => next!.resolve([chat]));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("这个窗口已经关闭，请重新选择", "error"));
    expect(calls.some((call) => call.command === "run_action")).toBe(false);
    now.mockRestore();
  });

  it("还在的窗口照常按 id 截取", async () => {
    const { calls, listCalls, user } = await renderTools((command) => {
      if (command === "run_action") return "ok";
      return command === "list_capturable_windows" ? [notes, chat] : undefined;
    });
    await waitFor(() => expect(listCalls()).toBe(1));
    await user.click(screen.getByRole("button", { name: "截图" }));
    await user.click(await screen.findByRole("menuitem", { name: /Safari/ }));
    await waitFor(() =>
      expect(calls.find((call) => call.command === "run_action")?.payload).toEqual({ action: "capture", targetId: 74 }),
    );
  });
});
