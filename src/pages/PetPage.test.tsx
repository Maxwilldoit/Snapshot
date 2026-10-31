import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invokeArgs, setupTauriMock, type IPCHandler } from "../test/tauri";
import type { Settings } from "../types";

vi.mock("../lib/petAutoScale", () => ({ measurePetScale: vi.fn().mockResolvedValue(null) }));

const base: Settings = {
  baseUrl: "", model: "", hasApiKey: false, templates: [], activeTemplateId: "builtin-default",
  selectedAppearanceId: "app-icon", petAssets: [], petScale: 100, shortcuts: [],
  clipboardAutoClear: "60s", snapshotFormat: "png", saveDir: "", recordingDir: "",
  shutterSound: "crisp", customSoundPath: null, flashOnCapture: true, hideAfterCopy: false,
  autoSaveLocal: true, launchOnBoot: false, includeCursor: false, recordSystemAudio: false,
  recordMicrophone: false, afterCapture: "clipboard",
};

async function renderPetPage(handle: IPCHandler = () => undefined, settings: Settings = base) {
  const ipc = vi.fn<IPCHandler>((command, payload) => command === "load_settings" ? structuredClone(settings) : handle(command, payload));
  setupTauriMock(ipc, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("../App");
  const view = render(<StrictMode><App /></StrictMode>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^桌面伴侣/ }));
  return { user, unmount: view.unmount, calls: (command: string) => ipc.mock.calls.filter(([name]) => name === command) };
}

const shelfSettings: Settings = {
  ...base,
  selectedAppearanceId: "old",
  petAssets: [
    { id: "legacy-z", name: "旧素材 Z", path: "pets/legacy-z.gif", entry: "idle.gif", animations: ["idle.gif"], lastUsedAt: 10_000 },
    { id: "twin-z", name: "同名伙伴", path: "pets/twin-z.gif", entry: "idle.gif", animations: ["idle.gif"], importedAt: 200, lastUsedAt: 300 },
    { id: "old", name: "最早导入", path: "pets/old.gif", entry: "idle.gif", animations: ["idle.gif"], importedAt: 100, lastUsedAt: 9_000 },
    { id: "new", name: "最新导入", path: "pets/new.gif", entry: "idle.gif", animations: ["idle.gif"], importedAt: 300, lastUsedAt: 100 },
    { id: "twin-a", name: "同名伙伴", path: "pets/twin-a.gif", entry: "idle.gif", animations: ["idle.gif"], importedAt: 200, lastUsedAt: 8_000 },
    { id: "legacy-a", name: "旧素材 A", path: "pets/legacy-a.gif", entry: "idle.gif", animations: ["idle.gif"], importedAt: 0, lastUsedAt: 20_000 },
  ],
};

const shelfOrder = ["app-icon", "new", "twin-z", "twin-a", "old", "legacy-z", "legacy-a"];

function shelfRadios() {
  return within(screen.getByRole("radiogroup", { name: "选择伴侣" })).getAllByRole("radio");
}

function shelfIds() {
  return shelfRadios().map((radio) => radio.closest<HTMLElement>("[data-flip-key]")?.dataset.flipKey);
}

function shelfRadio(id: string) {
  const radio = shelfRadios().find((item) => item.closest<HTMLElement>("[data-flip-key]")?.dataset.flipKey === id);
  if (!radio) throw new Error(`形象架上找不到 ${id}`);
  return radio;
}

describe("全部形象的固定位置", () => {
  it("按导入时间由新到旧排列，相同或缺省时间沿用原顺序，不受选中项和最近使用时间影响", async () => {
    await renderPetPage(undefined, shelfSettings);

    expect(shelfIds()).toEqual(shelfOrder);
    expect(shelfRadio("old").getAttribute("aria-checked")).toBe("true");
    expect(within(screen.getByRole("radiogroup", { name: "选择伴侣" })).getAllByRole("radio", { name: "同名伙伴" })).toHaveLength(2);
  });

  it("按 id 切换同名形象，后端返回或广播新设置后位置不变，重挂载仍保持顺序", async () => {
    let saved = structuredClone(shelfSettings);
    let lastUsedAt = 30_000;
    const handle: IPCHandler = (command, payload) => {
      if (command !== "select_pet_appearance") return undefined;
      const id = String(invokeArgs(payload).id);
      saved = {
        ...saved,
        selectedAppearanceId: id,
        petAssets: saved.petAssets.map((asset) => asset.id === id ? { ...asset, lastUsedAt: ++lastUsedAt } : asset),
      };
      return structuredClone(saved);
    };
    const { user, calls, unmount } = await renderPetPage(handle, saved);
    const backendOrder = saved.petAssets.map((asset) => asset.id);

    for (const id of ["twin-a", "twin-z", "old", "app-icon"]) {
      await user.click(shelfRadio(id));
      await waitFor(() => expect(shelfRadio(id).getAttribute("aria-checked")).toBe("true"));

      expect(saved.selectedAppearanceId).toBe(id);
      if (id !== "app-icon") expect(saved.petAssets.find((asset) => asset.id === id)?.lastUsedAt).toBe(lastUsedAt);
      expect(shelfIds()).toEqual(shelfOrder);
      expect(shelfRadios().filter((radio) => radio.getAttribute("aria-checked") === "true")).toEqual([shelfRadio(id)]);
      expect(saved.petAssets.map((asset) => asset.id)).toEqual(backendOrder);
    }
    expect(calls("select_pet_appearance").map(([, payload]) => invokeArgs(payload).id)).toEqual(["twin-a", "twin-z", "old", "app-icon"]);

    // 独立窗口的设置广播也会带来新的数组和最近使用时间。
    saved = {
      ...saved,
      selectedAppearanceId: "twin-a",
      petAssets: saved.petAssets.map((asset) => ({ ...asset, lastUsedAt: ++lastUsedAt })),
    };
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => emit("settings-changed", structuredClone(saved)));
    expect(shelfRadio("twin-a").getAttribute("aria-checked")).toBe("true");
    expect(shelfIds()).toEqual(shelfOrder);

    unmount();
    await renderPetPage(handle, saved);
    expect(shelfRadio("twin-a").getAttribute("aria-checked")).toBe("true");
    expect(shelfIds()).toEqual(shelfOrder);
  });
});

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
