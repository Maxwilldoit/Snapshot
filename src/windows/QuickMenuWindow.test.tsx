import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { RecordingStatus, Settings } from "../types";
import { setupTauriMock } from "../test/tauri";
import { windowPickerLabels } from "../lib/windowList";

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

describe("快捷菜单：截取自身主窗口", () => {
  it.each([false, true])("长截图只在平台能力 enabled=%s 时出现并调用既有动作", async (enabled) => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "platform_capabilities") return { os: "linux", displayServer: "X11", recording: { available: true }, scrolling: { available: enabled } };
      return undefined;
    });
    await screen.findByRole("option", { name: "截图" });
    if (!enabled) {
      expect(screen.queryByRole("option", { name: /长截图/ })).toBeNull();
      expect(calls.some((call) => call.command === "run_action")).toBe(false);
      return;
    }
    const option = await screen.findByRole("option", { name: /长截图/ });
    await user.click(option);
    expect(calls.filter((call) => call.command === "run_action")).toEqual([
      expect.objectContaining({ payload: { action: "scrolling", targetId: null } }),
    ]);
  });

  it.each([
    ["macos", "AppKit"],
    ["windows", "Win32"],
    ["linux", "Wayland"],
  ] as const)("长截图在 %s / %s 上隐藏", async (os, displayServer) => {
    const { calls } = await renderPalette((command) => {
      if (command === "platform_capabilities") return { os, displayServer, recording: { available: true }, scrolling: os === "linux" ? { available: false } : undefined };
      return undefined;
    });
    await screen.findByRole("option", { name: "截图" });
    expect(screen.queryByRole("option", { name: /长截图/ })).toBeNull();
    expect(calls.some((call) => call.command === "run_action")).toBe(false);
  });

  it("键盘按可见行移动，隐藏的长截图不占位置", async () => {
    const { user } = await renderPalette((command) => {
      if (command === "platform_capabilities") return { os: "macos", displayServer: "desktop", recording: { available: true } };
      return undefined;
    });
    await screen.findByRole("option", { name: /录屏/ });
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: /录屏/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("option", { name: /长截图/ })).toBeNull();
  });

  it("长截图可用时仍显示已启用的快捷键", async () => {
    await renderPalette((command) => {
      if (command === "platform_capabilities") return { os: "linux", displayServer: "X11", recording: { available: true }, scrolling: { available: true } };
      if (command === "load_settings") return { shortcuts: [{ action: "scrolling", accelerator: "Alt+Shift+S" }], shortcutsPaused: false };
      return undefined;
    });
    const option = await screen.findByRole("option", { name: /长截图/ });
    await waitFor(() => expect(option).toHaveProperty("disabled", false));
    expect(option.textContent).toContain("Alt");
    expect(option.textContent).toContain("S");
  });

  it.each([false, true])("录屏不可用时隐藏开始入口，已有录制 active=%s 仍能停止", async (active) => {
    const { user, calls } = await renderPalette((command) => {
      if (command === "platform_capabilities") return { os: "linux", displayServer: "Wayland", recording: { available: false } };
      if (command === "get_recording_status") return { active, target: active ? "Code" : null, startedAt: active ? Date.now() : null };
      if (command === "toggle_recording") return { active: false, target: null, startedAt: null };
      return undefined;
    });
    await screen.findByRole("option", { name: "Prompt 库" });
    expect(screen.queryByRole("option", { name: "录屏" })).toBeNull();
    if (active) {
      await user.click(await screen.findByRole("option", { name: /停止录制/ }));
      expect(calls.filter((call) => call.command === "toggle_recording")).toHaveLength(1);
    } else {
      expect(screen.queryByRole("option", { name: /停止录制/ })).toBeNull();
      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(screen.getByRole("option", { name: "Prompt 库" }).getAttribute("aria-selected")).toBe("true");
    }
  });

  it.each([
    ["截图", "run_action", { action: "capture", targetId: 75 }],
    ["录屏", "toggle_recording", { targetId: 75 }],
  ] as const)("选择应用快照进行%s时使用它的明确窗口 id", async (label, commandName, payload) => {
    const ownMain = { id: 75, pid: 4244, appName: "snapshot", title: "应用快照", minimized: false };
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "list_capturable_windows") return [...windowList, ownMain];
      if (command === "run_action") return "已复制 snapshot";
      if (command === "toggle_recording") return { active: true, target: "snapshot", startedAt: 123 };
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: label }));
    await user.click(await screen.findByRole("option", { name: /snapshot.*应用快照/i }));
    await waitFor(() => {
      expect(calls.find((call) => call.command === commandName)?.payload).toEqual(payload);
    });
  });
});

describe("快捷菜单：macOS 屏幕录制授权", () => {
  const permissionError = {
    kind: "screenCapturePermission",
    message: "需要「屏幕录制」权限才能读取和截取窗口",
  };

  it.each(["截图", "录屏"])("%s 无权限时显示原因和授权入口，不显示空窗口列表", async (label) => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") throw permissionError;
      if (command === "authorize_screen_capture") return false;
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: label }));
    expect((await screen.findByRole("alert")).textContent).toBe(permissionError.message);
    expect(screen.queryByText("没有找到可用的窗口")).toBeNull();
    expect(screen.getByText(/若已开启仍无法读取/)).toBeTruthy();
    expect(screen.getByText(/移除旧的应用快照，再添加「应用程序」中的 snapshot.app/)).toBeTruthy();
    expect(calls.some((call) => call.command === "authorize_screen_capture")).toBe(false);
    await user.click(screen.getByRole("button", { name: "打开系统设置" }));
    await waitFor(() => expect(calls.some((call) => call.command === "authorize_screen_capture")).toBe(true));
    expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
  });

  it("开启授权后重新读取真实窗口，选择后使用明确的窗口 id", async () => {
    let granted = false;
    const { calls, user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") {
        if (!granted) throw permissionError;
        return windowList;
      }
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: "截图" }));
    await screen.findByRole("alert");
    granted = true;
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    await user.click(await screen.findByRole("option", { name: /Visual Studio Code/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.find((call) => call.command === "run_action")?.payload).toEqual({ action: "capture", targetId: 73 });
  });

  it("授权命令返回成功时自动重读，不必再次点按钮", async () => {
    let granted = false;
    const { user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") {
        if (!granted) throw permissionError;
        return windowList;
      }
      if (command === "authorize_screen_capture") return (granted = true);
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: "录屏" }));
    await user.click(await screen.findByRole("button", { name: "打开系统设置" }));
    expect(await screen.findByRole("option", { name: /Visual Studio Code/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("授权入口支持键盘回车，打开失败后保留说明并允许重试", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") throw permissionError;
      if (command === "authorize_screen_capture") throw "无法打开系统设置，请手动打开「屏幕录制」设置";
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: "截图" }));
    const button = await screen.findByRole("button", { name: "打开系统设置" });
    button.focus();
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("status")).textContent).toBe("无法打开系统设置，请手动打开「屏幕录制」设置");
    expect(calls.filter((call) => call.command === "authorize_screen_capture")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(permissionError.message);
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("等待授权时返回菜单，晚到的授权结果不会重新打开窗口列表", async () => {
    let finishAuthorization!: (granted: boolean) => void;
    const { calls, user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") throw permissionError;
      if (command === "authorize_screen_capture") {
        return new Promise<boolean>((resolve) => { finishAuthorization = resolve; });
      }
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: "截图" }));
    await user.click(await screen.findByRole("button", { name: "打开系统设置" }));
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("option", { name: "截图" })).toBeTruthy();
    await act(async () => finishAuthorization(true));
    expect(screen.getByRole("option", { name: "截图" })).toBeTruthy();
    expect(calls.filter((call) => call.command === "list_capturable_windows")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("其它枚举错误保留原始原因，不误报没有窗口或显示授权入口", async () => {
    const { user } = await renderPalette((command) => {
      if (command === "list_capturable_windows") throw { kind: "enumeration", message: "读取窗口失败" };
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: "截图" }));
    expect((await screen.findByRole("status")).textContent).toBe("读取窗口失败");
    expect(screen.queryByText("没有找到可用的窗口")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开系统设置" })).toBeNull();
  });
});

describe("快捷菜单：录制", () => {
  it("选「录制」先列窗口，点哪个就录哪个", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null } satisfies RecordingStatus;
      if (command === "list_capturable_windows") return windowList;
      if (command === "toggle_recording") return { active: true, target: "Visual Studio Code", startedAt: 123 } satisfies RecordingStatus;
      return undefined;
    });

    await user.click(await screen.findByRole("option", { name: "录屏" }));
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
    // 录屏进历史后不再弹「已保存」，直接收起快捷菜单
    await waitFor(() => expect(calls.some((call) => call.command === "hide_quick_menu")).toBe(true));
    expect(screen.queryByText("录制已保存")).toBeNull();

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

    await user.click(await screen.findByRole("option", { name: "录屏" }));
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

    await user.click(await screen.findByRole("option", { name: "录屏" }));
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

describe("快捷菜单：Prompt 库", () => {
  it("可以直接从右键宠物的菜单打开 Prompt 库", async () => {
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      return undefined;
    });
    await user.click(await screen.findByRole("option", { name: /Prompt 库/ }));
    await waitFor(() => expect(calls.some((call) => call.command === "show_prompt_library_window")).toBe(true));
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

    await user.click(screen.getByRole("option", { name: "截图" }));
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
      return this.querySelector(".palette-windows") ? 194 : 225;
    });
    const { calls, user } = await renderPalette((command) => (command === "list_capturable_windows" ? windowList : undefined));
    const sizes = () =>
      calls
        .filter((call) => call.command === "resize_quick_menu")
        .map((call) => call.payload as { width: number; height: number });
    // 面板宽 + 左右各 40
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 225 + 24 + 40 }));
    const callsBeforeSwitch = sizes().length;

    await user.click(await screen.findByRole("option", { name: "截图" }));
    expect(await screen.findByRole("listbox", { name: "选择要截取的窗口" })).toBeTruthy();
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 194 + 24 + 40 }));
    expect(sizes()).toHaveLength(callsBeforeSwitch + 1);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(sizes().at(-1)).toEqual({ width: 360 + 80, height: 225 + 24 + 40 }));
    expect(sizes()).toHaveLength(callsBeforeSwitch + 2);
    expect(sizes().every((size) => size.width === 360 + 80)).toBe(true);
  });

  it("六项菜单按实际高度包裹，最后一项不被固定五行高度裁掉", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("palette") ? parseFloat((this.parentElement as HTMLElement).style.width) || 0 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.isConnected || !this.classList.contains("palette")) return 0;
      const menu = this.querySelector(".palette-menu");
      return menu ? menu.querySelectorAll(".palette-item").length * 45 : 194;
    });
    const { calls } = await renderPalette((command) => command === "platform_capabilities"
      ? { os: "linux", displayServer: "X11", recording: { available: true }, scrolling: { available: true } }
      : undefined);
    await waitFor(() => expect(calls.some((call) => call.command === "resize_quick_menu" && (call.payload as { height: number }).height === 270 + 24 + 40)).toBe(true));
    expect(screen.getAllByRole("option")).toHaveLength(6);
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

    expect(await screen.findByText(/Prompt 页的设置/)).toBeTruthy();
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

describe("快捷菜单：窗口列表秒开", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("再次打开时立刻给上一次的列表，后台重读；旧列表里已关的窗口确认后提示，不去截它", async () => {
    let next: ReturnType<typeof deferred<typeof windowList>> | null = null;
    const { calls, user } = await renderPalette((command) => {
      if (command === "get_recording_status") return { active: false, target: null, startedAt: null };
      if (command === "run_action") return "ok";
      if (command !== "list_capturable_windows") return undefined;
      return next ? next.promise : windowList;
    });
    const listCalls = () => calls.filter((call) => call.command === "list_capturable_windows").length;
    await user.click(await screen.findByRole("option", { name: "截图" }));
    await screen.findByRole("listbox", { name: "选择要截取的窗口" });
    expect(listCalls()).toBe(1);

    // 下一次呼出菜单：一出来就预取；读得慢也不挡着切到列表
    next = deferred<typeof windowList>();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => {
      await emit("palette-opened");
    });
    await waitFor(() => expect(listCalls()).toBe(2));
    await user.click(await screen.findByRole("option", { name: "截图" }));
    expect(screen.getByRole("listbox", { name: "选择要截取的窗口" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(windowList.length);
    expect(listCalls()).toBe(2);

    await user.click(screen.getByRole("option", { name: /Visual Studio Code/ }));
    expect(calls.some((call) => call.command === "run_action")).toBe(false);
    await act(async () => next!.resolve([windowList[1]]));
    expect(await screen.findByText("这个窗口已经关闭，请重新选择")).toBeTruthy();
    expect(calls.some((call) => call.command === "run_action")).toBe(false);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    now.mockRestore();
  });
});
