import { beforeEach, describe, expect, it } from "vitest";
import type { PetAsset } from "../types";
import {
  cachePetMediaShape,
  loadPetMediaShapes,
  mediaShapeKey,
} from "./petMediaShapeCache";

const asset: PetAsset = {
  id: "pet-cache",
  name: "cache",
  path: "/tmp/cache.zip",
  entry: "idle.gif",
  animations: ["idle.gif", "wave.webm"],
  sizeBytes: 123,
  importedAt: 456,
  actionBounds: {
    "idle.gif": {
      width: 100,
      height: 200,
      bounds: { left: .1, top: .2, width: .5, height: .7 },
    },
  },
};

beforeEach(() => localStorage.clear());

describe("pet complete media shapes", () => {
  it("seeds import-time GIF envelopes and keeps them ahead of old playback caches", () => {
    cachePetMediaShape(asset, "idle.gif", {
      width: 100,
      height: 200,
      bounds: { left: 0, top: 0, width: 1, height: 1 },
    });
    const shapes = loadPetMediaShapes(asset);
    expect(shapes.get(mediaShapeKey(asset.id, "idle.gif"))?.bounds)
      .toEqual({ left: .1, top: .2, width: .5, height: .7 });
  });

  it("restores a completed WebM envelope for the same imported revision", () => {
    const shape = {
      width: 640,
      height: 360,
      bounds: { left: .05, top: .1, width: .8, height: .75 },
    };
    cachePetMediaShape(asset, "wave.webm", shape);
    expect(loadPetMediaShapes(asset).get(mediaShapeKey(asset.id, "wave.webm"))).toEqual(shape);
    expect(loadPetMediaShapes({ ...asset, importedAt: 789 }).has(mediaShapeKey(asset.id, "wave.webm"))).toBe(false);
  });

  it("ignores corrupt localStorage records", () => {
    localStorage.setItem(`snapshot-pet-media-shapes:${asset.id}`, "{broken");
    expect(loadPetMediaShapes(asset).size).toBe(1);
  });
});
