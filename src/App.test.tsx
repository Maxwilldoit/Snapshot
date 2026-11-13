import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { PlatformCapabilities, Settings } from "./types";
import { invokeArgs, setupTauriMock } from "./test/tauri";

const settings: Settings = {
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

const capabilities: PlatformCapabilities = {
  os: "windows",
  displayServer: "n/a",
  recording: { available: true },
  recordingSystemAudio: { available: true },
  recordingMicrophone: { available: true },
  autostart: { available: true },
  includeCursor: { available: true },
};

async function renderApp(handle: (command: string, payload?: InvokeArgs) => unknown) {
  setupTauriMock(handle, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("./App");
  render(<App />);
}

describe("主窗口 Prompt 页的内嵌 Prompt 库", () => {
  it("只提供一个新建入口，换页和快捷入口保留草稿，隐藏时不接管快捷键", async () => {
    const calls: string[] = [];
    await renderApp((command) => {
      calls.push(command);
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "list_saved_prompts" || command === "list_snapshots") return [];
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Prompt" }));
    await user.click(screen.getByRole("button", { name: "Prompt 库" }));
    const main = within(screen.getByRole("main"));
    await main.findByText("这里还空着");
    expect(main.getAllByRole("button", { name: "新建" })).toHaveLength(1);
    await user.keyboard("{Meta>}n{/Meta}");
    expect(main.queryByRole("textbox", { name: "正文" })).toBeNull();
    await user.click(main.getByRole("button", { name: "新建" }));
    await user.type(main.getByRole("textbox", { name: "正文" }), "暂未保存的 Prompt 草稿");
    await user.click(screen.getByRole("button", { name: "历史" }));
    await main.findByRole("heading", { name: "历史" });
    await user.keyboard("{Meta>}s{/Meta}");
    expect(calls).not.toContain("save_saved_prompt");
    await user.keyboard("{Meta>}f{/Meta}");
    expect(document.activeElement).toBe(main.getByRole("textbox", { name: "搜索截图" }));
    await act(async () => { await emit("prompt-library-opened"); });
    expect(await main.findByRole("textbox", { name: "正文" })).toHaveProperty("value", "暂未保存的 Prompt 草稿");
    await user.keyboard("{Escape}");
    await main.findByText("这里还空着");
    await user.keyboard("{Escape}");
    expect(main.getByRole("heading", { name: "Prompt" })).toBeTruthy();
    expect(calls).not.toContain("hide_prompt_library");
    expect(calls).not.toContain("show_prompt_library_window");
  });

  it("工具栏在历史、库、设置三个区块间切换，草稿跨区块保留", async () => {
    await renderApp((command) => {
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "list_saved_prompts" || command === "list_snapshots" || command === "list_prompt_history") return [];
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Prompt" }));
    const main = within(screen.getByRole("main"));
    await main.findByText("还没有 Prompt 记录");

    await user.click(main.getByRole("button", { name: "Prompt 库" }));
    await main.findByText("这里还空着");
    await user.click(main.getByRole("button", { name: "新建" }));
    await user.type(main.getByRole("textbox", { name: "正文" }), "跨区块草稿");

    // 切去设置再回来：编辑器草稿还在，工具栏始终只有一个
    await user.click(main.getByRole("button", { name: "设置" }));
    await main.findByRole("heading", { name: "润色用的模型" });
    expect(main.queryByRole("textbox", { name: "正文" })).toBeNull();
    await user.click(main.getByRole("button", { name: "Prompt 库" }));
    expect(await main.findByRole("textbox", { name: "正文" })).toHaveProperty("value", "跨区块草稿");
    expect(main.getAllByRole("banner")).toHaveLength(1);

    // 再点一次库按钮回到历史
    await user.click(main.getByRole("button", { name: "Prompt 库" }));
    await main.findByText("还没有 Prompt 记录");
  });

  it("读取失败可以重试；保存失败仍保留正文和可操作的编辑器", async () => {
    let attempts = 0;
    await renderApp((command) => {
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "list_saved_prompts") return ++attempts === 1 ? Promise.reject("无法读取文件") : [];
      if (command === "save_saved_prompt") return Promise.reject("磁盘不可写");
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Prompt" }));
    await user.click(screen.getByRole("button", { name: "Prompt 库" }));
    const main = within(screen.getByRole("main"));
    expect(await main.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("无法读取文件"));
    await user.click(main.getByRole("button", { name: "重试" }));
    await user.click(await main.findByRole("button", { name: "新建" }));
    await user.type(main.getByRole("textbox", { name: "正文" }), "保存失败也不能丢失");
    await user.click(main.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(main.getByRole("alert").textContent).toContain("磁盘不可写"));
    expect(main.getByRole("textbox", { name: "正文" })).toHaveProperty("value", "保存失败也不能丢失");
    expect(main.getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
  });
});

describe("global shortcuts", () => {
  it("hands an edited binding to the backend immediately and shows its verdict", async () => {
    const calls: Array<{ command: string; payload?: InvokeArgs }> = [];
    await renderApp((command, payload) => {
      calls.push({ command, payload });
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "get_shortcut_conflicts") return [];
      // 后端才是校验方：重复、认不出、被占用都由它拒绝，页面只负责转述
      if (command === "save_shortcuts") return Promise.reject("快捷键不能重复");
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^快捷键/ }));

    const recordRow = await screen.findByRole("button", { name: "快捷键：录屏，当前按键：未设置" });
    await user.click(recordRow);
    recordRow.focus();
    await user.keyboard("{Alt>}{Shift>}3{/Shift}{/Alt}");

    expect(await screen.findByText("快捷键不能重复")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "快捷键：录屏，当前按键：未设置" })).toBeTruthy();
    const saved = calls.find((call) => call.command === "save_shortcuts");
    expect(invokeArgs(saved?.payload).shortcuts).toEqual([
      { action: "snapshot", accelerator: "Alt+Shift+2" },
      { action: "record", accelerator: "Alt+Shift+3" },
    ]);
    // 网页不再自己注册快捷键
    expect(calls.some((call) => call.command.startsWith("plugin:global-shortcut"))).toBe(false);
  });

  it("tells the user which keys could not be registered at startup", async () => {
    await renderApp((command) => {
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "get_shortcut_conflicts") return ["Alt+Shift+2"];
      return undefined;
    });

    // 冲突由侧栏的猫说出来，按键写成人读的样子
    expect(await screen.findByText("Alt Shift 2 没能注册，可能被别的程序占用了")).toBeTruthy();
  });
});

describe("capture feedback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays the reaction for one shot ID only", async () => {
    await renderApp((command) => {
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "get_shortcut_conflicts") return [];
      return undefined;
    });
    await screen.findByRole("heading", { name: "历史" });
    const timeout = vi.spyOn(window, "setTimeout");
    const shot = {
      shotId: "shot-1",
      startedAtMs: Date.now(),
      sentAtMs: Date.now(),
      trace: false,
      flash: true,
      shutterSound: "crisp" as const,
      customSoundPath: null,
    };

    await act(async () => {
      await emit("capture-shot", shot);
      await emit("capture-shot", shot);
      // 最终事件保留给兼容消费者，不能再次触发快门闪光或第二遍声音。
      await emit("capture-feedback", {
        flash: true,
        shutterSound: "crisp",
        customSoundPath: null,
      });
    });

    expect(Array.from(document.querySelectorAll(".shutter-flash"))).toHaveLength(1);
    expect(timeout.mock.calls.filter((call) => call[1] === 220)).toHaveLength(1);
  });

  it("honors the sound setting and does not replay a capture-shot", async () => {
    let starts = 0;
    class CountingAudioContext {
      state = "running";
      currentTime = 0;
      sampleRate = 48_000;
      destination = {};
      resume = vi.fn(async () => {});
      createBuffer(_channels: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        starts += 1;
        return {
          buffer: null,
          connect: (target: unknown) => target,
          start: vi.fn(),
          stop: vi.fn(),
        };
      }
      createBiquadFilter() {
        return { frequency: { value: 0 }, Q: { value: 0 }, connect: (target: unknown) => target };
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: (target: unknown) => target,
        };
      }
    }
    vi.stubGlobal("AudioContext", CountingAudioContext);
    await renderApp((command) => {
      if (command === "load_settings") return settings;
      if (command === "platform_capabilities") return capabilities;
      if (command === "get_shortcut_conflicts") return [];
      return undefined;
    });
    await screen.findByRole("heading", { name: "历史" });

    const shot = {
      shotId: "shot-a",
      startedAtMs: Date.now(),
      sentAtMs: Date.now(),
      trace: false,
      flash: false,
      shutterSound: "crisp" as const,
      customSoundPath: null,
    };
    await act(async () => {
      await emit("capture-shot", shot);
      await emit("capture-shot", shot);
      await emit("capture-shot", { ...shot, shotId: "shot-b", shutterSound: "none" });
    });

    expect(starts).toBe(2);
  });
});
