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
  // 侧栏「桌面伴侣」下每只一行；先点桌面上那只
  await screen.findByRole("group", { name: "桌面伴侣" });
  await user.click(petRow(settings.selectedAppearanceId));
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

/** 前台应用图标固定在最前；其余后导入的在前，导入时间相同保留原顺序 */
const shelfOrder = ["app-icon", "new", "twin-z", "twin-a", "old", "legacy-z", "legacy-a"];

function petGroup() {
  return screen.getByRole("group", { name: "桌面伴侣" });
}

function sidebarIds() {
  return Array.from(petGroup().querySelectorAll<HTMLElement>("[data-pet-id]")).map((row) => row.dataset.petId);
}

function petRow(id: string) {
  const row = petGroup().querySelector<HTMLElement>(`[data-pet-id="${id}"]`);
  if (!row) throw new Error(`侧栏里找不到 ${id}`);
  return row;
}

/** 桌面上的那只：侧栏那一行带「在桌面上」的勾 */
function deskIds() {
  return sidebarIds().filter((id) => within(petRow(id!)).queryByLabelText("在桌面上"));
}

describe("侧栏里伴侣的固定位置", () => {
  it("按导入时间由新到旧排列，相同或缺省时间沿用原顺序，不受选中项和最近使用时间影响", async () => {
    await renderPetPage(undefined, shelfSettings);

    expect(sidebarIds()).toEqual(shelfOrder);
    expect(deskIds()).toEqual(["old"]);
    expect(petRow("old").getAttribute("aria-current")).toBe("page");
    expect(within(petGroup()).getAllByRole("button", { name: /^同名伙伴/ })).toHaveLength(2);
  });

  it("按 id 查看、放到桌面；后端返回或广播新设置后位置不变，重挂载仍保持顺序", async () => {
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
      await user.click(petRow(id));
      // 只是看一看，桌面上那只还没换
      await waitFor(() => expect(petRow(id).getAttribute("aria-current")).toBe("page"));
      if (id !== saved.selectedAppearanceId) {
        expect(calls("select_pet_appearance").filter(([, payload]) => invokeArgs(payload).id === id)).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: "放到桌面" }));
      }
      await waitFor(() => expect(deskIds()).toEqual([id]));
      expect(screen.getByText("在桌面上")).toBeTruthy();

      expect(saved.selectedAppearanceId).toBe(id);
      if (id !== "app-icon") expect(saved.petAssets.find((asset) => asset.id === id)?.lastUsedAt).toBe(lastUsedAt);
      expect(sidebarIds()).toEqual(shelfOrder);
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
    expect(deskIds()).toEqual(["twin-a"]);
    expect(sidebarIds()).toEqual(shelfOrder);

    unmount();
    await renderPetPage(handle, saved);
    expect(deskIds()).toEqual(["twin-a"]);
    expect(sidebarIds()).toEqual(shelfOrder);
  });
});

async function openCatalogItem(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "更多" }));
  await user.click(await screen.findByRole("menuitem", { name: "浏览素材库…" }));
}

describe("桌面伴侣素材库入口", () => {
  it("只打开独立窗口，主页面不加载目录或展开素材卡片", async () => {
    const { user, calls } = await renderPetPage();
    expect(calls("fetch_pet_catalog")).toHaveLength(0);
    await openCatalogItem(user);
    await openCatalogItem(user);
    expect(calls("show_pet_catalog")).toHaveLength(2);
    expect(calls("fetch_pet_catalog")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "素材库" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "筛选素材库" })).toBeNull();
  });

  it("打开失败时在主页面显示原因", async () => {
    const { user } = await renderPetPage((command) => command === "show_pet_catalog" ? Promise.reject("窗口创建失败") : undefined);
    await openCatalogItem(user);
    expect((await screen.findAllByText("打开素材库失败：窗口创建失败")).length).toBeGreaterThan(0);
  });

  it("收到素材库导入的设置广播后更新侧栏和当前伴侣", async () => {
    await renderPetPage();
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => emit("settings-changed", {
      ...base, selectedAppearanceId: "catalog-new",
      petAssets: [{ id: "catalog-new", name: "新伙伴", path: "pets/new.zip", entry: "idle.gif", animations: ["idle.gif"] }],
    }));
    expect(deskIds()).toEqual(["catalog-new"]);
    expect(screen.getByRole("heading", { name: "新伙伴" })).toBeTruthy();
  });
});

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
