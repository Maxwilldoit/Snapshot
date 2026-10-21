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
    expect(selected.source).toBe(`https://github.com/Maxworkinghard/Pets#${catalog[0].id}`);
    const { petUrl, petThumbUrl } = await import("./media");
    expect(petUrl(selected.id, selected.entry)).toBe(catalog[0].previewUrl);
    expect(petThumbUrl(selected.id)).toBe(catalog[0].previewUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("重新导入复用已有素材并保留改名，不污染目录副本", async () => {
    vi.useFakeTimers();
    const backend = await preview();
    const pending = backend.fetchPetCatalog();
    await vi.runAllTimersAsync();
    const [asset] = await pending;
    const first = backend.installCatalogPet(asset.id);
    await vi.runAllTimersAsync();
    const installed = await first;
    await backend.renamePetAsset(installed.selectedAppearanceId, "自定义演示名字");
    await backend.selectPetAppearance("app-icon");
    const again = backend.installCatalogPet(asset.id);
    await vi.runAllTimersAsync();
    const reinstalled = await again;
    expect(reinstalled.selectedAppearanceId).toBe(installed.selectedAppearanceId);
    expect(reinstalled.petAssets).toHaveLength(installed.petAssets.length);
    expect(reinstalled.petAssets.find((pet) => pet.id === reinstalled.selectedAppearanceId)?.name).toBe("自定义演示名字");
    const originalName = asset.name;
    asset.name = "修改返回的副本";
    const reloaded = backend.fetchPetCatalog();
    await vi.runAllTimersAsync();
    expect((await reloaded)[0].name).toBe(originalName);
    await expect(backend.installCatalogPet("unknown-demo")).rejects.toThrow("演示素材不存在");
  });
});
