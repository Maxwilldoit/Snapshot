import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
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

const ACTIVE = "已启用 · 全局快捷键正在响应";
const PAUSED = "已暂停 · 全局快捷键不响应";

async function renderApp(handle: IPCHandler = () => undefined, initial: Settings = base, conflicts: string[] = []) {
  setupTauriMock((command, payload) => {
    if (command === "load_settings") return structuredClone(initial);
    if (command === "get_shortcut_conflicts") return conflicts;
    return handle(command, payload);
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

describe("manual global shortcut pause", () => {
  it("pauses and resumes only after backend success, disables pending toggles and clears conflicts", async () => {
    let finishPause!: (next: Settings) => void;
    const pending = new Promise<Settings>((resolve) => { finishPause = resolve; });
    const setPaused = vi.fn((args: Record<string, unknown>): Promise<Settings> =>
      Promise.resolve(structuredClone({ ...base, shortcutsPaused: args.paused as boolean })),
    ).mockImplementationOnce(() => pending);
    const save = vi.fn();
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") return setPaused(invokeArgs(payload));
      if (command === "save_shortcuts") return save(payload);
      return undefined;
    }, base, ["Alt+Shift+2"]);

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(ACTIVE)).toBeTruthy();
    expect(screen.getByText("没注册上，这组键已被其他程序占用")).toBeTruthy();
    expect(setPaused).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(setPaused).toHaveBeenCalledExactlyOnceWith({ paused: true });
    expect(toggle).toHaveProperty("disabled", true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(ACTIVE)).toBeTruthy();
    await user.click(toggle);
    expect(setPaused).toHaveBeenCalledTimes(1);

    await act(async () => { finishPause(structuredClone({ ...base, shortcutsPaused: true })); });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.getByText(PAUSED)).toBeTruthy();
    expect(screen.getByText("暂停会释放按键，保留已保存的绑定；仍可录入、编辑和保存。")).toBeTruthy();
    expect(screen.queryByText("没注册上，这组键已被其他程序占用")).toBeNull();
    expect(screen.getByRole("button", { name: "快捷键：窗口快照，当前按键：Alt+Shift+2" })).toBeTruthy();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(setPaused).toHaveBeenLastCalledWith({ paused: false });
    expect(setPaused).toHaveBeenCalledTimes(2);
    expect(screen.getByText(ACTIVE)).toBeTruthy();
    expect(await screen.findByText("全局快捷键已恢复")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps paused=%s when the toggle fails and retains conflicts only while active", async (paused) => {
    // The ledger layout exposes error notices with role=alert.
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
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.getByText(paused ? PAUSED : ACTIVE)).toBeTruthy();
    if (paused) expect(screen.queryByText("没注册上，这组键已被其他程序占用")).toBeNull();
    else expect(screen.getByText("没注册上，这组键已被其他程序占用")).toBeTruthy();
  });

  it("allows clearing, recording and saving bindings while paused, and reports that pause remains", async () => {
    const initial = { ...base, shortcutsPaused: true };
    const save = vi.fn((args: Record<string, unknown>) => structuredClone({
      ...initial,
      shortcuts: args.shortcuts as Settings["shortcuts"],
    }));
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "save_shortcuts") return save(invokeArgs(payload));
      return undefined;
    }, initial);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: "清除「窗口快照」的快捷键" }));
    await recordBinding(user);
    const saveButton = screen.getByRole("button", { name: "保存快捷键" });
    expect(saveButton).toHaveProperty("disabled", false);
    await user.click(saveButton);

    expect(await screen.findByText("快捷键绑定已保存，全局快捷键仍保持暂停")).toBeTruthy();
    expect(save).toHaveBeenCalledExactlyOnceWith({ shortcuts: [
      { action: "snapshot", accelerator: null },
      { action: "record", accelerator: "Alt+Shift+3" },
    ] });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(PAUSED)).toBeTruthy();
    expect(screen.queryByText("快捷键已保存，立即生效")).toBeNull();
    await waitFor(() => expect(saveButton).toHaveProperty("disabled", true));
    expect(screen.queryByText("改了 2 处，还没保存")).toBeNull();
  });

  it("keeps unsaved bindings when a successful manual toggle returns a fresh settings object", async () => {
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") {
        return structuredClone({ ...base, shortcutsPaused: invokeArgs(payload).paused });
      }
      return undefined;
    });
    await recordBinding(user);
    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("button", { name: "快捷键：窗口录制，当前按键：Alt+Shift+3" })).toBeTruthy();
    expect(screen.getByText("改了 1 处，还没保存")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存快捷键" })).toHaveProperty("disabled", false);
  });

  it("follows external settings-changed pause/resume events and preserves edits when bindings stay the same", async () => {
    const setPaused = vi.fn();
    const { user, toggle } = await renderApp((command, payload) => {
      if (command === "set_shortcuts_paused") return setPaused(payload);
      return undefined;
    });
    await recordBinding(user);

    for (const paused of [true, false]) {
      await act(async () => {
        await emit("settings-changed", structuredClone({ ...base, shortcutsPaused: paused }));
      });
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe(String(paused)));
      expect(screen.getByText(paused ? PAUSED : ACTIVE)).toBeTruthy();
      expect(screen.getByRole("button", { name: "快捷键：窗口录制，当前按键：Alt+Shift+3" })).toBeTruthy();
      expect(screen.getByText("改了 1 处，还没保存")).toBeTruthy();
    }
    expect(setPaused).not.toHaveBeenCalled();

    // Actual binding changes from outside must still replace the saved bindings.
    await act(async () => {
      await emit("settings-changed", {
        ...base,
        shortcuts: [{ action: "snapshot", accelerator: "Alt+Shift+4" }, { action: "record", accelerator: null }],
      });
    });
    expect(await screen.findByRole("button", { name: "快捷键：窗口快照，当前按键：Alt+Shift+4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存快捷键" })).toHaveProperty("disabled", true);
  });

  it("persists paused state when saving bindings through the real preview backend", async () => {
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
    await user.click(screen.getByRole("button", { name: "保存快捷键" }));
    expect(await screen.findByText("快捷键绑定已保存，全局快捷键仍保持暂停")).toBeTruthy();
    const saved = await loadSettings();
    expect(saved.shortcutsPaused).toBe(true);
    expect(saved.shortcuts.find((binding) => binding.action === "record")?.accelerator).toBe("Alt+Shift+3");

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(await loadSettings()).toMatchObject({ shortcutsPaused: false, shortcuts: saved.shortcuts });
  });
});
