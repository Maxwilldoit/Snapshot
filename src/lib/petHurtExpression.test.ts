import { describe, expect, it } from "vitest";
import type { PetAsset } from "../types";
import {
  augmentAssetWithAdoptedHit,
  augmentAssetWithBuiltinHurt,
  builtinHurtDurationMs,
  builtinHurtUrl,
  DSH_CHEEK_HIT_ENTRY,
  DSH_FOREHEAD_HIT_ENTRY,
  DSH_HEADTOP_HIT_ENTRY,
  DSH_OUCH_ACTION_FILE,
  DSH_OUCH_HIT_ENTRY,
  identifyCatalogSprite,
  isBuiltinHurtEntry,
  pickPetHurtMode,
} from "./petHurtExpression";

describe("petHurtExpression", () => {
  it("仅对大肥鱼（dsh-pet）注入 4 段站立抚头碰撞视频并为动作列表补齐碰撞回应-吃痛抚头（不重复追加）", () => {
    const whale: PetAsset = {
      id: "pet-whale",
      name: "大肥鱼",
      path: "dsh-pet-whale.zip",
      source: "https://github.com/Maxwilldoit/Pets#dsh-pet-whale",
      entry: "待机呼吸休闲.webm",
      animations: ["待机呼吸休闲.webm"],
    };
    const augmented = augmentAssetWithBuiltinHurt(whale, "dsh-pet")!;
    for (const entry of [
      DSH_OUCH_HIT_ENTRY,
      DSH_FOREHEAD_HIT_ENTRY,
      DSH_CHEEK_HIT_ENTRY,
      DSH_HEADTOP_HIT_ENTRY,
    ]) {
      expect(isBuiltinHurtEntry(entry)).toBe(true);
      expect(builtinHurtUrl(entry)).toBeTruthy();
      expect(builtinHurtDurationMs(entry)).toBeGreaterThan(7000);
      expect(augmented.layout?.frames.some((f) => f.entry === entry)).toBe(true);
    }

    const forActionList = augmentAssetWithAdoptedHit(whale, "dsh-pet")!;
    expect(forActionList.animations).toEqual(["待机呼吸休闲.webm", DSH_OUCH_HIT_ENTRY]);

    const withZipOuch: PetAsset = {
      ...whale,
      animations: ["待机呼吸休闲.webm", DSH_OUCH_ACTION_FILE],
    };
    expect(augmentAssetWithAdoptedHit(withZipOuch, "dsh-pet")).toBe(withZipOuch);
    expect(augmentAssetWithBuiltinHurt(withZipOuch, "dsh-pet")!.animations).not.toContain(DSH_OUCH_HIT_ENTRY);

    const makima: PetAsset = {
      id: "pet-makima",
      name: "玛奇玛",
      path: "makima.zip",
      source: "https://github.com/Maxwilldoit/Pets#makima-pixel",
      entry: "makima_pixel/gifs/makima_idle.gif",
      animations: ["makima_pixel/gifs/makima_idle.gif"],
    };
    expect(identifyCatalogSprite(makima)).toBeNull();
    expect(augmentAssetWithBuiltinHurt(makima, null)).toBe(makima);
  });

  it("按碰撞方向与速度轮换忍痛与眩晕模式", () => {
    expect(pickPetHurtMode("left", 500, 0)).toBe("wince");
    expect(pickPetHurtMode("left", 500, 2)).toBe("dizzy");
    expect(pickPetHurtMode("floor", 500, 0)).toBe("dizzy");
    expect(pickPetHurtMode("right", 1100, 0)).toBe("dizzy");
  });
});
