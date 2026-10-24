import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";
import { setupTauriMock, invokeArgs } from "../test/tauri";

const records = ["first", "second"].map((id) => ({
  id, appName: id, fileName: `${id}.png`, width: 200, height: 100, sizeBytes: 1000, createdAt: 1,
}));

describe("历史预览标注", () => {
  it("打开当前翻到的快照，并保留预览以便返回", async () => {
    const annotate = vi.fn();
    setupTauriMock((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    });
    const onClose = vi.fn();
    render(<Lightbox records={records} startId="first" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    fireEvent.click(screen.getByRole("button", { name: "标注" }));
    await waitFor(() => expect(annotate).toHaveBeenCalledWith("second"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("second");
  });

  it("文件丢失时显示错误并允许重试", async () => {
    setupTauriMock((command) => {
      if (command === "annotate_snapshot") throw new Error("快照文件已被移动或删除");
    });
    render(<Lightbox records={records} startId="first" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "标注" }));
    expect((await screen.findByRole("alert")).textContent).toContain("快照文件已被移动或删除");
    expect((screen.getByRole("button", { name: "标注" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
