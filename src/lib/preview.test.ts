import { describe, expect, it, vi } from "vitest";

async function preview() {
  vi.resetModules();
  const { installPreviewBackend } = await import("./preview");
  installPreviewBackend();
  return import("./backend");
}

describe("素材库浏览器演示", () => {
  it("返回明确标注的本地演示图与完整目录信息，导入可选中且媒体地址可显示", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch");
    const backend = await preview();
    const pending = backend.fetchPetCatalog();
    await vi.runAllTimersAsync();
    const catalog = await pending;
    expect(catalog.length).toBeGreaterThanOrEqual(3);
    for (const asset of catalog) {
      expect(asset.name).toContain("演示");
      expect(asset.tags).toContain("演示");
      expect(asset.licenseStatus).toContain("演示数据");
      expect(asset.previewUrl).toMatch(/^data:image\/svg\+xml,/);
      expect(asset.downloadUrl).toMatch(/^https:\/\/example\.invalid\//);
      expect(asset.sizeBytes).toBeGreaterThan(0);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const install = backend.installCatalogPet(catalog[0].id);
    await vi.runAllTimersAsync();
    const settings = await install;
    const selected = settings.petAssets.find((asset) => asset.id === settings.selectedAppearanceId)!;
    expect(selected.name).toBe(catalog[0].name);
    expect(selected.source).toBe(`https://github.com/Maxwilldoit/Pets#${catalog[0].id}`);
    const { petUrl, petThumbUrl } = await import("./media");
    expect(petUrl(selected.id, selected.entry)).toBe(catalog[0].previewUrl);
    expect(petThumbUrl(selected.id)).toBe(catalog[0].previewUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("重新导入复用已有素材；收起桌宠保留选中，再选即恢复，不污染目录副本", async () => {
    vi.useFakeTimers();
    const backend = await preview();
    const pending = backend.fetchPetCatalog();
    await vi.runAllTimersAsync();
    const [asset] = await pending;
    const first = backend.installCatalogPet(asset.id);
    await vi.runAllTimersAsync();
    const installed = await first;
    await backend.selectPetAppearance("app-icon");
    const hidden = await backend.hidePet();
    expect(hidden.petHidden).toBe(true);
    expect(hidden.selectedAppearanceId).toBe("app-icon");
    const shown = await backend.selectPetAppearance(installed.selectedAppearanceId);
    expect(shown.petHidden).toBe(false);
    const again = backend.installCatalogPet(asset.id);
    await vi.runAllTimersAsync();
    const reinstalled = await again;
    expect(reinstalled.selectedAppearanceId).toBe(installed.selectedAppearanceId);
    expect(reinstalled.petHidden).toBe(false);
    expect(reinstalled.petAssets).toHaveLength(installed.petAssets.length);
    expect(reinstalled.petAssets.find((pet) => pet.id === reinstalled.selectedAppearanceId)?.name).toBe(asset.name);
    const originalName = asset.name;
    asset.name = "修改返回的副本";
    const reloaded = backend.fetchPetCatalog();
    await vi.runAllTimersAsync();
    expect((await reloaded)[0].name).toBe(originalName);
    await expect(backend.installCatalogPet("unknown-demo")).rejects.toThrow("演示素材不存在");
  });

  it("导入重名文件自动加后缀，同批导入也分得清", async () => {
    const backend = await preview();
    const first = await backend.addPetAssets(["/downloads/小猫.gif"]);
    expect(first.settings.petAssets.find((pet) => pet.id === first.settings.selectedAppearanceId)?.name).toBe("小猫");
    const second = await backend.addPetAssets(["/other/小猫.gif", "/third/小猫.gif"]);
    const names = second.settings.petAssets.map((pet) => pet.name);
    expect(names.filter((name) => name.startsWith("小猫"))).toEqual(["小猫", "小猫 2", "小猫 3"]);
    expect(second.settings.petHidden).toBe(false);
  });
});

describe("录屏浏览器演示", () => {
  it("?demo 列出可播放的演示录像，删除后列表与媒体地址同步", async () => {
    window.history.replaceState(null, "", "?demo");
    try {
      const backend = await preview();
      const list = await backend.listRecordings();
      expect(list.length).toBe(3);
      for (const record of list) {
        expect(record.fileName).toMatch(/\.mp4$/);
        expect(record.sizeBytes).toBeGreaterThan(0);
        expect(record.appName).toBeTruthy();
      }
      const { recordingUrl } = await import("./media");
      expect(recordingUrl(list[0].id)).toMatch(/^data:video\/mp4;base64,/);

      const kept = await backend.deleteRecordings([list[0].id]);
      expect(kept.map((record) => record.id)).toEqual(list.slice(1).map((record) => record.id));
      expect(await backend.listRecordings()).toHaveLength(2);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
