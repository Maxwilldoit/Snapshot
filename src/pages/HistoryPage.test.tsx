import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { AppContext, type AppContextValue } from "../app/context";
import { setupTauriMock, invokeArgs } from "../test/tauri";
import type { RecordingRecord, Settings, SnapshotRecord } from "../types";
import { HistoryPage } from "./HistoryPage";

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
  clipboardAutoClear: "60s",
  snapshotFormat: "png",
  saveDir: "",
  recordingDir: "",
  shutterSound: "none",
  customSoundPath: null,
  flashOnCapture: false,
  hideAfterCopy: false,
  autoSaveLocal: true,
  launchOnBoot: false,
  includeCursor: false,
  recordSystemAudio: false,
  recordMicrophone: false,
  afterCapture: "clipboard",
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
  clipboard: null,
  recording: { active: false, target: null, startedAt: null },
  page: "history",
  navigate: () => {},
  pendingPreviewId: null,
  consumePreviewId: () => {},
};

const snapshots: SnapshotRecord[] = [
  { id: "1", fileName: "1.png", appName: "Alpha", width: 100, height: 80, sizeBytes: 10, createdAt: 2 },
  { id: "2", fileName: "2.png", appName: "Beta", width: 100, height: 80, sizeBytes: 10, createdAt: 1 },
];

const recording: RecordingRecord = {
  id: "应用快照-2026-11-12_10-00-00",
  fileName: "应用快照-2026-11-12_10-00-00.mp4",
  appName: "Gamma",
  sizeBytes: 5000,
  createdAt: 3,
};

function renderHistory(handler: (command: string, args?: Parameters<typeof invokeArgs>[0]) => unknown = () => undefined, overrides: Partial<AppContextValue> = {}) {
  setupTauriMock((command, args) => {
    if (command === "list_snapshots") return structuredClone(snapshots);
    if (command === "list_recordings") return [];
    return handler(command, args);
  }, { shouldMockEvents: true });
  return render(<AppContext.Provider value={{ ...context, ...overrides }}><HistoryPage /></AppContext.Provider>);
}

describe("history opens annotation and uses a context menu", () => {
  it("clicking a screenshot opens its annotation window without mounting a lightbox", async () => {
    const annotate = vi.fn();
    renderHistory((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    });
    fireEvent.click(await screen.findByRole("button", { name: "标注：Alpha" }));
    await waitFor(() => expect(annotate).toHaveBeenCalledWith("1"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("a pending screenshot also opens annotation and reports a missing-file error", async () => {
    const notify = vi.fn(), consumePreviewId = vi.fn();
    renderHistory((command) => {
      if (command === "annotate_snapshot") throw new Error("快照文件已被移动或删除");
    }, { pendingPreviewId: "1", consumePreviewId, notify });
    await waitFor(() => expect(consumePreviewId).toHaveBeenCalledOnce());
    await waitFor(() => expect(notify).toHaveBeenCalledWith("快照文件已被移动或删除", "error"));
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("right-click copy targets that screenshot and deletion waits for confirmation", async () => {
    const copied = vi.fn(), deleted = vi.fn();
    renderHistory((command, args) => {
      if (command === "copy_snapshot") { copied(invokeArgs(args).id); return "已复制"; }
      if (command === "delete_snapshots") { deleted(invokeArgs(args).ids); return [snapshots[1]]; }
    });
    const tile = await screen.findByRole("button", { name: "标注：Alpha" });
    fireEvent.contextMenu(tile, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith("1"));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(tile);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(deleted).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除 1 项" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(["1"]));
  });

  it("canceling right-click deletion preserves the current multi-selection", async () => {
    const deleted = vi.fn();
    renderHistory((command) => { if (command === "delete_snapshots") deleted(); });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "选择：Beta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "选择：Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "选择：Beta" }).getAttribute("aria-pressed")).toBe("false");
    expect(deleted).not.toHaveBeenCalled();
  });

  it("right-clicking a selected tile deletes the selected batch after confirmation", async () => {
    const deleted = vi.fn();
    renderHistory((command, args) => {
      if (command === "delete_snapshots") { deleted(invokeArgs(args).ids); return []; }
    });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    fireEvent.click(screen.getByRole("button", { name: "选择：Beta" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "选择：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("删除全部 2 项？")).toBeTruthy();
    expect(deleted).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除 2 项" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(["1", "2"]));
  });

  it("Shift+F10 opens the same keyboard-operable menu and Escape restores focus", async () => {
    renderHistory();
    const tile = await screen.findByRole("button", { name: "标注：Alpha" });
    tile.focus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "多选" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "复制" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it("the context menu stays inside the window near the bottom-right corner", async () => {
    renderHistory();
    const tile = await screen.findByRole("button", { name: "标注：Alpha" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? new DOMRect(0, 0, 220, 100) : new DOMRect();
    });
    fireEvent.contextMenu(tile, { clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 228}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 108}px`);
    fireEvent.scroll(document.querySelector(".history-scroll")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a failed deletion keeps the items and selection available for retry", async () => {
    const notify = vi.fn();
    renderHistory((command) => {
      if (command === "delete_snapshots") throw new Error("无法删除快照");
    }, { notify });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    fireEvent.click(screen.getByRole("button", { name: "全选 2 项" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 2 项" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除 2 项" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("无法删除快照", "error"));
    expect(screen.getByRole("button", { name: "选择：Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "选择：Beta" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("history selection under a filter", () => {
  it("enters multi-select from the context menu and toggles the visible selection", async () => {
    setupTauriMock((command) => {
      if (command === "list_snapshots") return structuredClone(snapshots);
      if (command === "list_recordings") return [];
      if (command === "list_prompt_history") return [];
      return undefined;
    }, { shouldMockEvents: true });
    render(
      <AppContext.Provider value={context}>
        <HistoryPage />
      </AppContext.Provider>,
    );

    await screen.findByRole("button", { name: "标注：Alpha" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alpha" } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    expect(await screen.findByText("已选 1 项")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    await waitFor(() => expect(screen.getByText("已选 0 项")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "全选 1 项" }));
    expect(await screen.findByText("已选 1 项")).toBeTruthy();
  });

  it("select-all / deselect-all both act on the visible tiles only", async () => {
    setupTauriMock((command) => {
      if (command === "list_snapshots") return structuredClone(snapshots);
      if (command === "list_recordings") return [];
      if (command === "list_prompt_history") return [];
      return undefined;
    }, { shouldMockEvents: true });
    render(
      <AppContext.Provider value={context}>
        <HistoryPage />
      </AppContext.Provider>,
    );

    const tile = (label: string) => screen.getByRole("button", { name: `选择：${label}` });

    fireEvent.contextMenu(await screen.findByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    fireEvent.click(tile("Beta"));
    expect(await screen.findByText("已选 2 项")).toBeTruthy();

    // 两格都可见且选中 → 「全不选」；清掉的恰好是可见的这两格
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    await waitFor(() => expect(screen.getByText("已选 0 项")).toBeTruthy());
    expect(tile("Alpha").getAttribute("aria-pressed")).toBe("false");
    expect(tile("Beta").getAttribute("aria-pressed")).toBe("false");

    // 按钮翻成「全选 2 项」；再点一次把可见的两格选回来
    fireEvent.click(screen.getByRole("button", { name: "全选 2 项" }));
    await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());
    expect(tile("Alpha").getAttribute("aria-pressed")).toBe("true");
    expect(tile("Beta").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "选整组" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消整组" })).toBeNull();
  });
});

describe("history mixes recordings into the timeline", () => {
  it("renders a video cover for recordings alongside screenshots, newest first", async () => {
    setupTauriMock((command) => {
      if (command === "list_snapshots") return structuredClone(snapshots);
      if (command === "list_recordings") return [structuredClone(recording)];
      return undefined;
    }, { shouldMockEvents: true });
    render(
      <AppContext.Provider value={context}>
        <HistoryPage />
      </AppContext.Provider>,
    );

    // 录屏比两张截图都新，排在最前；封面是 video，截图仍是 img
    await screen.findByRole("button", { name: "播放：Gamma" });
    expect(document.querySelector(".tile video")).toBeTruthy();
    expect(document.querySelectorAll(".tile-main img").length).toBe(2);
    expect(screen.getByRole("button", { name: "标注：Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "播放：Gamma" }));
    const player = screen.getByRole("dialog");
    expect(within(player).getByLabelText("Gamma")).toHaveProperty("controls", true);
    expect(within(player).getByText("1 / 1")).toBeTruthy();
    expect(within(player).getByRole("button", { name: "下一张" })).toHaveProperty("disabled", true);
  });

  it("deletes a recording through delete_recordings, not delete_snapshots", async () => {
    const deleted: string[][] = [];
    setupTauriMock((command, args) => {
      if (command === "list_snapshots") return structuredClone(snapshots);
      if (command === "list_recordings") return [structuredClone(recording)];
      if (command === "delete_recordings") {
        deleted.push(invokeArgs(args).ids as string[]);
        return [];
      }
      if (command === "delete_snapshots") throw new Error("should not delete snapshots");
      return undefined;
    }, { shouldMockEvents: true });
    render(
      <AppContext.Provider value={context}>
        <HistoryPage />
      </AppContext.Provider>,
    );

    fireEvent.contextMenu(await screen.findByRole("button", { name: "播放：Gamma" }));
    expect(screen.queryByRole("menuitem", { name: "复制" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除 1 项" }));
    await waitFor(() => expect(deleted).toEqual([[recording.id]]));
  });
});
