import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../app/context";
import { invokeArgs, setupTauriMock } from "../test/tauri";
import type { ClipboardHistoryEntry, Settings } from "../types";
import { ClipboardPage } from "./ClipboardPage";

const settings: Settings = {
  baseUrl: "",
  model: "",
  hasApiKey: false,
  templates: [],
  activeTemplateId: "builtin-default",
  selectedAppearanceId: "app-icon",
  petAssets: [],
  petScale: 100,
  shortcuts: [],
  snapshotFormat: "png",
  saveDir: "",
  recordingDir: "",
  shutterSound: "none",
  customSoundPath: null,
  launchOnBoot: false,
  includeCursor: false,
  recordSystemAudio: false,
  recordMicrophone: false,
};

const context: AppContextValue = {
  settings,
  onSaved: () => {},
  notify: () => {},
  notice: null,
  dismissNotice: () => {},
  conflicts: [],
  setConflicts: () => {},
  caps: null,
  activity: [],
  recording: { active: false, target: null, startedAt: null },
  page: "clipboard",
  navigate: () => {},
  pendingPreviewId: null,
  consumePreviewId: () => {},
};

describe("ClipboardPage performance and timeline scrubber", () => {
  it("uses lightweight clipboard thumbnails with explicit dimensions, truncates huge text, and copies on row click", async () => {
    const hugeText = `${"alpha ".repeat(200)}needle-at-end`;
    const entries: ClipboardHistoryEntry[] = [
      { id: "clip-img", createdAt: new Date(2026, 10, 21, 10, 0).getTime(), kind: "image", text: "", width: 2560, height: 1440, hash: "h1" },
      { id: "clip-long", createdAt: new Date(2026, 10, 20, 9, 0).getTime(), kind: "text", text: hugeText, width: 0, height: 0, hash: "h2" },
    ];
    const copied = vi.fn();
    setupTauriMock((command, args) => {
      if (command === "list_clipboard_history") return structuredClone(entries);
      if (command === "copy_clipboard_history") copied(invokeArgs(args).id);
      return undefined;
    }, { shouldMockEvents: true });

    const { container } = render(<AppContext.Provider value={context}><ClipboardPage /></AppContext.Provider>);
    const img = await screen.findByRole("img", { name: "图片 2560 × 1440" });
    expect(img.getAttribute("src")).toContain("clipboard-thumb");
    expect(img.getAttribute("width")).toBe("114");
    expect(img.getAttribute("height")).toBe("64");
    expect(container.querySelector(".clip-copy-icon")).toBeNull();

    const textSpan = container.querySelector(".clip-text")!;
    expect(textSpan.textContent!.length).toBeLessThan(350);
    expect(textSpan.textContent).toContain("…");

    fireEvent.click(textSpan.closest("button")!);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("clip-long"));

    const scroller = container.querySelector<HTMLElement>(".clipboard-scroll")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 1400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    fireEvent(window, new Event("resize"));
    expect(await screen.findByRole("slider", { name: "时间定位" })).toBeTruthy();
  });

  it("defers showing the recopied entry until returning to the page and keeps the original entry", async () => {
    const oldTime = new Date(2026, 10, 20, 9, 15).getTime();
    const newerTime = new Date(2026, 10, 21, 10, 0).getTime();
    const recopiedTime = new Date(2026, 10, 21, 17, 55).getTime();
    let entries: ClipboardHistoryEntry[] = [
      { id: "clip-new", createdAt: newerTime, kind: "text", text: "latest item", width: 0, height: 0, hash: "h-new" },
      { id: "clip-old", createdAt: oldTime, kind: "text", text: "older item", width: 0, height: 0, hash: "h-old" },
    ];
    setupTauriMock((command, args) => {
      if (command === "list_clipboard_history") return structuredClone(entries);
      if (command === "copy_clipboard_history") {
        const source = entries.find((item) => item.id === invokeArgs(args).id)!;
        const created: ClipboardHistoryEntry = {
          ...source,
          id: "clip-recopied",
          createdAt: recopiedTime,
        };
        entries = [created, ...entries];
        return structuredClone(created);
      }
      if (command === "delete_clipboard_history") {
        const ids = invokeArgs(args).ids as string[];
        entries = entries.filter((item) => !ids.includes(item.id));
        return structuredClone(entries);
      }
      return undefined;
    }, { shouldMockEvents: true });

    const firstMount = render(<AppContext.Provider value={context}><ClipboardPage /></AppContext.Provider>);
    const olderText = await screen.findByText("older item");
    expect(screen.getAllByText("older item")).toHaveLength(1);

    fireEvent.click(olderText.closest("button")!);
    await waitFor(() => expect(entries).toHaveLength(3));
    // 当前留在剪贴板页时不立即插入新条目
    expect(screen.getAllByText("older item")).toHaveLength(1);

    // 即使在当前页删除了另一条触发列表回写，刚才放回剪贴板的新条目仍保持延迟
    const deleteButtons = screen.getAllByRole("button", { name: "删除这条记录" });
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => expect(screen.queryByText("latest item")).toBeNull());
    expect(screen.getAllByText("older item")).toHaveLength(1);

    // 离开再回到剪贴板页后，新旧两条同时存在且各自保留原始/新时间
    firstMount.unmount();
    render(<AppContext.Provider value={context}><ClipboardPage /></AppContext.Provider>);
    const both = await screen.findAllByText("older item");
    expect(both).toHaveLength(2);
    expect(screen.getByText("17:55")).toBeTruthy();
    expect(screen.getByText("09:15")).toBeTruthy();
  });

  it("shows a lossless hover preview when hovering an image entry and dismisses on leave or scroll", async () => {
    const entries: ClipboardHistoryEntry[] = [
      { id: "clip-img", createdAt: new Date(2026, 10, 21, 14, 20).getTime(), kind: "image", text: "", width: 1600, height: 1000, hash: "h-img" },
      { id: "clip-txt", createdAt: new Date(2026, 10, 21, 14, 10).getTime(), kind: "text", text: "plain text", width: 0, height: 0, hash: "h-txt" },
    ];
    setupTauriMock((command) => {
      if (command === "list_clipboard_history") return structuredClone(entries);
      return undefined;
    }, { shouldMockEvents: true });

    const { container } = render(<AppContext.Provider value={context}><ClipboardPage /></AppContext.Provider>);
    const img = await screen.findByRole("img", { name: "图片 1600 × 1000" });
    const imgButton = img.closest("button")!;
    const txtButton = screen.getByText("plain text").closest("button")!;

    // 悬停文字条目不弹出图片预览
    fireEvent.pointerEnter(txtButton);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // 悬停图片条目立即弹出原图预览
    fireEvent.pointerEnter(imgButton, { clientX: 300 });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("1600 × 1000 · PNG");
    const full = tip.querySelector<HTMLImageElement>("img.hover-preview-full");
    expect(full?.src).toContain("clipboard");
    expect(full?.src).not.toContain("clipboard-thumb");

    // 滚轮滚动立即收起预览
    fireEvent.scroll(container.querySelector(".clipboard-scroll")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
