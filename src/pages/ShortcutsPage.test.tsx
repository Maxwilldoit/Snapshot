import { act, render, screen, waitFor } from "@testing-library/react";
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

const ACTIVE = "启用中";
const PAUSED = "未启用";

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
  const toggle = await screen.findByRole("switch", { name: "暂停全局快捷键" });
  return { user: userEvent.setup(), toggle };
}

async function recordBinding(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "快捷键：窗口录制，当前按键：未设置" }));
  await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");
  return screen.findByRole("button", { name: "快捷键：窗口录制，当前按键：Alt+Shift+3" });
}

describe("global shortcut editing", () => {
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
    const row = screen.getByRole("button", { name: "快捷键：窗口录制，当前按键：未设置" });
    await user.click(row);
    expect(screen.queryByText("Esc 取消")).toBeNull();
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");

    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith({ shortcuts: [
      { action: "snapshot", accelerator: "Alt+Shift+2" },
      { action: "record", accelerator: "Alt+Shift+3" },
    ] }));
    expect(await screen.findByRole("button", { name: "快捷键：窗口录制，当前按键：Alt+Shift+3" })).toBeTruthy();
  });

  it("saves a cleared binding immediately and rolls back a rejected change", async () => {
    localStorage.setItem("snapshot-layout", "ledger");
    const reject = vi.fn((_payload?: unknown) => Promise.reject(new Error("快捷键已被占用")));
    let rejectNext = false;
    const { user } = await renderApp((command, payload) => {
      if (command !== "save_shortcuts") return undefined;
      if (rejectNext) return reject(payload);
      return structuredClone({ ...base, shortcuts: invokeArgs(payload).shortcuts as ShortcutBinding[] });
    });

    await user.click(screen.getByRole("button", { name: "清除「窗口快照」的快捷键" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "清除「窗口快照」的快捷键" })).toBeNull());

    rejectNext = true;
    const recordRow = screen.getByRole("button", { name: "快捷键：窗口录制，当前按键：未设置" });
    await user.click(recordRow);
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");
    expect((await screen.findByRole("alert")).textContent).toContain("快捷键已被占用");
    expect(await screen.findByRole("button", { name: "快捷键：窗口录制，当前按键：未设置" })).toBeTruthy();
    localStorage.removeItem("snapshot-layout");
  });

  it("keeps paused state while saving a new binding", async () => {
    const initial = { ...base, shortcutsPaused: true };
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...initial,
      shortcuts: args.shortcuts as ShortcutBinding[],
    }));
    const { user } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    }, initial);

    await recordBinding(user);
    expect(await screen.findByText("快捷键绑定已保存，全局快捷键仍保持暂停")).toBeTruthy();
    expect(screen.queryByText("快捷键已保存，立即生效")).toBeNull();
    expect(save).toHaveBeenCalledWith({ shortcuts: [
      { action: "snapshot", accelerator: "Alt+Shift+2" },
      { action: "record", accelerator: "Alt+Shift+3" },
    ] });
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

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(ACTIVE).closest(".pause-setting")).toBeTruthy();
    expect(screen.getByText("没注册上，这组键已被其他程序占用")).toBeTruthy();

    await user.click(toggle);
    expect(setPaused).toHaveBeenCalledExactlyOnceWith({ paused: true });
    expect(toggle).toHaveProperty("disabled", true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(ACTIVE)).toBeTruthy();

    await act(async () => { finishPause(structuredClone({ ...base, shortcutsPaused: true })); });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.getByText(PAUSED).closest(".pause-setting")).toBeTruthy();
    expect(screen.queryByText("没注册上，这组键已被其他程序占用")).toBeNull();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(setPaused).toHaveBeenLastCalledWith({ paused: false });
    expect(screen.getByText(ACTIVE)).toBeTruthy();
    expect(await screen.findByText("全局快捷键已恢复")).toBeTruthy();
  });

  it.each([false, true])("keeps paused=%s when the toggle fails", async (paused) => {
    localStorage.setItem("snapshot-layout", "ledger");
    const setPaused = vi.fn((_args: Record<string, unknown>) => Promise.reject(new Error("无法切换快捷键")));
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") return setPaused(invokeArgs(payload));
      return undefined;
    }, { ...base, shortcutsPaused: paused }, ["Alt+Shift+2"]);

    await user.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain("无法切换快捷键");
    expect(setPaused).toHaveBeenCalledExactlyOnceWith({ paused: !paused });
    expect(toggle.getAttribute("aria-checked")).toBe(String(paused));
    expect(screen.getByText(paused ? PAUSED : ACTIVE)).toBeTruthy();
    localStorage.removeItem("snapshot-layout");
  });

  it("follows external settings changes without an unsaved local draft", async () => {
    await renderApp();
    await act(async () => {
      await emit("settings-changed", {
        ...base,
        shortcuts: [{ action: "snapshot", accelerator: "Alt+Shift+4" }, { action: "record", accelerator: null }],
      });
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口快照，当前按键：Alt+Shift+4" })).toBeTruthy();
  });

  it("persists paused state through the real preview backend", async () => {
    vi.resetModules();
    const { installPreviewBackend } = await import("../lib/preview");
    installPreviewBackend();
    const { App } = await import("../App");
    const { loadSettings } = await import("../lib/backend");
    render(<App />);
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", { name: "暂停全局快捷键" });

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await recordBinding(user);
    const saved = await loadSettings();
    expect(saved.shortcutsPaused).toBe(true);
    expect(saved.shortcuts.find((binding) => binding.action === "record")?.accelerator).toBe("Alt+Shift+3");
  });
});
