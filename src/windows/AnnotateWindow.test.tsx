import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotateWindow } from "./AnnotateWindow";
import { setupTauriMock, invokeArgs } from "../test/tauri";

afterEach(() => vi.unstubAllGlobals());

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
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
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
  /** 最近一帧里画的第一个矩形（之后那个虚线框是选中框） */
  const shapeRect = () => {
    const frame = Math.max(...context.drawImage.mock.invocationCallOrder);
    const index = context.strokeRect.mock.invocationCallOrder.findIndex((order) => order > frame);
    return index < 0 ? undefined : context.strokeRect.mock.calls[index];
  };
  const frameRects = () => {
    const frame = Math.max(...context.drawImage.mock.invocationCallOrder);
    return context.strokeRect.mock.calls.filter((_, index) => context.strokeRect.mock.invocationCallOrder[index] > frame);
  };
  return { calls, context, canvas, drag, click, strokeStyles, lineWidths, shapeRect, frameRects, setImage: (value: string) => { image = value; }, cancelSave: () => { saveResult = null; } };
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

    for (const [letter, label] of [["o", "椭圆"], ["p", "画笔"], ["h", "荧光笔"], ["t", "文字"], ["n", "编号"], ["m", "马赛克"], ["v", "选择"], ["a", "箭头"]]) {
      key({ key: letter });
      expect(pressed(label)).toBe(true);
    }
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
    const { context, click, canvas } = await editor();
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
    expect(button("清空标注").disabled).toBe(true);
  });

  it("马赛克真的改写原图像素，导出按原图分辨率", async () => {
    const { context, drag, calls } = await editor();
    key({ key: "m" });
    drag([10, 5], [30, 20]);
    const lastPut = () => context.putImageData.mock.calls.at(-1)!;
    const [region, x, y] = lastPut();
    expect([x, y, region.width, region.height]).toEqual([20, 10, 40, 30]);
    // 中号 10px 一块：同一块里每个像素都一样，相邻块不同
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

  it("鼠标移到对象上有细框提示点得中；移开就消失", async () => {
    const { drag, canvas, strokeStyles } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    key({ key: "Escape" });
    strokeStyles.length = 0;
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 5 });
    expect(strokeStyles).toContain("rgba(0, 122, 255, 0.55)");
    expect(canvas.style.cursor).toBe("move");
    strokeStyles.length = 0;
    fireEvent.pointerLeave(canvas);
    expect(strokeStyles).not.toContain("rgba(0, 122, 255, 0.55)");
  });

  it("误点、拖到一半按 Esc 都不留下对象，也不会关窗", async () => {
    const { drag, canvas, calls } = await editor();
    drag([10, 5], [11, 6]);
    expect(button("清空标注").disabled).toBe(true);
    key({ key: "r" });
    drag([10, 5], [40, 6]); // 一条 1px 的细缝
    expect(button("清空标注").disabled).toBe(true);
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
    key({ key: "Escape" });
    fireEvent.pointerUp(canvas);
    expect(button("清空标注").disabled).toBe(true);
    expect(calls.some((call) => call.command === "annotate_close")).toBe(false);
    expect(fireEvent.contextMenu(canvas)).toBe(false);
  });

  it("拖角上的把手改大小", async () => {
    const { drag, shapeRect } = await editor();
    key({ key: "r" });
    drag([10, 5], [30, 20]);
    drag([30, 20], [40, 25]);
    expect(shapeRect()).toEqual([20, 10, 60, 40]);
  });

  it("颜色和粗细改到选中的对象上，也用于下一笔", async () => {
    const { drag, strokeStyles, lineWidths } = await editor();
    drag([10, 5], [30, 20]);
    fireEvent.click(button("颜色和粗细"));
    fireEvent.click(screen.getByRole("radio", { name: "绿色" }));
    expect(strokeStyles).toContain("#34c759");
    lineWidths.length = 0;
    fireEvent.click(screen.getByRole("radio", { name: "粗" }));
    expect(lineWidths).toContain(7);
    key({ key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "颜色和粗细" })).toBeNull());
    const before = strokeStyles.length;
    key({ key: "Escape" });
    key({ key: "r" });
    drag([60, 5], [80, 20]);
    expect(strokeStyles.slice(before)).toContain("#34c759");
  });

  it("Delete 删除选中的；清空也能撤销回来，新的一笔让重做失效", async () => {
    const { drag } = await editor();
    expect(button("撤销").disabled).toBe(true);
    expect(button("清空标注").disabled).toBe(true);
    drag([10, 5], [30, 20]);
    key({ key: "Delete" });
    expect(button("清空标注").disabled).toBe(true);
    fireEvent.click(button("撤销"));
    expect(button("清空标注").disabled).toBe(false);
    fireEvent.click(button("清空标注"));
    expect(button("清空标注").disabled).toBe(true);
    fireEvent.click(button("撤销"));
    expect(button("清空标注").disabled).toBe(false);
    expect(button("重做").disabled).toBe(false);
    drag([60, 5], [80, 20]);
    expect(button("重做").disabled).toBe(true);
  });
});

describe("截图标注：快捷键与出口", () => {
  it("⌘C / 回车复制、⌘S 存入截图记录、⇧⌘S 另存为；成功后按钮打勾，停一下再收起窗口", async () => {
    const { drag, calls } = await editor();
    const count = (command: string) => calls.filter((call) => call.command === command).length;
    const reopen = async () => {
      await act(async () => { await emit("annotate-ready"); });
      await waitFor(() => expect(button("箭头").disabled).toBe(false));
    };
    drag([10, 5], [30, 20]);
    key({ key: "Escape" }); // 先取消选中
    key({ key: "c", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(count("annotate_copy")).toBe(1));
    expect(await screen.findByText("已复制")).toBeTruthy();
    expect(await screen.findByText("已复制标注图，不会自动清空剪贴板")).toBeTruthy();
    // 确认期间不重复导出，也还没收起
    key({ key: "Enter" });
    expect(count("annotate_copy")).toBe(1);
    expect(count("annotate_close")).toBe(0);
    await waitFor(() => expect(count("annotate_close")).toBe(1));

    await reopen();
    expect(button("复制").textContent).toBe("复制");
    key({ key: "Enter" });
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
    expect(button("清空标注").disabled).toBe(false);
    expect(button("复制").disabled).toBe(false);
  });

  it("Esc：先取消选中；没画过直接关闭；画过要再按一次", async () => {
    const { drag, calls } = await editor();
    key({ key: "Escape" });
    await waitFor(() => expect(calls.filter((call) => call.command === "annotate_close")).toHaveLength(1));
    drag([10, 5], [30, 20]);
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
    expect(button("清空标注").disabled).toBe(true);
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
