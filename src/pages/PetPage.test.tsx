import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invokeArgs, setupTauriMock, type IPCHandler } from "../test/tauri";
import type { PetCatalogAsset, Settings } from "../types";

const base: Settings = {
  baseUrl: "", model: "", hasApiKey: false, templates: [], activeTemplateId: "builtin-default",
  selectedAppearanceId: "app-icon", petAssets: [], petScale: 100, shortcuts: [],
  clipboardAutoClear: "60s", snapshotFormat: "png", saveDir: "", recordingDir: "",
  shutterSound: "crisp", customSoundPath: null, flashOnCapture: true, hideAfterCopy: false,
  autoSaveLocal: true, launchOnBoot: false, includeCursor: false, recordSystemAudio: false,
  recordMicrophone: false, afterCapture: "clipboard",
};

const first: PetCatalogAsset = {
  id: "example-moon", name: "示例月亮", description: "测试目录里的一位安静伙伴。", tags: ["安静", "夜晚"],
  version: "1.2.3", file: "example-moon.zip", sizeBytes: 1_572_864, sha256: "a".repeat(64),
  downloadUrl: "https://example.invalid/example-moon.zip",
  previewUrl: "https://raw.githubusercontent.com/Maxworkinghard/Pets/main/catalog/previews/example-moon.png",
  licenseStatus: "pending-review",
};
const second: PetCatalogAsset = {
  ...first, id: "example-star", name: "示例星星", description: "喜欢散步的小伙伴。", tags: ["活泼"],
  previewUrl: "https://raw.githubusercontent.com/Maxworkinghard/Pets/main/catalog/previews/example-star.png",
};

const imported: Settings = {
  ...base,
  petScale: 135,
  selectedAppearanceId: "local-imported-01",
  petAssets: [{
    id: "local-imported-01", name: first.name, path: "pets/imported.zip", entry: "idle.gif", animations: ["idle.gif"],
    source: `https://github.com/Maxworkinghard/Pets#${first.id}`, sizeBytes: first.sizeBytes,
  }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function renderPetPage(handle: IPCHandler = () => undefined, initial = base) {
  const ipc = vi.fn<IPCHandler>((command, payload) => command === "load_settings" ? structuredClone(initial) : handle(command, payload));
  setupTauriMock(ipc, { currentWindow: "main", shouldMockEvents: true });
  vi.resetModules();
  const { App } = await import("../App");
  render(<StrictMode><App /></StrictMode>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^桌面伴侣/ }));
  await screen.findByRole("button", { name: "浏览素材库" });
  return { user, calls: (command: string) => ipc.mock.calls.filter(([name]) => name === command) };
}

const library = () => within(screen.getByRole("region", { name: "素材库" }));
const item = (name = first.name) => within(library().getByRole("article", { name }));

describe("桌面伴侣素材库", () => {
  it("打开前不请求目录或预览；收起再打开会复用正在加载和已加载的目录", async () => {
    const pending = deferred<PetCatalogAsset[]>();
    const { user, calls } = await renderPetPage((command) => command === "fetch_pet_catalog" ? pending.promise : undefined);
    expect(calls("fetch_pet_catalog")).toHaveLength(0);
    expect(library().queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "浏览素材库" }).getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    expect(library().getByRole("status").textContent).toBe("正在加载素材库…");
    expect(calls("fetch_pet_catalog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "收起素材库" }));
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    expect(calls("fetch_pet_catalog")).toHaveLength(1);

    await act(async () => pending.resolve([first, second]));
    const card = item();
    expect(card.getByRole("img", { name: `${first.name}预览` }).getAttribute("src")).toBe(first.previewUrl);
    expect(card.getByText(first.description)).toBeTruthy();
    expect(card.getByText("安静")).toBeTruthy();
    expect(card.getByText("1.5 MB")).toBeTruthy();
    expect(card.getByText(first.version)).toBeTruthy();
    expect(card.getByText(first.licenseStatus)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "收起素材库" }));
    expect(library().queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    expect(item().getByRole("img")).toBeTruthy();
    expect(calls("fetch_pet_catalog")).toHaveLength(1);
    expect(calls("install_catalog_pet")).toHaveLength(0);
  });

  it("目录失败可重试；空目录有独立提示并可重新加载", async () => {
    const retry = deferred<PetCatalogAsset[]>();
    let attempt = 0;
    const { user, calls } = await renderPetPage((command) => {
      if (command !== "fetch_pet_catalog") return;
      attempt += 1;
      if (attempt === 1) return Promise.reject("目录请求超时");
      if (attempt === 2) return retry.promise;
      return [first];
    });
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    expect((await library().findByRole("alert")).textContent).toContain("目录请求超时");
    await user.click(library().getByRole("button", { name: "重试加载" }));
    expect(library().queryByRole("alert")).toBeNull();
    expect(library().getByRole("status").textContent).toBe("正在加载素材库…");
    await act(async () => retry.resolve([]));
    expect(library().getByRole("status").textContent).toBe("素材库里暂时没有素材。");
    expect(library().queryByRole("article")).toBeNull();
    await user.click(library().getByRole("button", { name: "重新加载" }));
    expect(await library().findByRole("article", { name: first.name })).toBeTruthy();
    expect(calls("fetch_pet_catalog")).toHaveLength(3);
  });

  it("筛选名称、描述和标签只操作已加载数据，匹配为空时可以清除", async () => {
    const { user, calls } = await renderPetPage((command) => command === "fetch_pet_catalog" ? [first, second] : undefined);
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    const filter = await library().findByRole("textbox", { name: "筛选素材库" });
    for (const term of ["月亮", "夜晚", "安静伙伴"]) {
      await user.clear(filter);
      await user.type(filter, term);
      expect(library().getAllByRole("article")).toHaveLength(1);
      expect(item().getByRole("heading", { name: first.name })).toBeTruthy();
    }
    await user.clear(filter);
    await user.type(filter, "不存在的素材");
    expect(library().getByRole("status").textContent).toBe("没有匹配的素材。");
    await user.click(library().getByRole("button", { name: "清除筛选" }));
    expect(library().getAllByRole("article")).toHaveLength(2);
    expect(calls("fetch_pet_catalog")).toHaveLength(1);
  });

  it("图片加载失败仍保留说明、授权与导入入口", async () => {
    const { user } = await renderPetPage((command) => command === "fetch_pet_catalog" ? [first] : undefined);
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    const preview = await library().findByRole("img");
    fireEvent.error(preview);
    expect(item().getByText("预览暂不可用")).toBeTruthy();
    expect(item().getByText(first.licenseStatus)).toBeTruthy();
    expect(item().getByRole("button", { name: `下载并导入「${first.name}」` })).toHaveProperty("disabled", false);
  });

  it("导入只传目录 id，等待时阻止重复和并行导入，成功采用完整 Settings 与选中形象", async () => {
    const pending = deferred<Settings>();
    const fetch = vi.spyOn(globalThis, "fetch");
    const { user, calls } = await renderPetPage((command) => {
      if (command === "fetch_pet_catalog") return [first, second];
      if (command === "install_catalog_pet") return pending.promise;
    });
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    const button = await library().findByRole("button", { name: `下载并导入「${first.name}」` });
    fireEvent.click(button);
    fireEvent.click(button);
    await user.click(item(second.name).getByRole("button"));
    expect(calls("install_catalog_pet")).toHaveLength(1);
    expect(invokeArgs(calls("install_catalog_pet")[0][1])).toEqual({ id: first.id });
    expect(item().getByRole("status").textContent).toContain("正在下载并导入");
    expect(item(second.name).getByRole("button")).toHaveProperty("disabled", true);
    expect(library().getByRole("button", { name: "刷新素材库" })).toHaveProperty("disabled", true);
    expect(within(screen.getByRole("region", { name: "当前伴侣" })).getByRole("heading").textContent).toBe("前台应用图标");

    await act(async () => pending.resolve(structuredClone(imported)));
    expect(within(screen.getByRole("region", { name: "当前伴侣" })).getByRole("heading").textContent).toBe(first.name);
    expect(screen.getByRole("radio", { name: first.name }).getAttribute("aria-checked")).toBe("true");
    expect(item().getByRole("status").textContent).toBe(`已导入「${first.name}」`);
    expect(item().getByRole("button", { name: `重新导入「${first.name}」` })).toHaveProperty("disabled", false);
    expect(item(second.name).getByRole("button")).toHaveProperty("disabled", false);
    expect(calls("select_pet_appearance")).toHaveLength(0);
    expect(calls("add_pet_assets")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));
    expect(await screen.findByRole("slider", { name: "大小" })).toHaveProperty("value", "135");
  });

  it("重新导入按来源匹配，保留后端的自定义名字；失败不换形象并能重试", async () => {
    const renamed = structuredClone(imported);
    renamed.petAssets[0].name = "用户起的名字";
    renamed.selectedAppearanceId = "app-icon";
    const retry = deferred<Settings>();
    let attempt = 0;
    const { user, calls } = await renderPetPage((command) => {
      if (command === "fetch_pet_catalog") return [first];
      if (command === "install_catalog_pet") return ++attempt === 1 ? Promise.reject(new Error("校验未通过")) : retry.promise;
    }, renamed);
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    await user.click(await library().findByRole("button", { name: `重新导入「${first.name}」` }));
    expect((await item().findByRole("alert")).textContent).toBe("导入失败：校验未通过");
    expect(screen.getByRole("radio", { name: "用户起的名字" }).getAttribute("aria-checked")).toBe("false");
    await user.click(item().getByRole("button", { name: `重试导入「${first.name}」` }));
    expect(item().queryByRole("alert")).toBeNull();
    await act(async () => retry.resolve({ ...renamed, selectedAppearanceId: renamed.petAssets[0].id }));
    expect(screen.getByRole("radio", { name: "用户起的名字" }).getAttribute("aria-checked")).toBe("true");
    expect(within(screen.getByRole("region", { name: "当前伴侣" })).getByRole("heading").textContent).toBe("用户起的名字");
    expect(item().getByRole("status").textContent).toBe("已导入「用户起的名字」");
    expect(calls("install_catalog_pet").map(([, payload]) => invokeArgs(payload))).toEqual([{ id: first.id }, { id: first.id }]);
    expect(calls("rename_pet_asset")).toHaveLength(0);
  });

  it("离开页面后到达的旧目录不会打开新页面的素材库", async () => {
    const pending = deferred<PetCatalogAsset[]>();
    const { user, calls } = await renderPetPage((command) => command === "fetch_pet_catalog" ? pending.promise : undefined);
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));
    await user.click(screen.getByRole("button", { name: /^桌面伴侣/ }));
    await act(async () => pending.resolve([first]));
    expect(screen.getByRole("button", { name: "浏览素材库" }).getAttribute("aria-expanded")).toBe("false");
    expect(library().queryByRole("article")).toBeNull();
    expect(calls("fetch_pet_catalog")).toHaveLength(1);
  });

  it("导入中收起再展开保留进度；切到别页后完成仍更新全局设置", async () => {
    const pending = deferred<Settings>();
    const { user, calls } = await renderPetPage((command) => {
      if (command === "fetch_pet_catalog") return [first];
      if (command === "install_catalog_pet") return pending.promise;
    });
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    await user.click(await library().findByRole("button", { name: `下载并导入「${first.name}」` }));
    await user.click(screen.getByRole("button", { name: "收起素材库" }));
    await user.click(screen.getByRole("button", { name: "浏览素材库" }));
    expect(item().getByRole("status").textContent).toContain("正在下载并导入");
    expect(item().getByRole("button")).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: /^偏好设置/ }));
    await act(async () => pending.resolve(structuredClone(imported)));
    expect(await screen.findByRole("button", { name: `${first.name}，去桌面伴侣页` })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^桌面伴侣/ }));
    expect(screen.getByRole("radio", { name: first.name }).getAttribute("aria-checked")).toBe("true");
    expect(calls("install_catalog_pet")).toHaveLength(1);
  });
});

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
