import { describe, expect, it } from "vitest";
import {
  identifyCatalogSprite,
  paintHurtSpritePixels,
  pickPetHurtMode,
  type CatalogSpriteId,
} from "./petHurtExpression";

const ALL_CATALOG_SPRITES: ReadonlyArray<{
  id: CatalogSpriteId;
  width: number;
  height: number;
  entry: string;
}> = [
  { id: "makima-pixel", width: 202, height: 292, entry: "makima_pixel/gifs/makima_idle.gif" },
  { id: "yamada-clerk", width: 208, height: 306, entry: "yamada_pixel/gifs/clerk_idle.gif" },
  { id: "yamada-pixel", width: 163, height: 292, entry: "yamada_pixel/gifs/idle.gif" },
  { id: "clawd", width: 256, height: 256, entry: "clawd_gifs/clawd-idle.gif" },
  { id: "nashor-v1", width: 420, height: 420, entry: "nashor_pet_v1/gifs/nashor_idle.gif" },
  { id: "nashor-v2", width: 473, height: 473, entry: "nashor_pet_v2/gifs/nashor_idle.gif" },
  { id: "hoop-23", width: 314, height: 314, entry: "hoop-23-idle.gif" },
  { id: "kuro-blade", width: 220, height: 359, entry: "kuro-blade-idle.gif" },
  { id: "momo", width: 200, height: 206, entry: "momo-idle.gif" },
];

function solidSpriteBuffer(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 200;
    buf[i + 1] = 180;
    buf[i + 2] = 170;
    buf[i + 3] = 255;
  }
  return buf;
}

function countDiffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      diff += 1;
    }
  }
  return diff;
}

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

  it("全部 9 款素材库 GIF 宠物均生成差异化的紧闭忍痛（wince）与眩晕眼花（dizzy）双帧动态面部像素", () => {
    for (const item of ALL_CATALOG_SPRITES) {
      const original = solidSpriteBuffer(item.width, item.height);
      const wince0 = new Uint8ClampedArray(original);
      const wince1 = new Uint8ClampedArray(original);
      const dizzy0 = new Uint8ClampedArray(original);

      paintHurtSpritePixels(wince0, item.width, item.height, item.id, "wince", 0);
      paintHurtSpritePixels(wince1, item.width, item.height, item.id, "wince", 1);
      paintHurtSpritePixels(dizzy0, item.width, item.height, item.id, "dizzy", 0);

      expect(countDiffPixels(original, wince0)).toBeGreaterThan(20);
      expect(countDiffPixels(original, dizzy0)).toBeGreaterThan(20);
      expect(countDiffPixels(wince0, dizzy0)).toBeGreaterThan(10);
      expect(countDiffPixels(wince0, wince1)).toBeGreaterThan(2);
    }
  });

  it("按碰撞方向与速度轮换忍痛与眩晕模式", () => {
    expect(pickPetHurtMode("left", 500, 0)).toBe("wince");
    expect(pickPetHurtMode("left", 500, 2)).toBe("dizzy");
    expect(pickPetHurtMode("floor", 500, 0)).toBe("dizzy");
    expect(pickPetHurtMode("right", 1100, 0)).toBe("dizzy");
  });
});
