import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { PlatformCapabilities, Settings } from "../types";
import { setupTauriMock, type IPCHandler } from "../test/tauri";

/**
 * B2 拆页后的回归网：逐个导航到从 App.tsx 搬出的页面，确认它们在新位置
 * 仍然真的渲染出来（编译通过不等于渲染通过）。找出每个页面独有的文案做断言。
 */

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

function handler(command: string) {
  switch (command) {
    case "load_settings":
      return settings;
    case "platform_capabilities":
      return capabilities;
    case "list_snapshots":
      return [];
    case "list_prompt_history":
      return [];
    case "get_snapshot_dir":
      return "D:\\Snapshots";
    case "get_recording_dir":
      return "D:\\Recordings";
    case "get_recording_status":
      return { active: false, target: null, startedAt: null };
    default:
      return undefined;
  }
}

async function renderApp(handle: IPCHandler = handler) {
  setupTauriMock(handle, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("../App");
  render(<App />);
  // 等设置加载完（加载态消失，出现侧边栏导航）
  await screen.findByRole("button", { name: "快捷操作" });
}

describe("B2 拆页后逐页渲染", () => {
  it("默认落在快捷操作页，能看到快捷键行", async () => {
    await renderApp();
    expect(
      await screen.findByRole("button", { name: "快捷键：窗口快照，当前按键：Alt+Shift+2" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Prompt$/ })).toBeNull();
    expect(screen.queryByText("应用数据目录（默认）")).toBeNull();
    expect(screen.queryByText("系统「下载」目录")).toBeNull();
  });

  it("保存路径显示为可点击的虚线按钮，不再提供单独的打开按钮", async () => {
    const calls: string[] = [];
    await renderApp((command) => {
      if (command === "open_snapshots_dir" || command === "open_recordings_dir") {
        calls.push(command);
        return command === "open_snapshots_dir" ? "D:\\Snapshots" : "D:\\Recordings";
      }
      return handler(command);
    });
    const user = userEvent.setup();

    expect(await screen.findByText("保存快照到")).toBeTruthy();
    expect(screen.getByText("保存录像到")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
    const snapshot = await screen.findByRole("button", { name: /^打开快照文件夹：D:\\Snapshots$/ });
    const recording = screen.getByRole("button", { name: /^打开录像文件夹：D:\\Recordings$/ });
    expect(snapshot.classList.contains("storage-path")).toBe(true);
    expect(recording.classList.contains("storage-path")).toBe(true);
    await user.click(snapshot);
    await user.click(recording);
    await waitFor(() => expect(calls).toEqual(["open_snapshots_dir", "open_recordings_dir"]));
  });

  it.each([
    [/^历史记录/, "还没有历史记录"],
    [/^桌面伴侣/, "全部形象"],
    [/^偏好设置/, "截屏与行为"],
    [/^主题库/, "布局"],
  ])("导航到「%s」能渲染出该页独有内容", async (navLabel, marker) => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: navLabel }));
    // 换页不等旧页淡出，新页内容应当马上出现
    expect(await screen.findAllByText(marker, { exact: false })).not.toHaveLength(0);
  });

  it("历史记录把快照和 Prompt 放在同一页，并可展开原文与润色文", async () => {
    const createdAt = new Date(2026, 9, 24, 9, 5).getTime();
    await renderApp((command) => {
      if (command === "list_snapshots") {
        return [{
          id: "snap-1",
          fileName: "snap-1.png",
          appName: "Codex",
          width: 800,
          height: 600,
          sizeBytes: 1200,
          createdAt: createdAt + 60_000,
        }];
      }
      if (command === "list_prompt_history") {
        return [{
          id: "prompt-1",
          createdAt,
          template: "清晰、可执行",
          original: "帮我把按钮改得更容易找到",
          polished: "请提高主操作按钮的视觉层级，并明确其交互状态。",
        }];
      }
      return handler(command);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^历史记录/ }));

    expect(await screen.findByText("09:05")).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大：Codex" })).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "历史类型" })).toBeNull();
    const summary = screen.getAllByText("帮我把按钮改得更容易找到")[0].closest("summary");
    expect(summary).toBeTruthy();
    await user.click(summary!);
    expect(screen.getAllByText("帮我把按钮改得更容易找到")).toHaveLength(2);
    expect(screen.getAllByText("请提高主操作按钮的视觉层级，并明确其交互状态。")).toHaveLength(2);
  });

  it("偏好设置里拖桌宠大小：存下百分比，旁边跟着显示", async () => {
    const calls: Array<{ command: string; payload?: InvokeArgs }> = [];
    await renderApp((command, payload) => {
      calls.push({ command, payload });
      if (command === "save_preferences") return { ...settings, ...(payload as { prefs: Partial<Settings> }).prefs };
      return handler(command);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));
    const slider = await screen.findByRole("slider", { name: "大小" });
    fireEvent.change(slider, { target: { value: "150" } });
    expect(await screen.findByText("150%")).toBeTruthy();
    await waitFor(() =>
      expect(calls.find((call) => call.command === "save_preferences")?.payload).toEqual({ prefs: { petScale: 150 } }),
    );
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(await screen.findByText("100%")).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((call) => call.command === "save_preferences").at(-1)?.payload).toEqual({ prefs: { petScale: 100 } }),
    );
  });

  it("桌面宠物的自由走动、随机动作和重力分别保存", async () => {
    const calls: Array<{ command: string; payload?: InvokeArgs }> = [];
    await renderApp((command, payload) => {
      calls.push({ command, payload });
      if (command === "save_preferences") return { ...settings, ...(payload as { prefs: Partial<Settings> }).prefs };
      return handler(command);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));

    const wander = await screen.findByRole("switch", { name: "自由走动" });
    const random = screen.getByRole("switch", { name: "随机动作" });
    const gravity = screen.getByRole("switch", { name: "重力" });
    expect(wander.getAttribute("aria-checked")).toBe("false");
    expect(random.getAttribute("aria-checked")).toBe("false");
    expect(gravity.getAttribute("aria-checked")).toBe("true");

    await user.click(wander);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "save_preferences" && JSON.stringify(call.payload) === JSON.stringify({ prefs: { petWander: true } }))).toBe(true),
    );
    await user.click(random);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "save_preferences" && JSON.stringify(call.payload) === JSON.stringify({ prefs: { petRandomActions: true } }))).toBe(true),
    );
    await user.click(gravity);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "save_preferences" && JSON.stringify(call.payload) === JSON.stringify({ prefs: { petGravity: false } }))).toBe(true),
    );
  });

  it("偏好设置只在快门声右侧保留一个试听按钮", async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));

    const shutter = await screen.findByRole("radiogroup", { name: "快门声" });
    expect(within(shutter).getAllByRole("radio").map((button) => button.textContent)).toEqual([
      "清脆",
      "轻柔",
      "静音",
      "自定义",
    ]);
    expect(screen.queryByText("内置提示音")).toBeNull();
    expect(screen.queryByRole("button", { name: "换一个文件" })).toBeNull();
    const preview = screen.getAllByRole("button", { name: "试听" });
    expect(preview).toHaveLength(1);
    expect(preview[0].closest(".sound-label")).toBeTruthy();
  });

  it("截图后的第三个行为是仅保存，不再显示另存为", async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));

    expect(await screen.findByRole("radio", { name: "仅保存" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /另存为/ })).toBeNull();
  });

  it("主题库里换成「时间线」：侧栏消失，标题栏出现「今天」", async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^主题库/ }));
    await user.click(await screen.findByRole("radio", { name: /时间线/ }));
    expect(await screen.findByRole("button", { name: "今天" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "快捷操作" })).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem("snapshot-layout")).toBe("timeline"));
    window.localStorage.removeItem("snapshot-layout");
  });

  it("「时间线」的设置页里也能调桌宠大小", async () => {
    await renderApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^主题库/ }));
    await user.click(await screen.findByRole("radio", { name: /时间线/ }));
    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByRole("slider", { name: "大小" })).toBeTruthy();
    window.localStorage.removeItem("snapshot-layout");
  });
});
// jsdom 未实现 Element.prototype.scrollTo；App 换页后会调用它回到顶部。
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
