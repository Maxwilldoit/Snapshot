import { describe, expect, it } from "vitest";
import type { PetLayout, PetLayoutFrame } from "../types";
import { PET_WINDOW_PAD, coverPetPlacements, cropPetPlacement, feetInNormalWindow, groundForEntry, mediaPlacement, petPlacement, placementForEntry } from "./petFrame";

const side = 204;
const pad = PET_WINDOW_PAD;

function layout(frames: PetLayoutFrame[], anchorX = 50, anchorY = 90): PetLayout {
  return { baseWidth: 100, baseHeight: 100, anchorX, anchorY, frames };
}

function frame(entry: string, width: number, height: number, anchorX: number, anchorY: number): PetLayoutFrame {
  return { entry, width, height, anchorX, anchorY };
}

describe("桌宠画布锚点", () => {
  it("640×360 素材的脚底不在方窗下沿，扩展动作仍保持同一个屏幕脚底", () => {
    const idle = frame("idle.webm", 640, 360, 320, 330);
    const jump = frame("jump.webm", 640, 800, 320, 770);
    const pack = { baseWidth: 640, baseHeight: 360, anchorX: 320, anchorY: 330, frames: [idle, jump] };
    expect(groundForEntry(268, pack, idle.entry)).toBeCloseTo(195.875);
    const grown = petPlacement(268, pack, jump)!;
    expect(groundForEntry(268, pack, jump.entry)! + grown.shiftY).toBeCloseTo(195.875);
    expect(groundForEntry(268, pack, idle.entry, true)).toBeCloseTo(195.875);
    expect(groundForEntry(268, null, idle.entry)).toBeNull();
    expect(groundForEntry(268, pack, "missing.gif")).toBeNull();
  });

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

describe("桌宠紧致窗口", () => {
  it("没有作者布局的宽图仍保持原大小、底部对齐，只收紧窗口", () => {
    const normal = mediaPlacement(204, 400, 200)!;
    expect(normal).toMatchObject({ imageX: 2, imageY: 102, imageWidth: 200, imageHeight: 100 });
    expect(cropPetPlacement(normal)).toEqual({ ...normal, shiftY: 100, height: 104 });
  });

  it("按 alpha 外框裁去透明边，四周只留 4px，不更改素材比例", () => {
    const normal = mediaPlacement(204, 100, 100)!;
    const cropped = cropPetPlacement(normal, { left: .2, top: .1, width: .5, height: .7 });
    expect(cropped).toEqual({ ...normal, shiftX: 38, shiftY: 18, width: 108, height: 148 });
    expect(cropped.imageX + .2 * cropped.imageWidth - cropped.shiftX).toBe(4);
    expect(cropped.imageY + .1 * cropped.imageHeight - cropped.shiftY).toBe(4);
  });

  it("镜像时翻转 alpha 外框，不翻转纵向位置或缩放比例", () => {
    const normal = mediaPlacement(204, 100, 100)!;
    const bounds = { left: .1, top: .2, width: .3, height: .5 };
    const plain = cropPetPlacement(normal, bounds);
    const flipped = cropPetPlacement(normal, bounds, true);
    expect(flipped.shiftX).toBe(118);
    expect(flipped.shiftY).toBe(plain.shiftY);
    expect(flipped.width).toBe(plain.width);
    expect(flipped.height).toBe(plain.height);
    expect(flipped.imageWidth).toBe(normal.imageWidth);
  });

  it.each([
    { left: -1, top: 0, width: 1, height: 1 },
    { left: 0, top: NaN, width: 1, height: 1 },
    { left: .5, top: 0, width: 1, height: 1 },
    { left: 0, top: 0, width: 0, height: 1 },
  ])("无效 alpha 外框 %j 保守包住整张素材", (bounds) => {
    const normal = mediaPlacement(204, 100, 200)!;
    expect(cropPetPlacement(normal, bounds)).toEqual(cropPetPlacement(normal));
  });

  it("叠化时覆盖两个动作，结束后恢复当前动作的紧致外框", () => {
    const current = cropPetPlacement(mediaPlacement(204, 100, 100)!, { left: .2, top: .1, width: .5, height: .7 });
    const previous = { ...current, shiftX: -22, shiftY: -82, width: 250, height: 260 };
    expect(coverPetPlacements(current, previous)).toEqual({ ...current, shiftX: -22, shiftY: -82, width: 250, height: 260 });
    expect(coverPetPlacements(current, null)).toBe(current);
  });

  it.each([[0, 100, 100], [204, 0, 100], [204, 100, Infinity], [NaN, 100, 100]])(
    "无效媒体尺寸 %j 不生成窗口几何", (side, width, height) => {
      expect(mediaPlacement(side, width, height)).toBeNull();
    },
  );
});
