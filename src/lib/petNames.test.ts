import { describe, expect, it } from "vitest";
import { entryLabel } from "./petNames";

describe("pet action labels", () => {
  it.each([
    ["makima_pixel/gifs/makima_idle.gif", "待机"],
    ["makima_pixel/gifs/makima_jump.gif", "跳跃"],
    ["makima_pixel/gifs/makima_peek.gif", "探头"],
    ["makima_pixel/gifs/makima_think.gif", "思考"],
    ["makima_pixel/gifs/makima_walk_left.gif", "向左走"],
    ["makima_pixel/gifs/makima_walk_right.gif", "向右走"],
    ["makima_pixel/gifs/makima_wave.gif", "招手"],
    ["feedback/failure.gif", "失败"],
    ["feedback/paused.gif", "已暂停"],
    ["feedback/recording.gif", "录制中"],
    ["feedback/success.gif", "成功"],
  ])("translates %s", (entry, expected) => {
    expect(entryLabel(entry)).toBe(expected);
  });

  it("keeps an unknown action name rather than inventing a translation", () => {
    expect(entryLabel("custom/unique-action.gif")).toBe("unique-action");
  });
});
