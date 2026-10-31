import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetAsset } from "../types";
import { measurePetScale } from "./petAutoScale";
import { ensurePetAutoScale, persistPetBaseScale, readPetBaseScale, resetPetBaseScale, watchPetBaseScales } from "./petScale";

vi.mock("./petAutoScale", () => ({ measurePetScale: vi.fn() }));

const makima: PetAsset = { id: "makima", name: "同名", path: "m.zip", entry: "idle.gif", animations: ["idle.gif"] };
const whale: PetAsset = {
  id: "whale", name: "同名", path: "w.zip", entry: "待机呼吸休闲.webm",
  animations: ["待机呼吸休闲.webm", "用鲸鱼尾巴拍打地面.webm", "蓝鲸现世.webm"],
};

describe("每个形象的基准大小", () => {
  beforeEach(() => { vi.mocked(measurePetScale).mockReset(); });

  it("文件名和角色名字没有特殊待遇，未测量的素材使用普通基准", () => {
    expect(readPetBaseScale(whale)).toBe(100);
    expect(readPetBaseScale({ ...whale, name: "已改名" })).toBe(100);
    expect(readPetBaseScale(makima)).toBe(100);
    expect(readPetBaseScale({ ...makima, entry: "idle.webm", animations: ["idle.webm"] })).toBe(100);
    expect(readPetBaseScale(null)).toBe(100);
  });

  it("普通 GIF/WebM 自动测量并缓存，带作者布局的素材不改变原大小", async () => {
    vi.mocked(measurePetScale).mockResolvedValueOnce(200).mockResolvedValueOnce(140);
    await ensurePetAutoScale(whale);
    await ensurePetAutoScale(makima);
    expect(readPetBaseScale(whale)).toBe(200);
    expect(readPetBaseScale(makima)).toBe(140);
    const authored = { ...makima, id: "authored", layout: { baseWidth: 202, baseHeight: 292, anchorX: 101, anchorY: 292, frames: [] } };
    await ensurePetAutoScale(authored);
    expect(readPetBaseScale(authored)).toBe(100);
    expect(measurePetScale).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const reloaded = await import("./petScale");
    await reloaded.ensurePetAutoScale({ ...whale, name: "新名字" });
    expect(reloaded.readPetBaseScale(whale)).toBe(200);
    expect(measurePetScale).toHaveBeenCalledTimes(2);
  });

  it("重复请求复用任务，更换素材后旧测量结果不能覆盖新结果", async () => {
    let finishOld!: (scale: number) => void;
    let finishNew!: (scale: number) => void;
    vi.mocked(measurePetScale)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const asset = { ...whale, id: "upgraded" };
    const first = ensurePetAutoScale(asset);
    expect(ensurePetAutoScale(asset)).toBe(first);
    const upgraded = { ...asset, path: "new-package.zip" };
    const second = ensurePetAutoScale(upgraded);
    await Promise.resolve();
    finishNew(130);
    await second;
    finishOld(200);
    await first;
    expect(readPetBaseScale(upgraded)).toBe(130);
    expect(readPetBaseScale(asset)).toBe(100);
    expect(measurePetScale).toHaveBeenCalledTimes(2);
  });

  it("后台适配保留手动值，恢复自动时只取消当前形象的覆盖", async () => {
    vi.mocked(measurePetScale).mockResolvedValue(200);
    persistPetBaseScale(whale.id, 150);
    persistPetBaseScale(makima.id, 80);
    await ensurePetAutoScale(whale);
    expect(readPetBaseScale(whale)).toBe(150);
    resetPetBaseScale(whale.id);
    expect(readPetBaseScale(whale)).toBe(200);
    expect(readPetBaseScale(makima)).toBe(80);
  });

  it("测量失败保留普通大小且短期内不重复解码，不妨碍其它形象", async () => {
    const failed = { ...whale, id: "failed" };
    vi.mocked(measurePetScale).mockResolvedValueOnce(null).mockResolvedValueOnce(170);
    await ensurePetAutoScale(failed);
    await ensurePetAutoScale(failed);
    expect(readPetBaseScale(failed)).toBe(100);
    expect(localStorage.getItem("snapshot-pet-auto-scale:failed")).toBeNull();
    await ensurePetAutoScale({ ...makima, id: "unaffected" });
    expect(measurePetScale).toHaveBeenCalledTimes(2);
  });

  it("缓存损坏时重新测量，存储失败也不会让导入或显示失败", async () => {
    localStorage.setItem("snapshot-pet-auto-scale:corrupt", "{");
    vi.mocked(measurePetScale).mockResolvedValue(180);
    const asset = { ...whale, id: "corrupt" };
    await ensurePetAutoScale(asset);
    expect(readPetBaseScale(asset)).toBe(180);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const unavailable = { ...whale, id: "unavailable" };
    await expect(ensurePetAutoScale(unavailable)).resolves.toBeUndefined();
    expect(readPetBaseScale(unavailable)).toBe(100);
  });

  it("按 id 保存和重载，同名形象分别调整互不覆盖，手动校准优先于默认值", async () => {
    persistPetBaseScale(whale.id, 150);
    persistPetBaseScale(makima.id, 80);
    vi.resetModules();
    const reloaded = await import("./petScale");
    expect(reloaded.readPetBaseScale({ ...whale, name: "新名字", path: "new.zip" })).toBe(150);
    expect(reloaded.readPetBaseScale(makima)).toBe(80);
    expect(reloaded.readPetBaseScale({ ...makima, id: "another" })).toBe(100);
  });

  it("监听同窗口修改和其它窗口存储变化，并在卸载后停止同步", () => {
    const change = vi.fn();
    const stop = watchPetBaseScales(change);
    persistPetBaseScale(whale.id, 160);
    expect(change).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(change).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: "snapshot-pet-base-scales" }));
    expect(change).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent("storage", { key: "snapshot-pet-auto-scale:whale" }));
    expect(change).toHaveBeenCalledTimes(3);
    stop();
    persistPetBaseScale(makima.id, 120);
    window.dispatchEvent(new StorageEvent("storage", { key: "snapshot-pet-base-scales" }));
    expect(change).toHaveBeenCalledTimes(3);
  });
});
