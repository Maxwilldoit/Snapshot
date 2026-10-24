import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotateWindow } from "./AnnotateWindow";
import { setupTauriMock, invokeArgs } from "../test/tauri";

afterEach(() => vi.unstubAllGlobals());

async function editor() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let image = "data:image/png;base64,original";
  setupTauriMock((command, payload) => {
    calls.push({ command, args: invokeArgs(payload) });
    if (command === "get_annotate_image") return image;
    if (command === "annotate_get_title") return "历史截图";
    if (command === "annotate_save_copy") return "标注副本已保存到历史记录";
  }, { currentWindow: "annotate", shouldMockEvents: true });
  vi.stubGlobal("Image", class {
    naturalWidth = 200;
    naturalHeight = 100;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const context = {
    drawImage: vi.fn(), clearRect: vi.fn(), putImageData: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(200 * 100 * 4) })),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,edited");
  render(<AnnotateWindow />);
  await waitFor(() => expect((screen.getByRole("button", { name: "画笔" }) as HTMLButtonElement).disabled).toBe(false));
  const canvas = screen.getByLabelText("截图标注画布") as HTMLCanvasElement;
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50 } as DOMRect);
  const draw = () => {
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(canvas, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(canvas);
  };
  return { calls, context, draw, setImage: (value: string) => { image = value; } };
}

describe("截图标注", () => {
  it("按原图坐标画笔和矩形，支持撤销、清空", async () => {
    const { context, draw } = await editor();
    draw();
    expect(context.moveTo).toHaveBeenCalledWith(20, 10);
    expect(context.lineTo).toHaveBeenCalledWith(60, 40);
    const first = context.getImageData.mock.results[0].value;
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(context.putImageData).toHaveBeenLastCalledWith(first, 0, 0);
    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
    draw();
    expect(context.strokeRect).toHaveBeenCalledWith(20, 10, 40, 30);
    fireEvent.click(screen.getByRole("button", { name: "清空标注" }));
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存副本传递编辑后的 PNG；再次打开时清除旧撤销记录", async () => {
    const { draw, calls } = await editor();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "保存副本" }));
    await waitFor(() => expect(calls).toContainEqual({ command: "annotate_save_copy", args: { imageData: "data:image/png;base64,edited" } }));
    await act(async () => { await emit("annotate-ready"); });
    await waitFor(() => expect((screen.getByRole("button", { name: "画笔" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("无图片时禁止导出，避免保存空白或上一张图片", async () => {
    const { setImage } = await editor();
    setImage("");
    await act(async () => { await emit("annotate-ready"); });
    expect((screen.getByRole("button", { name: "保存副本" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("没有待标注的截图")).toBeTruthy();
  });
});
