import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setupTauriMock, type IPCHandler } from "../test/tauri";
import type { Settings } from "../types";

const base: Settings = {
  baseUrl: "", model: "", hasApiKey: false, templates: [], activeTemplateId: "builtin-default",
  selectedAppearanceId: "app-icon", petAssets: [], petScale: 100, shortcuts: [],
  clipboardAutoClear: "60s", snapshotFormat: "png", saveDir: "", recordingDir: "",
  shutterSound: "crisp", customSoundPath: null, flashOnCapture: true, hideAfterCopy: false,
  autoSaveLocal: true, launchOnBoot: false, includeCursor: false, recordSystemAudio: false,
  recordMicrophone: false, afterCapture: "clipboard",
};

async function renderPetPage(handle: IPCHandler = () => undefined) {
  const ipc = vi.fn<IPCHandler>((command, payload) => command === "load_settings" ? structuredClone(base) : handle(command, payload));
  setupTauriMock(ipc, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("../App");
  render(<StrictMode><App /></StrictMode>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^桌面伴侣/ }));
  return { user, calls: (command: string) => ipc.mock.calls.filter(([name]) => name === command) };
}

describe("桌面伴侣素材库入口", () => {
  it("只打开独立窗口，主页面不加载目录或展开素材卡片", async () => {
    const { user, calls } = await renderPetPage();
    expect(calls("fetch_pet_catalog")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /浏览素材库/ }));
    await user.click(screen.getByRole("button", { name: /浏览素材库/ }));
    expect(calls("show_pet_catalog")).toHaveLength(2);
    expect(calls("fetch_pet_catalog")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "素材库" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "筛选素材库" })).toBeNull();
  });

  it("打开失败时在主页面显示原因", async () => {
    const { user } = await renderPetPage((command) => command === "show_pet_catalog" ? Promise.reject("窗口创建失败") : undefined);
    await user.click(screen.getByRole("button", { name: /浏览素材库/ }));
    expect((await screen.findAllByText("打开素材库失败：窗口创建失败")).length).toBeGreaterThan(0);
  });

  it("收到素材库导入的设置广播后更新形象架和当前伴侣", async () => {
    await renderPetPage();
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => emit("settings-changed", {
      ...base, selectedAppearanceId: "catalog-new",
      petAssets: [{ id: "catalog-new", name: "新伙伴", path: "pets/new.zip", entry: "idle.gif", animations: ["idle.gif"] }],
    }));
    expect(screen.getByRole("radio", { name: "新伙伴" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { name: "新伙伴" })).toBeTruthy();
  });
});

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
