import { describe, expect, it } from "vitest";
import type { PetLayout, PetLayoutFrame } from "../types";
import { PET_WINDOW_PAD, feetInNormalWindow, petPlacement, placementForEntry } from "./petFrame";

const side = 204;
const pad = PET_WINDOW_PAD;

function layout(frames: PetLayoutFrame[], anchorX = 50, anchorY = 90): PetLayout {
  return { baseWidth: 100, baseHeight: 100, anchorX, anchorY, frames };
}

function frame(entry: string, width: number, height: number, anchorX: number, anchorY: number): PetLayoutFrame {
  return { entry, width, height, anchorX, anchorY };
}

describe("桌宠画布锚点", () => {
  it("画布和锚点都跟基准一样时，窗口仍是原来的方窗，图按 contain 铺满内框", () => {
    const gif = frame("idle.gif", 100, 100, 50, 90);
    const place = petPlacement(side, layout([gif]), gif);
    expect(place).toMatchObject({ width: side, height: side, shiftX: 0, shiftY: 0 });
    expect(place?.imageX).toBe(pad);
    expect(place?.imageY).toBe(pad);
    expect(place?.imageWidth).toBe(side - pad * 2);
    expect(place?.imageHeight).toBe(side - pad * 2);
  });

  it("没写这张图、或没有 pet.json 时不改老行为", () => {
    const pack = layout([frame("idle.gif", 100, 100, 50, 90)]);
    expect(placementForEntry(side, pack, "wave.gif")).toBeNull();
    expect(placementForEntry(side, null, "idle.gif")).toBeNull();
    expect(placementForEntry(side, pack, null)).toBeNull();
  });

  it("更大的画布按同一个比例画，窗口包住多出来的部分，脚还在原来的屏幕位置", () => {
    // 内框 200，基准 100，一像素对应 2 逻辑像素
    const idle = frame("idle.gif", 100, 100, 50, 90);
    const dunk = frame("dunk.gif", 200, 180, 60, 170);
    const pack = layout([idle, dunk]);
    const resting = petPlacement(side, pack, idle)!;
    const grown = petPlacement(side, pack, dunk)!;

    expect(grown.imageWidth / dunk.width).toBeCloseTo(resting.imageWidth / idle.width);
    expect(grown.imageHeight / dunk.height).toBeCloseTo(2);
    expect(grown.width).toBeGreaterThan(side);
    expect(grown.height).toBeGreaterThan(side);
    expect(grown.shiftX).toBeLessThanOrEqual(0);
    expect(grown.shiftY).toBeLessThanOrEqual(0);

    const feet = feetInNormalWindow(resting, idle);
    expect(feetInNormalWindow(grown, dunk)).toEqual(feet);
    // 窗口挪走之后，脚在屏幕上的位置不变
    expect(grown.shiftX + (feet.x - grown.shiftX)).toBeCloseTo(feet.x);
    expect(grown.shiftY + (feet.y - grown.shiftY)).toBeCloseTo(feet.y);

    // 图完整落在窗口里，平时的方窗也还在窗口里
    const imageLeft = grown.imageX - grown.shiftX;
    const imageTop = grown.imageY - grown.shiftY;
    expect(imageLeft).toBeGreaterThanOrEqual(0);
    expect(imageTop).toBeGreaterThanOrEqual(0);
    expect(imageLeft + grown.imageWidth).toBeLessThanOrEqual(grown.width);
    expect(imageTop + grown.imageHeight).toBeLessThanOrEqual(grown.height);
    expect(-grown.shiftX + side).toBeLessThanOrEqual(grown.width);
    expect(-grown.shiftY + side).toBeLessThanOrEqual(grown.height);
  });

  it("比基准小的画布不把窗口缩到方窗以下，人物比例不变", () => {
    const idle = frame("idle.gif", 100, 100, 50, 90);
    const crouch = frame("crouch.gif", 80, 70, 40, 60);
    const pack = layout([idle, crouch]);
    const resting = petPlacement(side, pack, idle)!;
    const shrunk = petPlacement(side, pack, crouch)!;
    expect(shrunk.width).toBe(side);
    expect(shrunk.height).toBe(side);
    expect(shrunk.shiftX).toBe(0);
    expect(shrunk.shiftY).toBe(0);
    expect(shrunk.imageWidth / crouch.width).toBeCloseTo(resting.imageWidth / idle.width);
    expect(feetInNormalWindow(shrunk, crouch)).toEqual(feetInNormalWindow(resting, idle));
  });

  it("竖长的基准画布在方窗里居中，和 contain 一样", () => {
    const gif = frame("idle.gif", 100, 200, 50, 190);
    const pack: PetLayout = { baseWidth: 100, baseHeight: 200, anchorX: 50, anchorY: 190, frames: [gif] };
    const place = petPlacement(side, pack, gif)!;
    const inner = side - pad * 2;
    expect(place.shiftX).toBe(0);
    expect(place.shiftY).toBe(0);
    expect(place.width).toBe(side);
    expect(place.height).toBe(side);
    expect(place.imageHeight).toBeCloseTo(inner);
    expect(place.imageWidth).toBeCloseTo(inner / 2);
    expect(place.imageX).toBeCloseTo(pad + (inner - place.imageWidth) / 2);
    expect(place.imageY).toBeCloseTo(pad);
  });

  it("镜像时脚的横坐标翻到画布另一边，脚在屏幕上不动", () => {
    const gif = frame("walk.gif", 100, 100, 30, 90);
    const pack = layout([gif], 30, 90);
    const plain = petPlacement(side, pack, gif, false)!;
    const flipped = petPlacement(side, pack, gif, true)!;
    expect(feetInNormalWindow(flipped, gif, true)).toEqual(feetInNormalWindow(plain, gif, false));
    expect(flipped.imageX).not.toBeCloseTo(plain.imageX);
  });

  it("扣篮这种又高又宽的画布：人的像素高度不变，窗口向上、向旁边长", () => {
    // 待机画布 314，脚在 (174.5, 303)；扣篮画布把篮筐包进来
    const idle = frame("idle.gif", 314, 314, 174.5, 303);
    const dunk = frame("drive-dunk.gif", 609, 530, 210.5, 519);
    const pack: PetLayout = { baseWidth: 314, baseHeight: 314, anchorX: 174.5, anchorY: 303, frames: [idle, dunk] };
    const windowSide = 600;
    const resting = petPlacement(windowSide, pack, idle)!;
    const grown = petPlacement(windowSide, pack, dunk)!;
    const scale = resting.imageHeight / idle.height;
    expect(grown.imageHeight / dunk.height).toBeCloseTo(scale);
    // 人在待机里高 292 像素源图时，屏幕高度不因扣篮画布变大而缩小
    expect(292 * scale).toBeGreaterThan(windowSide * 0.9);
    expect(grown.width).toBeGreaterThan(windowSide);
    expect(grown.height).toBeGreaterThan(windowSide);
    expect(grown.shiftX).toBeLessThan(0);
    expect(grown.shiftY).toBeLessThan(0);
    expect(feetInNormalWindow(grown, dunk).y).toBeCloseTo(feetInNormalWindow(resting, idle).y);
    expect(feetInNormalWindow(grown, dunk).x).toBeCloseTo(feetInNormalWindow(resting, idle).x);
  });
});
