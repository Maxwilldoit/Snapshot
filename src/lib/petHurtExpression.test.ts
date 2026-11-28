import { describe, expect, it } from "vitest";
import type { PetAsset } from "../types";
import { clickableAnimations, pickHitAnimation } from "./petActions";
import {
  augmentAssetWithBuiltinHurt,
  BUILTIN_HIT_PREFIX,
  builtinHurtUrl,
  identifyCatalogSprite,
  isBuiltinHurtEntry,
  pickPetHurtMode,
  type CatalogSpriteId,
} from "./petHurtExpression";

const ALL_CATALOG_SPRITES: ReadonlyArray<{
  id: CatalogSpriteId;
  entry: string;
}> = [
  { id: "makima-pixel", entry: "makima_pixel/gifs/makima_idle.gif" },
  { id: "yamada-clerk", entry: "yamada_pixel/gifs/clerk_idle.gif" },
  { id: "yamada-pixel", entry: "yamada_pixel/gifs/idle.gif" },
  { id: "clawd", entry: "clawd_gifs/clawd-idle.gif" },
  { id: "nashor-v1", entry: "nashor_pet_v1/gifs/nashor_idle.gif" },
  { id: "nashor-v2", entry: "nashor_pet_v2/gifs/nashor_idle.gif" },
  { id: "hoop-23", entry: "hoop-23-idle.gif" },
  { id: "kuro-blade", entry: "kuro-blade-idle.gif" },
  { id: "momo", entry: "momo-idle.gif" },
];

describe("petHurtExpression", () => {
  it("识别素材库全部 9 款 GIF 宠物（在线 source 锚点与离线文件路径均可匹配），排除大肥鱼与普通自制包", () => {
    for (const item of ALL_CATALOG_SPRITES) {
      expect(
        identifyCatalogSprite({
          source: `https://github.com/Maxwilldoit/Pets#${item.id}`,
          entry: "custom.gif",
          animations: ["custom.gif"],
        }),
      ).toBe(item.id);
      expect(
        identifyCatalogSprite({
          source: "/Users/test/Downloads/local.zip",
          entry: item.entry,
          animations: [item.entry],
        }),
      ).toBe(item.id);
    }
    expect(
      identifyCatalogSprite({
        source: "https://github.com/Maxwilldoit/Pets#dsh-pet-whale",
        entry: "待机呼吸休闲.webm",
        animations: ["待机呼吸休闲.webm"],
      }),
    ).toBeNull();
    expect(
      identifyCatalogSprite({
        source: "/tmp/grok.zip",
        entry: "gifs/grok_idle.gif",
        animations: ["gifs/grok_idle.gif"],
      }),
    ).toBeNull();
  });

  it("为全部 9 款素材库 GIF 宠物自动注入内置高清受击立绘、布局锚点与透明边界，且不混入普通点击循环", () => {
    for (const item of ALL_CATALOG_SPRITES) {
      const raw: PetAsset = {
        id: `pet-${item.id}`,
        name: item.id,
        path: `${item.id}.zip`,
        source: `https://github.com/Maxwilldoit/Pets#${item.id}`,
        entry: item.entry,
        animations: [item.entry, "feedback/failure.gif"],
        eventActions: { "capture.failure": "feedback/failure.gif" },
      };
      const augmented = augmentAssetWithBuiltinHurt(raw)!;
      const expectedEntry = `${BUILTIN_HIT_PREFIX}${item.id}`;
      expect(isBuiltinHurtEntry(expectedEntry)).toBe(true);
      expect(builtinHurtUrl(expectedEntry)).toBeTruthy();
      expect(pickHitAnimation(augmented)).toBe(expectedEntry);
      expect(clickableAnimations(augmented)).toEqual([item.entry]);
      expect(augmented.layout?.frames.some((f) => f.entry === expectedEntry)).toBe(true);
      expect(augmented.actionBounds?.[expectedEntry]?.bounds.width).toBeGreaterThan(0.2);
    }
  });

  it("按碰撞方向与速度轮换忍痛与眩晕模式", () => {
    expect(pickPetHurtMode("left", 500, 0)).toBe("wince");
    expect(pickPetHurtMode("left", 500, 2)).toBe("dizzy");
    expect(pickPetHurtMode("floor", 500, 0)).toBe("dizzy");
    expect(pickPetHurtMode("right", 1100, 0)).toBe("dizzy");
  });
});
