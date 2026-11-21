import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import type { ShortcutBinding, Settings } from "../types";
import { invokeArgs, setupTauriMock, type IPCHandler } from "../test/tauri";

// Deliberately omit shortcutsPaused: older settings and fixtures default to active.
const base: Settings = {
  baseUrl: "",
  model: "",
  hasApiKey: false,
  templates: [],
  activeTemplateId: "builtin-default",
  selectedAppearanceId: "app-icon",
  petAssets: [],
  petScale: 100,
  shortcuts: [
    { action: "snapshot", accelerator: "Alt+Shift+2" },
    { action: "record", accelerator: null },
  ],
  snapshotFormat: "png",
  saveDir: "",
  recordingDir: "",
  shutterSound: "crisp",
  customSoundPath: null,
  launchOnBoot: false,
  includeCursor: false,
  recordSystemAudio: false,
  recordMicrophone: false,
};

const PAUSED_NOTE = "全局快捷键已暂停，可在菜单栏图标中恢复";

async function renderApp(handle: IPCHandler = () => undefined, initial: Settings = base, conflicts: string[] = []) {
  let current = structuredClone(initial);
  setupTauriMock((command, payload) => {
    if (command === "load_settings") return structuredClone(current);
    if (command === "get_shortcut_conflicts") return conflicts;
    const custom = handle(command, payload);
    if (custom !== undefined) return custom;
    if (command === "save_shortcuts") {
      const shortcuts = invokeArgs(payload).shortcuts as ShortcutBinding[];
      current = { ...current, shortcuts };
      return structuredClone(current);
    }
    if (command === "get_snapshot_dir") return "C:\\Snapshots";
    if (command === "get_recording_dir") return "C:\\Recordings";
    return undefined;
  }, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("../App");
  render(<App />);
  const user = userEvent.setup();
  // 主窗口默认打开截图记录；快捷键在侧栏「设置 · 快捷键」
  await user.click(await screen.findByRole("button", { name: /^快捷键/ }));
  await screen.findByRole("button", { name: /快捷键：窗口截图/ });
  return { user };
}

describe("global shortcut editing", () => {
  it("隐藏当前系统不能用的绑定，编辑其他快捷键仍保留隐藏绑定", async () => {
    const initial: Settings = {
      ...base,
      shortcuts: [
        ...base.shortcuts,
        { action: "scrolling", accelerator: "Alt+Shift+S" },
      ],
    };
    const save = vi.fn();
    const { user } = await renderApp((command, payload) => {
      if (command === "platform_capabilities") return { os: "linux", displayServer: "Wayland", recording: { available: false }, scrolling: { available: false } };
      if (command === "save_shortcuts") save(invokeArgs(payload).shortcuts);
      return undefined;
    }, initial);
    expect(screen.queryByRole("button", { name: /快捷键：录屏/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /快捷键：长截图/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /快捷键：窗口截图/ }));
    await user.keyboard("{Alt>}a{/Alt}");
    await waitFor(() => expect(save).toHaveBeenCalledWith([
      { action: "snapshot", accelerator: "Alt+A" },
      { action: "record", accelerator: null },
      { action: "scrolling", accelerator: "Alt+Shift+S" },
    ]));
  });

  it("Linux X11 长截图能力可用时显示可编辑的快捷键", async () => {
    await renderApp((command) => command === "platform_capabilities"
      ? { os: "linux", displayServer: "X11", recording: { available: true }, scrolling: { available: true } }
      : undefined, { ...base, shortcuts: [...base.shortcuts, { action: "scrolling", accelerator: null }] });
    expect(screen.getByRole("button", { name: /快捷键：长截图/ })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: /快捷键：录屏/ })).toHaveProperty("disabled", false);
  });

  it("uses the physical key code instead of the Shift-modified character", async () => {
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...base,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    });
    const row = screen.getByRole("button", { name: "快捷键：录屏，当前按键：未设置" });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "#", code: "Digit3", altKey: true, shiftKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      shortcuts: [
        { action: "snapshot", accelerator: "Alt+Shift+2" },
        { action: "record", accelerator: "Alt+Shift+3" },
      ],
    });
  });

  it("saves immediately and removes the save, clear-all and Esc hint controls", async () => {
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...base,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    const { user } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    });

    expect(screen.queryByRole("button", { name: "保存快捷键" })).toBeNull();
    expect(screen.queryByText("全部清除")).toBeNull();
    const row = screen.getByRole("button", { name: "快捷键：录屏，当前按键：未设置" });
    await user.click(row);
    expect(screen.queryByText("Esc 取消")).toBeNull();
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");

    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith({ shortcuts: [
      { action: "snapshot", accelerator: "Alt+Shift+2" },
      { action: "record", accelerator: "Alt+Shift+3" },
    ] }));
    expect(await screen.findByRole("button", { name: "快捷键：录屏，当前按键：Alt+Shift+3" })).toBeTruthy();
  });

  it("clears a binding only after Delete plus a click, and rolls back a rejected change", async () => {
    const reject = vi.fn((_payload?: unknown) => Promise.reject(new Error("快捷键已被占用")));
    let rejectNext = false;
    const { user } = await renderApp((command, payload) => {
      if (command !== "save_shortcuts") return undefined;
      if (rejectNext) return reject(payload);
      return structuredClone({ ...base, shortcuts: invokeArgs(payload).shortcuts as ShortcutBinding[] });
    });

    const snapshotRow = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    await user.click(snapshotRow);
    expect(snapshotRow.classList.contains("is-recording")).toBe(true);
    expect(snapshotRow.textContent).toContain("2");
    expect(screen.queryByText("按下快捷键…")).toBeNull();
    expect(screen.queryByRole("button", { name: /清除/ })).toBeNull();

    await user.keyboard("{Delete}");
    expect(snapshotRow.classList.contains("is-clearing")).toBe(true);
    expect(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" })).toBeTruthy();

    await user.click(snapshotRow);
    await waitFor(() => expect(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" }).classList.contains("is-recording")).toBe(false));

    rejectNext = true;
    const recordRow = screen.getByRole("button", { name: "快捷键：录屏，当前按键：未设置" });
    await user.click(recordRow);
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");
    expect((await screen.findByText("快捷键已被占用")).closest('[role="alert"]')).toBeTruthy();
    expect(await screen.findByRole("button", { name: "快捷键：录屏，当前按键：未设置" })).toBeTruthy();
  });

  it("keeps the current combo visible while recording and overwrites it with a new combo", async () => {
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...base,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    const { user } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    });

    const row = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    await user.click(row);
    expect(row.classList.contains("is-recording")).toBe(true);
    expect(row.textContent).toContain("2");
    expect(screen.queryByText("按下快捷键…")).toBeNull();

    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      shortcuts: [
        { action: "snapshot", accelerator: "CommandOrControl+Shift+K" },
        { action: "record", accelerator: null },
      ],
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：CommandOrControl+Shift+K" })).toBeTruthy();
  });

  it("commits a Delete-pending clear when focus leaves the field", async () => {
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...base,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    const { user } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    });

    const row = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    await user.click(row);
    await user.keyboard("{Delete}");
    expect(save).not.toHaveBeenCalled();

    // 纯键盘按 Tab 可正常移出焦点并确认清空，不再被 preventDefault 困在按钮内
    await user.tab();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      shortcuts: [
        { action: "snapshot", accelerator: null },
        { action: "record", accelerator: null },
      ],
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" })).toBeTruthy();
  });

  it("commits a Delete-pending clear immediately when pressing Enter", async () => {
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...base,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    const { user } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    });

    const row = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    row.focus();
    await user.keyboard("{Enter}{Delete}{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      shortcuts: [
        { action: "snapshot", accelerator: null },
        { action: "record", accelerator: null },
      ],
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" })).toBeTruthy();
  });

  it("Escape after Delete keeps the existing binding", async () => {
    const save = vi.fn();
    const { user } = await renderApp((command) => {
      if (command === "save_shortcuts") save();
      return undefined;
    });

    const row = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    await user.click(row);
    await user.keyboard("{Delete}");
    await user.keyboard("{Escape}");
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" })).toBeTruthy();
    expect(row.classList.contains("is-recording")).toBe(false);
  });

  it("cancels recording when clicking outside the shortcut field without changing the binding", async () => {
    const save = vi.fn();
    const { user } = await renderApp((command) => {
      if (command === "save_shortcuts") save();
      return undefined;
    });

    const row = screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" });
    await user.click(row);
    expect(row.classList.contains("is-recording")).toBe(true);

    // 模拟 macOS WKWebView 点击非聚焦空白区域（不会触发 blur，但会触发 document pointerdown）
    fireEvent.pointerDown(screen.getByRole("heading", { name: "截图与录制" }));
    expect(row.classList.contains("is-recording")).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" })).toBeTruthy();
  });

  it("dims and locks the shortcut fields while global shortcuts are off", async () => {
    const save = vi.fn();
    await renderApp((command) => {
      if (command === "save_shortcuts") save();
      return undefined;
    }, { ...base, shortcutsPaused: true });

    const field = screen.getByRole("button", { name: "快捷键：录屏，当前按键：未设置" });
    expect(field).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+2" })).toHaveProperty("disabled", true);
    expect(field.closest(".panel-shortcuts")?.classList.contains("is-off")).toBe(true);
    expect(screen.getByText(PAUSED_NOTE)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "暂停全局快捷键" })).toBeNull();
    expect(screen.getByRole("switch", { name: "按快捷键时在桌宠旁选窗口" })).toHaveProperty("disabled", true);
    fireEvent.click(field);
    fireEvent.keyDown(field, { key: "#", code: "Digit3", altKey: true, shiftKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("groups rows under capture and Prompt headings with one recorder field per row", async () => {
    const { user } = await renderApp(undefined, {
      ...base,
      shortcuts: [
        ...base.shortcuts,
        { action: "polish", accelerator: null },
        { action: "prompts", accelerator: "CommandOrControl+Shift+P" },
      ],
    });
    expect(screen.queryByRole("heading", { name: "全局快捷键" })).toBeNull();
    const capture = screen.getByRole("heading", { name: "截图与录制" }).closest("section")!;
    const prompt = screen.getByRole("heading", { name: "Prompt" }).closest("section")!;
    expect(capture.textContent).toContain("窗口截图");
    expect(capture.textContent).toContain("录屏");
    expect(prompt.textContent).toContain("润色 Prompt");
    expect(prompt.textContent).toContain("打开 Prompt 库");
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("点按录制")).toBeNull();

    await user.click(screen.getByRole("button", { name: "快捷键：录屏，当前按键：未设置" }));
    expect(screen.getByText("按下快捷键…")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("按下快捷键…")).toBeNull();
  });
});

describe("pause state pushed from the menu bar", () => {
  it("locks the fields and clears stale conflict marks when the tray pauses shortcuts", async () => {
    await renderApp(undefined, base, ["Alt+Shift+2"]);
    expect(screen.getByText("没注册上，这组键已被其他程序占用")).toBeTruthy();
    expect(screen.queryByText(PAUSED_NOTE)).toBeNull();

    await act(async () => {
      await emit("settings-changed", structuredClone({ ...base, shortcutsPaused: true }));
    });
    expect(await screen.findByText(PAUSED_NOTE)).toBeTruthy();
    expect(screen.queryByText("没注册上，这组键已被其他程序占用")).toBeNull();
    expect(screen.getByRole("button", { name: /快捷键：窗口截图/ })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("switch", { name: "暂停全局快捷键" })).toBeNull();
    expect(screen.getByRole("switch", { name: "按快捷键时在桌宠旁选窗口" })).toHaveProperty("disabled", true);

    await act(async () => {
      await emit("settings-changed", structuredClone(base));
    });
    await waitFor(() => expect(screen.queryByText(PAUSED_NOTE)).toBeNull());
    expect(screen.getByRole("button", { name: /快捷键：窗口截图/ })).toHaveProperty("disabled", false);
  });

  it("follows external settings changes without an unsaved local draft", async () => {
    await renderApp();
    await act(async () => {
      await emit("settings-changed", {
        ...base,
        shortcuts: [{ action: "snapshot", accelerator: "Alt+Shift+4" }, { action: "record", accelerator: null }],
      });
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+4" })).toBeTruthy();
  });

  it("offers a direct shortcut for opening the Prompt library", async () => {
    await renderApp(undefined, {
      ...base,
      shortcuts: [
        ...base.shortcuts,
        { action: "prompts", accelerator: "CommandOrControl+Shift+P" },
      ],
    });
    expect(screen.getByRole("button", { name: /快捷键：打开 Prompt 库/ })).toBeTruthy();
  });

  it("persists edited bindings through the real preview backend without a pause switch", async () => {
    vi.resetModules();
    const { installPreviewBackend } = await import("../lib/preview");
    installPreviewBackend();
    const { App } = await import("../App");
    const { loadSettings } = await import("../lib/backend");
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^快捷键/ }));

    // The plain preview has no recorder capability. Use its supported capture
    // binding to verify persistence instead of editing a hidden recording row.
    await user.click(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" }));
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");
    await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+3" });
    expect(screen.queryByRole("switch", { name: "暂停全局快捷键" })).toBeNull();
    const pickWindowSwitch = screen.getByRole("switch", { name: "按快捷键时在桌宠旁选窗口" });
    expect(pickWindowSwitch.getAttribute("aria-checked")).toBe("false");
    await user.click(pickWindowSwitch);
    await waitFor(() => expect(pickWindowSwitch.getAttribute("aria-checked")).toBe("true"));
    const saved = await loadSettings();
    expect(saved.shortcutsPaused ?? false).toBe(false);
    expect(saved.shortcutPickWindow).toBe(true);
    expect(saved.shortcuts.find((binding) => binding.action === "snapshot")?.accelerator).toBe("Alt+Shift+3");
  });
});
