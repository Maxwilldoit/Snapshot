import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotateWindow } from "./AnnotateWindow";
import { setupTauriMock, invokeArgs } from "../test/tauri";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** 原图 200×100，显示成 100×50：屏幕上 1px = 原图 2px */
async function editor() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let image = "data:image/png;base64,original";
  let saveResult: string | null = "已保存标注图";
  setupTauriMock((command, payload) => {
    calls.push({ command, args: invokeArgs(payload) });
    if (command === "get_annotate_image") return image;
    if (command === "annotate_get_title") return "历史截图";
    if (command === "annotate_save_copy") return "标注副本已保存到历史记录";
    if (command === "annotate_copy") return "已复制标注图，不会自动清空剪贴板";
    if (command === "annotate_save") return saveResult;
  }, { currentWindow: "annotate", shouldMockEvents: true });
  vi.stubGlobal("Image", class {
    naturalWidth = 200;
    naturalHeight = 100;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  // 逐帧绘制在测试里同步执行；减弱动效，免得动画帧一直排下去
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(performance.now()); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  const strokeStyles: string[] = [];
  const fillStyles: string[] = [];
  const lineWidths: number[] = [];
  // 每块「像素」用坐标编码，马赛克后应变成同一个值
  const getImageData = vi.fn((x: number, y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row += 1) for (let col = 0; col < w; col += 1) {
      const index = (row * w + col) * 4;
      data[index] = (col * 37 + row * 11) % 256;
      data[index + 1] = (col * 5) % 256;
      data[index + 2] = (row * 9) % 256;
      data[index + 3] = 255;
    }
    return { data, width: w, height: h, x, y };
  });
  const context = {
    setTransform: vi.fn(), translate: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
    getImageData, putImageData: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(),
    fillText: vi.fn(), strokeText: vi.fn(), setLineDash: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    set lineWidth(value: number) { lineWidths.push(value); },
    get lineWidth() { return lineWidths.at(-1) ?? 1; },
    lineCap: "butt", lineJoin: "miter", font: "", textAlign: "start", textBaseline: "alphabetic",
    globalAlpha: 1, globalCompositeOperation: "source-over", shadowColor: "", shadowBlur: 0, shadowOffsetY: 0,
    set strokeStyle(value: string) { strokeStyles.push(value); },
    get strokeStyle() { return strokeStyles.at(-1) ?? ""; },
    set fillStyle(value: string) { fillStyles.push(value); },
    get fillStyle() { return fillStyles.at(-1) ?? ""; },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,edited");
  render(<AnnotateWindow />);
  await waitFor(() => expect(button("箭头").disabled).toBe(false));
  const canvas = screen.getByLabelText("截图标注画布") as HTMLCanvasElement;
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50 } as DOMRect);
  /** 屏幕坐标画一笔 */
  const drag = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
    fireEvent.pointerDown(canvas, { button: 0, clientX: from[0], clientY: from[1], ...init });
    fireEvent.pointerMove(canvas, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, ...init });
    fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], ...init });
    fireEvent.pointerUp(canvas);
  };
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, clientX: x, clientY: y });
    fireEvent.pointerUp(canvas);
  };
  // 一帧从 clearRect 开始（马赛克会在中途 drawImage 贴回小画布，不能用它来分帧）
  /** 最近一帧里画的第一个矩形（之后那个虚线框是选中框） */
  const shapeRect = () => {
    const frame = Math.max(...context.clearRect.mock.invocationCallOrder);
    const index = context.strokeRect.mock.invocationCallOrder.findIndex((order) => order > frame);
    return index < 0 ? undefined : context.strokeRect.mock.calls[index];
  };
  const frameRects = () => {
    const frame = Math.max(...context.clearRect.mock.invocationCallOrder);
    return context.strokeRect.mock.calls.filter((_, index) => context.strokeRect.mock.invocationCallOrder[index] > frame);
  };
  /** 最近一帧里画出的文字 */
  const frameTexts = () => {
    const frame = Math.max(...context.clearRect.mock.invocationCallOrder);
    return context.fillText.mock.calls.filter((_, index) => context.fillText.mock.invocationCallOrder[index] > frame).map((call) => call[0]);
  };
  return { calls, context, canvas, drag, click, strokeStyles, lineWidths, shapeRect, frameRects, frameTexts, setImage: (value: string) => { image = value; }, cancelSave: () => { saveResult = null; } };
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
const pressed = (name: string) => button(name).getAttribute("aria-pressed") === "true";

describe("截图标注：工具", () => {
  it("默认是箭头；单键切换工具，按原图坐标画，⇧ 画正方形", async () => {
    const { context, drag, shapeRect, frameRects } = await editor();
    expect(pressed("箭头")).toBe(true);
    drag([10, 5], [30, 20]);
    expect(context.moveTo).toHaveBeenCalledWith(20, 10);
    expect(context.moveTo).toHaveBeenCalledWith(60, 40);

    key({ key: "r" });
    expect(pressed("矩形")).toBe(true);
    drag([10, 30], [30, 40]);
    expect(shapeRect()).toEqual([20, 60, 40, 20]);
    drag([60, 5], [80, 10], { shiftKey: true });
    expect(frameRects()).toContainEqual([120, 10, 40, 40]);

    for (const [letter, label] of [["o", "椭圆"], ["p", "画笔"], ["h", "荧光笔"], ["t", "文字"], ["n", "编号"], ["v", "选择"], ["a", "箭头"]]) {
      key({ key: letter });
      expect(pressed(label)).toBe(true);
    }
    // 马赛克不再是单独的工具
    expect(screen.queryByRole("button", { name: "马赛克" })).toBeNull();
    key({ key: "m" });
    expect(pressed("箭头")).toBe(true);
  });

  it("数字键 1–8 按工具栏从左到右切换，提示里写着数字和字母", async () => {
    await editor();
    const order = ["选择", "箭头", "矩形", "椭圆", "画笔", "荧光笔", "文字", "编号"];
    const shown = Array.from(screen.getByRole("group", { name: "标注工具" }).querySelectorAll("button")).map((item) => item.getAttribute("aria-label"));
    expect(shown).toEqual(order);
    order.forEach((label, index) => {
      key({ key: String(index + 1), code: `Digit${index + 1}` });
      expect(pressed(label)).toBe(true);
    });
    // 小键盘、以及 AZERTY 这种数字行不按 ⇧ 出符号的键盘，按物理键位认
    key({ key: "3", code: "Numpad3" });
    expect(pressed("矩形")).toBe(true);
    key({ key: "\"", code: "Digit2" });
    expect(pressed("箭头")).toBe(true);
    key({ key: "9", code: "Digit9" });
    expect(pressed("箭头")).toBe(true);
    expect(button("箭头").title).toBe("箭头  2 / A");
    expect(button("编号").title).toBe("编号  8 / N");
  });

  it("编号点一下放一个，自动 1、2、3", async () => {
    const { context, click } = await editor();
    key({ key: "n" });
    click(10, 10);
    click(40, 10);
    click(70, 10);
    const numbers = context.fillText.mock.calls.map((call) => call[0]);
    expect(numbers).toEqual(expect.arrayContaining(["1", "2", "3"]));
    expect(context.arc).toHaveBeenCalledWith(140, 20, expect.any(Number), 0, Math.PI * 2);
  });

  it("文字：点一下就地输入，回车落成对象，双击再改", async () => {
    const { context, click, canvas, frameTexts } = await editor();
    key({ key: "t" });
    click(20, 20);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "登录按钮" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(context.fillText).toHaveBeenCalledWith("登录按钮", 40, expect.any(Number));
    expect(context.strokeText).toHaveBeenCalledWith("登录按钮", 40, expect.any(Number));

    key({ key: "v" });
    fireEvent.doubleClick(canvas, { clientX: 22, clientY: 20 });
    const again = await screen.findByRole("textbox") as HTMLTextAreaElement;
    expect(again.value).toBe("登录按钮");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(frameTexts()).not.toContain("登录按钮");
  });

  it("打字时键盘归输入框：单键、Delete、⌘Z 不碰画布；Esc 收起并保留文字", async () => {
    const { click, frameTexts } = await editor();
    key({ key: "t" });
    click(20, 20);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Ready" } });
    for (const init of [{ key: "r" }, { key: "a" }, { key: "1", code: "Digit1" }, { key: "3", code: "Digit3" }, { key: "Delete" }, { key: "Backspace" }, { key: "ArrowLeft" }, { key: "z", metaKey: true, ctrlKey: true }]) {
      fireEvent.keyDown(input, init);
    }
    expect(pressed("文字")).toBe(true);
    expect(screen.getByRole("textbox")).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(frameTexts()).toContain("Ready");
  });

  it("马赛克是颜色里的一格：矩形打码整块，真的改写原图像素，导出按原图分辨率", async () => {
    const { context, drag, calls } = await editor();
    key({ key: "r" });
    fireEvent.click(button("颜色和粗细"));
    fireEvent.click(screen.getByRole("radio", { name: "马赛克" }));
    expect(screen.getByRole("radio", { name: "马赛克" }).getAttribute("aria-checked")).toBe("true");
    context.strokeRect.mockClear();
    drag([10, 5], [30, 20]);
    expect(context.strokeRect).not.toHaveBeenCalled();
    const lastPut = () => context.putImageData.mock.calls.at(-1)!;
    const [region, x, y] = lastPut();
    expect([x, y, region.width, region.height]).toEqual([20, 10, 40, 30]);
    // 默认粗细 4 → 10px 一块：同一块里每个像素都一样，相邻块不同
    const pixel = (px: number, py: number) => Array.from(region.data.slice((py * region.width + px) * 4, (py * region.width + px) * 4 + 4));
    expect(pixel(0, 0)).toEqual(pixel(9, 9));
    expect(pixel(0, 0)).not.toEqual(pixel(10, 0));
    expect(pixel(0, 0)).not.toEqual(pixel(0, 10));

    const before = context.putImageData.mock.calls.length;
    fireEvent.click(button("复制"));
    await waitFor(() => expect(calls).toContainEqual({ command: "annotate_copy", args: { imageData: "data:image/png;base64,edited" } }));
    // 导出时重画了一遍：同一块原图像素区域又被打码，坐标仍是原图像素
    const exported = context.putImageData.mock.calls.slice(before);
    expect(exported.map((call) => [call[1], call[2], call[0].width, call[0].height])).toContainEqual([20, 10, 40, 30]);
  });

  it("马赛克画笔沿笔迹打码；箭头、文字、编号用不了马赛克，照旧用上一次的颜色", async () => {
    const { context, drag, strokeStyles } = await editor();
    key({ key: "p" });
    fireEvent.click(button("颜色和粗细"));
    fireEvent.click(screen.getByRole("radio", { name: "蓝色" }));
    fireEvent.click(screen.getByRole("radio", { name: "马赛克" }));
    context.getImageData.mockClear();
    context.drawImage.mockClear();
    strokeStyles.length = 0;
    drag([10, 10], [40, 10]);
    // 按笔迹的外框取像素（格子对齐整张图），在小画布上只留笔迹那一条再贴回去
    expect(context.getImageData).toHaveBeenCalledWith(10, 10, 80, 20);
    expect(context.drawImage.mock.calls.some((call) => call[0] instanceof HTMLCanvasElement)).toBe(true);
    expect(strokeStyles).not.toContain("mosaic");

    key({ key: "a" });
    fireEvent.click(button("颜色和粗细"));
    const swatch = screen.getByRole("radio", { name: "马赛克" });
    expect(swatch.getAttribute("aria-disabled")).toBe("true");
    expect(swatch.title).toBe("马赛克只能用于矩形、椭圆、画笔和荧光笔");
    expect(screen.getByRole("radio", { name: "蓝色" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(swatch);
    strokeStyles.length = 0;
    drag([10, 30], [40, 40]);
    expect(strokeStyles).toContain("#007aff");
    // 回到画笔，马赛克还在
    key({ key: "p" });
    fireEvent.click(button("颜色和粗细"));
    expect(screen.getByRole("radio", { name: "马赛克" }).getAttribute("aria-checked")).toBe("true");
  });

  it("选中的方框可以直接改成马赛克，撤销回到原来的颜色", async () => {
    const { context, drag, click, shapeRect } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    click(20, 5);
    fireEvent.click(button("颜色和粗细"));
    const puts = context.putImageData.mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: "马赛克" }));
    expect(context.putImageData.mock.calls.length).toBeGreaterThan(puts);
    expect(context.putImageData.mock.calls.at(-1)!.slice(1, 3)).toEqual([20, 10]);
    key({ key: "Escape" });
    fireEvent.click(button("撤销"));
    expect(shapeRect()).toEqual([20, 10, 40, 30]);
  });
});

describe("截图标注：对象编辑", () => {
  it("点中对象拖动，撤销/重做都回得去", async () => {
    const { drag, shapeRect } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    expect(shapeRect()).toEqual([20, 10, 40, 30]);
    // 点上边线中间（不是角上的把手）拖 5px
    key({ key: "v" });
    drag([20, 5], [25, 10]);
    expect(shapeRect()).toEqual([30, 20, 40, 30]);
    fireEvent.click(button("撤销"));
    expect(shapeRect()).toEqual([20, 10, 40, 30]);
    key({ key: "Z", metaKey: true, ctrlKey: true, shiftKey: true });
    expect(shapeRect()).toEqual([30, 20, 40, 30]);
  });

  it("画图工具悬停不提示（按下就是画）；选择工具悬停有细框，移开或换工具就消失", async () => {
    const { drag, canvas, strokeStyles } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    strokeStyles.length = 0;
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 5 });
    expect(strokeStyles).not.toContain("rgba(0, 122, 255, 0.55)");
    expect(canvas.style.cursor).toBe("crosshair");
    key({ key: "v" });
    strokeStyles.length = 0;
    fireEvent.pointerMove(canvas, { clientX: 21, clientY: 5 });
    expect(strokeStyles).toContain("rgba(0, 122, 255, 0.55)");
    expect(canvas.style.cursor).toBe("move");
    strokeStyles.length = 0;
    fireEvent.pointerLeave(canvas);
    expect(strokeStyles).not.toContain("rgba(0, 122, 255, 0.55)");
    // 悬停着直接按键换成画图工具，细框也跟着消失
    fireEvent.pointerMove(canvas, { clientX: 21, clientY: 5 });
    strokeStyles.length = 0;
    key({ key: "t" });
    expect(strokeStyles.length).toBeGreaterThan(0);
    expect(strokeStyles).not.toContain("rgba(0, 122, 255, 0.55)");
  });

  it("误点、拖到一半按 Esc 都不留下对象，也不会关窗", async () => {
    const { drag, canvas, calls } = await editor();
    drag([10, 5], [11, 6]);
    expect(button("撤销").disabled).toBe(true);
    key({ key: "r" });
    drag([10, 5], [40, 6]); // 一条 1px 的细缝
    expect(button("撤销").disabled).toBe(true);
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
    key({ key: "Escape" });
    fireEvent.pointerUp(canvas);
    expect(button("撤销").disabled).toBe(true);
    expect(calls.some((call) => call.command === "annotate_close")).toBe(false);
    expect(fireEvent.contextMenu(canvas)).toBe(false);
  });

  it("拖 = 画：起点压在别的标注上也画新的，不会把它拖走", async () => {
    const { drag, frameRects, context } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    drag([20, 5], [40, 15]); // 从上一个方框的上边线起笔
    expect(frameRects()).toEqual(expect.arrayContaining([[20, 10, 40, 30], [40, 10, 40, 20]]));
    key({ key: "a" });
    drag([50, 30], [70, 40]);
    context.moveTo.mockClear();
    drag([70, 40], [90, 30]); // 从上一支箭头的尖端再拉一支
    expect(context.moveTo).toHaveBeenCalledWith(100, 60);
    expect(context.moveTo).toHaveBeenCalledWith(140, 80);
  });

  it("点 = 选：点一下选中，选中后才能拖把手改大小", async () => {
    const { drag, click, shapeRect } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    click(20, 5);
    drag([30, 20], [40, 25]);
    expect(shapeRect()).toEqual([20, 10, 60, 40]);
  });

  it("画完不留选中，颜色只管下一笔；点选后再改才改到那个标注上", async () => {
    const { drag, click, strokeStyles, lineWidths } = await editor();
    drag([10, 5], [30, 20]);
    fireEvent.click(button("颜色和粗细"));
    fireEvent.click(screen.getByRole("radio", { name: "黄色" }));
    expect(strokeStyles.at(-1)).not.toBe("#ffcc00");
    fireEvent.click(button("颜色和粗细"));
    click(20, 12.5);
    fireEvent.click(button("颜色和粗细"));
    fireEvent.click(screen.getByRole("radio", { name: "绿色" }));
    expect(strokeStyles).toContain("#34c759");
    lineWidths.length = 0;
    fireEvent.change(screen.getByRole("slider", { name: "粗细" }), { target: { value: "7" } });
    expect(lineWidths).toContain(7);
    key({ key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "颜色和粗细" })).toBeNull());
    const before = strokeStyles.length;
    key({ key: "Escape" });
    key({ key: "r" });
    drag([60, 5], [80, 20]);
    expect(strokeStyles.slice(before)).toContain("#34c759");
  });

  it("粗细是一条线性滑杆：拖一次只占一步撤销，字号跟着变，下次打开还是这个粗细", async () => {
    const { drag, click, lineWidths } = await editor();
    drag([10, 5], [30, 20]);
    click(20, 12.5);
    fireEvent.click(button("颜色和粗细"));
    const slider = screen.getByRole("slider", { name: "粗细" }) as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(["1", "12", "4"]);
    fireEvent.change(slider, { target: { value: "6" } });
    fireEvent.change(slider, { target: { value: "9" } });
    fireEvent.pointerUp(slider);
    expect(lineWidths).toContain(9);
    lineWidths.length = 0;
    fireEvent.click(button("撤销"));
    expect(lineWidths).toContain(4);
    expect(lineWidths).not.toContain(9);
    fireEvent.click(button("撤销"));
    expect(button("撤销").disabled).toBe(true);

    // 文字的字号也按同一个粗细线性换算（屏幕上 1px = 原图 2px）
    key({ key: "t" });
    click(20, 20);
    const input = await screen.findByRole("textbox") as HTMLTextAreaElement;
    expect(input.style.font).toContain("17.5px");
    fireEvent.keyDown(input, { key: "Escape" });

    cleanup();
    await editor();
    fireEvent.click(button("颜色和粗细"));
    expect((screen.getByRole("slider", { name: "粗细" }) as HTMLInputElement).value).toBe("9");
  });

  it("Delete 只删点选的那个，能撤销；新的一笔让重做失效；没有一键清空", async () => {
    const { drag, click, context } = await editor();
    expect(screen.queryByRole("button", { name: "清空标注" })).toBeNull();
    expect(button("撤销").disabled).toBe(true);
    drag([10, 5], [30, 20]);
    key({ key: "Delete" }); // 画完没选中：什么都不删
    expect(button("重做").disabled).toBe(true);
    click(20, 12.5);
    context.moveTo.mockClear();
    key({ key: "Delete" });
    expect(context.moveTo).not.toHaveBeenCalledWith(20, 10);
    fireEvent.click(button("撤销"));
    expect(context.moveTo).toHaveBeenCalledWith(20, 10);
    expect(button("重做").disabled).toBe(false);
    drag([60, 5], [80, 20]);
    expect(button("重做").disabled).toBe(true);
  });
});

describe("截图标注：快捷键与出口", () => {
  it("⌘C 复制、⌘S 存入截图记录、⇧⌘S 另存为；回车不复制；成功后按钮打勾，停一下再收起窗口", async () => {
    const { drag, calls } = await editor();
    const count = (command: string) => calls.filter((call) => call.command === command).length;
    const reopen = async () => {
      await act(async () => { await emit("annotate-ready"); });
      await waitFor(() => expect(button("箭头").disabled).toBe(false));
    };
    drag([10, 5], [30, 20]);
    key({ key: "Enter" }); // 画完顺手按回车：不复制、不收窗
    expect(count("annotate_copy")).toBe(0);
    key({ key: "c", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(count("annotate_copy")).toBe(1));
    expect(await screen.findByText("已复制")).toBeTruthy();
    expect(await screen.findByText("已复制标注图，不会自动清空剪贴板")).toBeTruthy();
    // 确认期间不重复导出，也还没收起
    key({ key: "c", metaKey: true, ctrlKey: true });
    expect(count("annotate_copy")).toBe(1);
    expect(count("annotate_close")).toBe(0);
    await waitFor(() => expect(count("annotate_close")).toBe(1));

    await reopen();
    expect(button("复制").textContent).toBe("复制");
    fireEvent.click(button("复制"));
    await waitFor(() => expect(count("annotate_copy")).toBe(2));
    await reopen();
    key({ key: "s", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(count("annotate_save_copy")).toBe(1));
    await reopen();
    key({ key: "S", metaKey: true, ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(count("annotate_save")).toBe(1));
  });

  it("另存为取消：不收起窗口，标注都还在，可以接着改", async () => {
    const { drag, calls, cancelSave } = await editor();
    cancelSave();
    drag([10, 5], [30, 20]);
    fireEvent.click(button("另存为…"));
    expect(await screen.findByText("已取消另存，标注仍保留")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(calls.some((call) => call.command === "annotate_close")).toBe(false);
    expect(button("撤销").disabled).toBe(false);
    expect(button("复制").disabled).toBe(false);
  });

  it("Esc：先取消选中；没画过直接关闭；画过要再按一次", async () => {
    const { drag, click, calls } = await editor();
    key({ key: "Escape" });
    await waitFor(() => expect(calls.filter((call) => call.command === "annotate_close")).toHaveLength(1));
    drag([10, 5], [30, 20]);
    click(20, 12.5);
    key({ key: "Escape" });
    expect(calls.filter((call) => call.command === "annotate_close")).toHaveLength(1);
    key({ key: "Escape" });
    expect(await screen.findByText("再按一次 Esc 放弃标注并关闭")).toBeTruthy();
    expect(calls.filter((call) => call.command === "annotate_close")).toHaveLength(1);
    key({ key: "Escape" });
    await waitFor(() => expect(calls.filter((call) => call.command === "annotate_close")).toHaveLength(2));
  });

  it("工具栏不重复「关闭」；再次打开时清掉旧标注和撤销记录", async () => {
    const { drag } = await editor();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(button("复制").className).toContain("is-primary");
    drag([10, 5], [30, 20]);
    await act(async () => { await emit("annotate-ready"); });
    await waitFor(() => expect(button("箭头").disabled).toBe(false));
    expect(button("撤销").disabled).toBe(true);
  });

  it("无图片时禁止导出，避免保存空白或上一张图片", async () => {
    const { setImage, calls } = await editor();
    setImage("");
    await act(async () => { await emit("annotate-ready"); });
    expect(button("存入截图记录").disabled).toBe(true);
    expect(button("复制").disabled).toBe(true);
    expect(screen.getByText("没有待标注的截图")).toBeTruthy();
    key({ key: "c", metaKey: true, ctrlKey: true });
    expect(calls.some((call) => call.command === "annotate_copy")).toBe(false);
  });
});
