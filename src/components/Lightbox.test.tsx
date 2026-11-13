import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";
import { setupTauriMock, invokeArgs } from "../test/tauri";
import * as motion from "../lib/motion";

const records = ["first", "second"].map((id) => ({
  id, kind: "snapshot" as const, appName: id, fileName: `${id}.png`, width: 200, height: 100, sizeBytes: 1000, createdAt: 1,
}));

afterEach(() => vi.unstubAllGlobals());

describe("历史预览过渡", () => {
  it("首张图片在尺寸回调和重新布局后保持同一节点，只在真正翻页时淡入", () => {
    setupTauriMock();
    let stageWidth = 160;
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, stageWidth, 120));
    const grow = vi.spyOn(motion, "growFrom").mockImplementation(() => {});
    render(<><button data-thumb-id="first">缩略图</button><Lightbox records={records} startId="first" onClose={() => {}} /></>);
    const first = screen.getByRole("img", { name: "first" });
    expect(grow).toHaveBeenCalledTimes(1);
    expect(first.style.width).toBe("160px");

    // 浏览器在放大开始后送达首个 ResizeObserver 通知，不能把它当成翻页。
    act(() => resized?.());
    expect(first.classList.contains("is-swapped")).toBe(false);
    stageWidth = 120;
    act(() => resized?.());
    expect(screen.getByRole("img", { name: "first" })).toBe(first);
    expect(first.style.width).toBe("120px");
    expect(first.classList.contains("is-swapped")).toBe(false);
    expect(grow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(screen.getByRole("img", { name: "second" }).classList.contains("is-swapped")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "上一张" }));
    const back = screen.getByRole("img", { name: "first" });
    expect(back.classList.contains("is-swapped")).toBe(true);
    expect(back.classList.contains("from-prev")).toBe(true);
  });
});

describe("历史预览操作", () => {
  it("页头只保留返回、名称和序号，方向键切换图片，Esc 返回", async () => {
    setupTauriMock();
    const onClose = vi.fn();
    render(<Lightbox records={records} startId="first" onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "标注" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    expect(screen.getByRole("button", { name: "上一张" })).toHaveProperty("disabled", true);
    await userEvent.setup().keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("second");
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一张" })).toHaveProperty("disabled", true);
    await userEvent.setup().keyboard("{ArrowLeft}{Escape}");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("first");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("快捷键复制失败时显示原因，并允许再次复制", async () => {
    let missing = true;
    setupTauriMock((command) => {
      if (command === "copy_snapshot") {
        if (missing) throw new Error("快照文件已被移动或删除");
        return "已复制 first";
      }
    });
    render(<Lightbox records={records} startId="first" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("快照文件已被移动或删除");
    missing = false;
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 first");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Ctrl/Cmd+C 复制当前图片，切换后复制新的图片", async () => {
    const copied: string[] = [];
    setupTauriMock((command, args) => {
      if (command === "copy_snapshot") {
        const id = String(invokeArgs(args).id);
        copied.push(id);
        return `已复制 ${id}`;
      }
    });
    render(<Lightbox records={records} startId="first" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.keyboard("{Control>}c{/Control}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 first");
    await user.keyboard("{ArrowRight}{Meta>}c{/Meta}");
    expect((await screen.findByRole("status")).textContent).toContain("已复制 second");
    expect(copied).toEqual(["first", "second"]);
  });

  it("录屏保留原生播放控件，复制快捷键不调用截图后端", async () => {
    const copied = vi.fn();
    setupTauriMock((command) => {
      if (command === "copy_snapshot") copied();
    });
    render(<Lightbox records={[{ ...records[0], kind: "recording", fileName: "first.mp4", durationMs: 3000 }]} startId="first" onClose={() => {}} />);
    expect(screen.getByLabelText("first").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("first")).toHaveProperty("controls", true);
    await userEvent.setup().keyboard("{Control>}c{/Control}{Meta>}c{/Meta}");
    expect(copied).not.toHaveBeenCalled();
  });
});
