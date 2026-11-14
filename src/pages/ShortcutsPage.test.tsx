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
  clipboardAutoClear: "60s",
  snapshotFormat: "png",
  saveDir: "",
  recordingDir: "",
  shutterSound: "crisp",
  customSoundPath: null,
  flashOnCapture: true,
  hideAfterCopy: false,
  autoSaveLocal: true,
  launchOnBoot: false,
  includeCursor: false,
  recordSystemAudio: false,
  recordMicrophone: false,
  afterCapture: "clipboard",
};

const ACTIVE = "在任何应用里都能用下面的组合键。";
const PAUSED = "已关闭：下面的快捷键都不响应，按键让给其他程序。设好的组合会保留。";
const TOGGLE = "启用全局快捷键";

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
  const toggle = await screen.findByRole("switch", { name: TOGGLE });
  return { user, toggle };
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

  it("commits a Delete-pending clear when clicking outside the field", async () => {
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

    await user.click(screen.getByRole("switch", { name: TOGGLE }));
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

describe("manual global shortcut pause", () => {
  it("pauses and resumes only after backend success, disables pending toggles and clears conflicts", async () => {
    let finishPause!: (next: Settings) => void;
    const pending = new Promise<Settings>((resolve) => { finishPause = resolve; });
    const setPaused = vi.fn((args: Record<string, unknown>): Promise<Settings> =>
      Promise.resolve(structuredClone({ ...base, shortcutsPaused: args.paused as boolean })),
    ).mockImplementationOnce(() => pending);
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") return setPaused(invokeArgs(payload));
      return undefined;
    }, base, ["Alt+Shift+2"]);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(ACTIVE)).toBeNull();
    expect(screen.getByText("没注册上，这组键已被其他程序占用")).toBeTruthy();

    await user.click(toggle);
    expect(setPaused).toHaveBeenCalledExactlyOnceWith({ paused: true });
    expect(toggle).toHaveProperty("disabled", true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(ACTIVE)).toBeNull();

    await act(async () => { finishPause(structuredClone({ ...base, shortcutsPaused: true })); });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(screen.queryByText("没注册上，这组键已被其他程序占用")).toBeNull();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(setPaused).toHaveBeenLastCalledWith({ paused: false });
    expect(screen.queryByText(ACTIVE)).toBeNull();
    expect(await screen.findByText("全局快捷键已恢复")).toBeTruthy();
  });

  it.each([false, true])("keeps paused=%s when the toggle fails", async (paused) => {
    const setPaused = vi.fn((_args: Record<string, unknown>) => Promise.reject(new Error("无法切换快捷键")));
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") return setPaused(invokeArgs(payload));
      return undefined;
    }, { ...base, shortcutsPaused: paused }, ["Alt+Shift+2"]);

    await user.click(toggle);
    expect((await screen.findByText("无法切换快捷键")).closest('[role="alert"]')).toBeTruthy();
    expect(setPaused).toHaveBeenCalledExactlyOnceWith({ paused: !paused });
    expect(toggle.getAttribute("aria-checked")).toBe(String(!paused));
    expect(screen.getByRole("button", { name: /快捷键：窗口截图/ })).toHaveProperty("disabled", paused);
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

  it("persists paused state through the real preview backend", async () => {
    vi.resetModules();
    const { installPreviewBackend } = await import("../lib/preview");
    installPreviewBackend();
    const { App } = await import("../App");
    const { loadSettings } = await import("../lib/backend");
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^快捷键/ }));
    const toggle = await screen.findByRole("switch", { name: TOGGLE });

    // The plain preview has no recorder capability. Use its supported capture
    // binding to verify persistence instead of editing a hidden recording row.
    await user.click(screen.getByRole("button", { name: "快捷键：窗口截图，当前按键：未设置" }));
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");
    await screen.findByRole("button", { name: "快捷键：窗口截图，当前按键：Alt+Shift+3" });
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    const saved = await loadSettings();
    expect(saved.shortcutsPaused).toBe(true);
    expect(saved.shortcuts.find((binding) => binding.action === "snapshot")?.accelerator).toBe("Alt+Shift+3");
  });
});
