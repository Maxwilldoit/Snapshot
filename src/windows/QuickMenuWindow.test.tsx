import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { RecordingStatus, Settings } from "../types";
import { setupTauriMock } from "../test/tauri";
import { windowPickerLabels } from "./QuickMenuWindow";

const windowList = [
  { id: 73, pid: 4242, appName: "Visual Studio Code", title: "notes.md", minimized: true },
  { id: 74, pid: 4243, appName: "Codex", title: "ChatGPT", minimized: false },
];

const manyWindows = Array.from({ length: 7 }, (_, index) => ({
  id: 100 + index,
  pid: 5000 + index,
  appName: `应用 ${index + 1}`,
  title: `窗口 ${index + 1}`,
  minimized: false,
}));

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

type Call = { command: string; payload?: InvokeArgs };

async function renderPalette(handle: (command: string, payload?: InvokeArgs) => unknown) {
  const calls: Call[] = [];
  setupTauriMock((command, payload) => {
    calls.push({ command, payload });
    return handle(command, payload);
  }, { currentWindow: "quick-menu", shouldMockEvents: true });
  vi.resetModules();
  const { QuickMenuWindow } = await import("./QuickMenuWindow");
  render(<QuickMenuWindow />);
  return { calls, user: userEvent.setup() };
}

describe("快捷菜单：录制", () => {
  it("选「录制」先列窗口，点哪个就录哪个", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null } satisfies RecordingStatus;
      if (command === "list_capturable_windows") return windowList;
      if (command === "toggle_recording") return { active: true, target: "Visual Studio Code", startedAt: 123 } satisfies RecordingStatus;
      return undefined;
    });

    await user.click(await screen.findByRole("option", { name: "录制" }));
    expect(await screen.findByRole("listbox", { name: "选择要录制的窗口" })).toBeTruthy();
    expect(screen.getByText("已最小化")).toBeTruthy();
    expect(screen.getByText("ChatGPT")).toBeTruthy();
    await user.click(await screen.findByRole("option", { name: /Visual Studio Code/ }));
    expect(await screen.findByText("开始录制 Visual Studio Code")).toBeTruthy();

    await waitFor(() => {
      expect(calls.find((call) => call.command === "toggle_recording")?.payload).toEqual({ targetId: 73 });
    });
  });

  it("正在录时那一行变成停止，点了直接停，不再列窗口", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: true, target: "Visual Studio Code", startedAt: Date.now() } satisfies RecordingStatus;
      if (command === "toggle_recording") return { active: false, target: null, startedAt: null } satisfies RecordingStatus;
      return undefined;
    });

    await user.click(await screen.findByRole("option", { name: /停止录制 · Visual Studio Code/ }));
    expect(await screen.findByText("录制已保存")).toBeTruthy();

    expect(calls.find((call) => call.command === "toggle_recording")?.payload).toEqual({ targetId: null });
    expect(calls.some((call) => call.command === "list_capturable_windows")).toBe(false);
    expect(screen.queryByRole("listbox", { name: "选择要录制的窗口" })).toBeNull();
  });

  it("窗口枚举完成前保留菜单，完成后直接切到稳定高度的列表", async () => {
    let finishWindows!: (windows: typeof windowList) => void;
    const { user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "list_capturable_windows") {
        return new Promise<typeof windowList>((resolve) => {
          finishWindows = resolve;
        });
      }
      return undefined;
    });

    await user.click(await screen.findByRole("option", { name: "录制" }));
    expect(screen.getByRole("listbox", { name: "动作" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "选择要录制的窗口" })).toBeNull();

    await act(async () => finishWindows(windowList));
    const list = await screen.findByRole("listbox", { name: "选择要录制的窗口" });
    expect(screen.queryByRole("listbox", { name: "动作" })).toBeNull();
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(windowList.length);
  });

  it("超过 4 个窗口时保留完整列表，键盘选择会滚动到当前应用", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const { user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "list_capturable_windows") return manyWindows;
      return undefined;
    });

    await user.click(await screen.findByRole("option", { name: "录制" }));
    const list = await screen.findByRole("listbox", { name: "选择要录制的窗口" });
    expect(list.classList.contains("palette-windows")).toBe(true);
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(7);

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: /应用 6/ }).getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("窗口名称", () => {
  it("用 ChatGPT 标题代替 Store 包里的 Codex 进程名，并隐藏重复标题", () => {
    expect(windowPickerLabels({ appName: "Codex", title: "ChatGPT" })).toEqual({ name: "ChatGPT", title: "" });
    expect(windowPickerLabels({ appName: "微信", title: "微信" })).toEqual({ name: "微信", title: "" });
    expect(windowPickerLabels({ appName: "Chrome", title: "GitHub" })).toEqual({ name: "Chrome", title: "GitHub" });
  });
});

describe("快捷菜单：精简菜单", () => {
  it("不显示搜索框和打开主窗口入口，窗口选择也不带搜索框", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "list_capturable_windows") return windowList;
      return undefined;
    });

    expect(await screen.findByRole("option", { name: "润色 Prompt" })).toBeTruthy();
    expect(screen.queryByText("快速操作")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("option", { name: "打开主窗口" })).toBeNull();
    expect(calls.some((call) => call.command === "show_main_window")).toBe(false);

    await user.click(screen.getByRole("option", { name: "快照" }));
    expect(await screen.findByRole("listbox", { name: "选择要截取的窗口" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("快捷菜单：窗口大小", () => {
  /** 只记下在观察谁；什么时候回调由测试决定（jsdom 没有布局，也没有 ResizeObserver） */
  class FakeResizeObserver {
    static live = new Set<FakeResizeObserver>();
    targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {
      FakeResizeObserver.live.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      FakeResizeObserver.live.delete(this);
    }
    /** 相当于浏览器排完版后通知：旧面板被移走、新面板量好，都会走到这里 */
    static notifyAll() {
      for (const observer of [...FakeResizeObserver.live]) {
        if (observer.targets.size) observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  }

  it("每次打开都量新挂上的面板，旧面板移走时不会把窗口缩到最小", async () => {
    FakeResizeObserver.live.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let panelHeight = 300;
    // 面板在页面里时有高度，被移出页面后是 0（浏览器里就是这样）
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.isConnected && this.classList.contains("palette") ? panelHeight : 0;
    });

    const { calls } = await renderPalette(() => undefined);
    // 没有桌宠形象时上方留 24，下方留 40
    const heights = () =>
      calls.filter((call) => call.command === "resize_quick_menu").map((call) => (call.payload as { height: number }).height);
    await waitFor(() => expect(heights()).toContain(300 + 24 + 40));

    const firstPanel = document.querySelector(".palette");
    const { emit } = await import("@tauri-apps/api/event");
    await emit("palette-opened");
    await waitFor(() => expect(document.querySelector(".palette")).not.toBe(firstPanel));

    // 新面板更高（比如开着录制时那一行多了时长）：窗口要跟着变高
    panelHeight = 380;
    FakeResizeObserver.notifyAll();
    await waitFor(() => expect(heights().at(-1)).toBe(380 + 24 + 40));
    expect(heights().every((height) => height >= 300 + 24 + 40)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("菜单与窗口列表保持同宽，切页按包裹后的高度只更新一次原生窗口", async () => {
    // jsdom 没有布局：宽度取外层视图宽度，高度按当前正文模拟恰好包裹
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("palette") ? parseFloat((this.parentElement as HTMLElement).style.width) || 0 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.isConnected || !this.classList.contains("palette")) return 0;
      return this.querySelector(".palette-windows") ? 194 : 180;
    });
    const { calls, user } = await renderPalette((command) => (command === "list_capturable_windows" ? windowList : undefined));
    const sizes = () =>
      calls
        .filter((call) => call.command === "resize_quick_menu")
        .map((call) => call.payload as { width: number; height: number });
    // 面板宽 + 左右各 40
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 180 + 24 + 40 }));
    const callsBeforeSwitch = sizes().length;

    await user.click(await screen.findByRole("option", { name: "快照" }));
    expect(await screen.findByRole("listbox", { name: "选择要截取的窗口" })).toBeTruthy();
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 194 + 24 + 40 }));
    expect(sizes()).toHaveLength(callsBeforeSwitch + 1);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 180 + 24 + 40 }));
    expect(sizes()).toHaveLength(callsBeforeSwitch + 2);
    expect(sizes().every((size) => size.width === 360 + 80)).toBe(true);
  });
});

describe("快捷菜单：润色", () => {
  const settings = {
    baseUrl: "https://api.example.com",
    model: "demo-model",
    hasApiKey: true,
    templates: [
      { id: "a", name: "默认规则", content: "", builtin: true },
      { id: "b", name: "代码修改任务", content: "", builtin: false },
    ],
    activeTemplateId: "a",
    selectedAppearanceId: "app-icon",
    petAssets: [],
    shortcuts: [],
  } as unknown as Settings;

  it("点润色读取剪贴板；Tab 换规则重来；回车复制并收起", async () => {
    const { calls, user } = await renderPalette((command, payload) => {
      if (command === "load_settings") return settings;
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "read_clipboard_text") return "帮我把历史页按日期分组";
      if (command === "polish_text") {
        const args = payload as { text: string; templateId: string };
        return `【${args.templateId}】${args.text}`;
      }
      return undefined;
    });

    // 等设置读到（润色要用到当前规则）
    await waitFor(() => expect(calls.some((call) => call.command === "load_settings")).toBe(true));
    await user.click(screen.getByRole("option", { name: "润色 Prompt" }));

    expect(await screen.findByText("【a】帮我把历史页按日期分组")).toBeTruthy();
    await user.keyboard("{Tab}");
    expect(await screen.findByText("【b】帮我把历史页按日期分组")).toBeTruthy();

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(calls.find((call) => call.command === "copy_text")?.payload).toEqual({ text: "【b】帮我把历史页按日期分组" });
    });
    expect(calls.some((call) => call.command === "hide_quick_menu")).toBe(true);
  });

  it("没配模型时不发请求，直接说去哪里填", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "load_settings") return { ...settings, baseUrl: "", model: "" };
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "read_clipboard_text") return "帮我把历史页按日期分组";
      return undefined;
    });

    await waitFor(() => expect(calls.some((call) => call.command === "load_settings")).toBe(true));
    await user.click(screen.getByRole("option", { name: "润色 Prompt" }));

    expect(await screen.findByText(/还没填模型接口/)).toBeTruthy();
    expect(calls.some((call) => call.command === "polish_text")).toBe(false);
  });

  it("开启自动复制后，成功结果直接写入剪贴板", async () => {
    localStorage.setItem("snapshot-auto-copy", "1");
    const { calls, user } = await renderPalette((command) => {
      if (command === "load_settings") return settings;
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "read_clipboard_text") return "原始提示";
      if (command === "polish_text") return "润色结果";
      return undefined;
    });
    await waitFor(() => expect(calls.some((call) => call.command === "load_settings")).toBe(true));
    await user.click(screen.getByRole("option", { name: "润色 Prompt" }));
    await waitFor(() => {
      expect(calls.find((call) => call.command === "copy_text")?.payload).toEqual({ text: "润色结果" });
    });
  });

  it("重试请求进行中按 Enter 不会复制旧结果", async () => {
    let finishSecond!: (value: string) => void;
    let runs = 0;
    const { calls, user } = await renderPalette((command) => {
      if (command === "load_settings") return settings;
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "read_clipboard_text") return "原始提示";
      if (command === "polish_text") {
        runs += 1;
        if (runs === 1) return "旧结果";
        return new Promise<string>((resolve) => { finishSecond = resolve; });
      }
      return undefined;
    });
    await waitFor(() => expect(calls.some((call) => call.command === "load_settings")).toBe(true));
    await user.click(screen.getByRole("option", { name: "润色 Prompt" }));
    await screen.findByText("旧结果");
    await user.keyboard("{Tab}");
    await waitFor(() => expect(runs).toBe(2));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(calls.some((call) => call.command === "copy_text")).toBe(false);
    await act(async () => { finishSecond("新结果"); });
    expect(await screen.findByText("新结果")).toBeTruthy();
  });
});
