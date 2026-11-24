import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { AppContext, type AppContextValue } from "../app/context";
import { setupTauriMock, invokeArgs } from "../test/tauri";
import type { RecordingRecord, Settings, SnapshotRecord } from "../types";
import { HistoryPage } from "./HistoryPage";
import "../styles/main-window.css";

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

describe("history opens markup directly and previews uncompressed media on hover", () => {
  it("groups items by day with justified rows, newest first", async () => {
    const mixedDates = [
      { ...snapshots[0], createdAt: new Date(2026, 10, 17, 10).getTime(), width: 1200, height: 600 },
      { ...snapshots[1], createdAt: new Date(2025, 8, 1, 10).getTime(), width: 600, height: 1200 },
    ];
    setupTauriMock((command) => command === "list_snapshots" ? mixedDates : command === "list_recordings" ? [] : undefined);
    const { container } = render(<AppContext.Provider value={context}><HistoryPage /></AppContext.Provider>);
    await screen.findByRole("button", { name: "标注：Alpha" });
    const daySections = [...container.querySelectorAll("section.day")];
    expect(daySections).toHaveLength(2);
    expect(container.querySelectorAll(".day-title").length).toBe(2);
    const tiles = [...container.querySelectorAll(".shot .tile-main")];
    expect(tiles.map((tile) => tile.getAttribute("data-thumb-id"))).toEqual(["1", "2"]);
  });

  it("keeps the toolbar in normal flow above history-scroll so the scrollbar track does not enter the header", async () => {
    const prevSurface = document.documentElement.dataset.surface;
    document.documentElement.dataset.surface = "app";
    try {
      const { container } = renderHistory();
      await screen.findByRole("button", { name: "标注：Alpha" });
      const toolbar = container.querySelector<HTMLElement>(".history-page > .mw-toolbar")!;
      const body = container.querySelector<HTMLElement>(".history-page > .history-body")!;
      expect(toolbar).toBeTruthy();
      expect(body).toBeTruthy();
      expect(toolbar.nextElementSibling).toBe(body);
      expect(getComputedStyle(toolbar).position).toBe("relative");
    } finally {
      if (prevSurface === undefined) delete document.documentElement.dataset.surface;
      else document.documentElement.dataset.surface = prevSurface;
    }
  });

  it("clicking a screenshot opens markup directly without opening the modal viewer", async () => {
    const annotate = vi.fn();
    renderHistory((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    });
    fireEvent.click(await screen.findByRole("button", { name: "标注：Alpha" }));
    await waitFor(() => expect(annotate).toHaveBeenCalledWith("1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hovering a screenshot immediately pops out an uncompressed preview window without app name", async () => {
    renderHistory();
    const tile = await screen.findByRole("button", { name: "标注：Alpha" });
    fireEvent.pointerEnter(tile, { pointerType: "mouse", clientX: 240, clientY: 160 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).not.toContain("Alpha");
    expect(within(tooltip).getByText(/100 × 80 · PNG · 1 KB/)).toBeTruthy();
    const fullImg = tooltip.querySelector<HTMLImageElement>("img.hover-preview-full");
    expect(fullImg?.getAttribute("src")).toContain("snapshot");
    expect(fullImg?.getAttribute("src")).not.toContain("thumb");

    fireEvent.scroll(document.querySelector(".history-scroll")!);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // 滚动过程中经过其他卡片不抢先弹出悬停大图，避免滚动掉帧
    const secondTile = screen.getByRole("button", { name: "标注：Beta" });
    fireEvent.pointerEnter(secondTile, { pointerType: "mouse", clientX: 240, clientY: 160 });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("a pending screenshot opens markup directly", async () => {
    const annotate = vi.fn();
    const consumePreviewId = vi.fn();
    renderHistory((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    }, { pendingPreviewId: "1", consumePreviewId });
    await waitFor(() => expect(consumePreviewId).toHaveBeenCalledOnce());
    await waitFor(() => expect(annotate).toHaveBeenCalledWith("1"));
  });

  it("the context menu offers markup for snapshots", async () => {
    const annotate = vi.fn();
    renderHistory((command, args) => {
      if (command === "annotate_snapshot") annotate(invokeArgs(args).id);
    });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "标注：Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标注" }));
    await waitFor(() => expect(annotate).toHaveBeenCalledWith("1"));
    expect(screen.queryByRole("menu")).toBeNull();
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

  it("filters screenshots by numeric date, app name substring, and combined queries", async () => {
    const dated: SnapshotRecord[] = [
      { id: "s1", fileName: "1.png", appName: "相册", appId: "com.apple.Photos", width: 800, height: 600, sizeBytes: 100, createdAt: new Date(2026, 10, 21, 10, 0).getTime() },
      { id: "s2", fileName: "2.png", appName: "访达", appId: "com.apple.finder", width: 800, height: 600, sizeBytes: 100, createdAt: new Date(2026, 10, 21, 12, 0).getTime() },
      { id: "s3", fileName: "3.png", appName: "相机预览", width: 800, height: 600, sizeBytes: 100, createdAt: new Date(2026, 10, 15, 9, 0).getTime() },
    ];
    setupTauriMock((command) => {
      if (command === "list_snapshots") return structuredClone(dated);
      if (command === "list_recordings") return [];
      return undefined;
    }, { shouldMockEvents: true });

    render(<AppContext.Provider value={context}><HistoryPage /></AppContext.Provider>);
    await screen.findByRole("button", { name: "标注：相册" });
    expect(screen.queryByRole("slider")).toBeNull();

    const search = screen.getByRole("textbox", { name: "搜索截图" });

    // 输入应用名关键字「相」→ 匹配「相册」与「相机预览」
    fireEvent.change(search, { target: { value: "相" } });
    expect(screen.getByRole("button", { name: "标注：相册" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标注：相机预览" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标注：访达" })).toBeNull();

    // 输入数字日期「21」→ 定位 11 月 21 日的快照
    fireEvent.change(search, { target: { value: "21" } });
    expect(screen.getByRole("button", { name: "标注：相册" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标注：访达" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标注：相机预览" })).toBeNull();

    // 输入组合「相 11-15」→ 精准命中 11 月 15 日的「相机预览」
    fireEvent.change(search, { target: { value: "相 11-15" } });
    expect(screen.getByRole("button", { name: "标注：相机预览" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标注：相册" })).toBeNull();
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
    expect(document.querySelectorAll(".tile-preview > img:not(.tile-app)").length).toBe(2);
    expect(screen.getByRole("button", { name: "标注：Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "播放：Gamma" }));
    const player = screen.getByRole("dialog");
    expect(within(player).getByLabelText("Gamma")).toHaveProperty("controls", true);
    // 查看器现在混排截图与录屏：录屏最新排第一，共 3 项，可翻到下一张截图
    expect(within(player).getByText("1 / 3")).toBeTruthy();
    expect(within(player).getByRole("button", { name: "下一张" })).toHaveProperty("disabled", false);
    expect(within(player).queryByRole("button", { name: "标注" })).toBeNull();
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

describe("virtualized large history completeness", () => {
  it("preserves full selection, search reset while scrolled, and non-replaying stagger across 200 items", async () => {
    const baseTime = new Date(2026, 10, 21, 12, 0).getTime();
    const many: SnapshotRecord[] = Array.from({ length: 200 }, (_, i) => ({
      id: `v-${i}`,
      fileName: `v-${i}.png`,
      appName: i === 180 ? "UniqueNeedleApp" : `App-${i % 5}`,
      width: 1280,
      height: 720,
      sizeBytes: 4096,
      createdAt: baseTime - i * 45 * 60_000,
    }));
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this === document.documentElement) return 1044;
      return 800;
    });
    const heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      setupTauriMock((command) => {
        if (command === "list_snapshots") return structuredClone(many);
        if (command === "list_recordings") return [];
        return undefined;
      }, { shouldMockEvents: true });

      const { container } = render(<AppContext.Provider value={context}><HistoryPage /></AppContext.Provider>);
      await waitFor(() => expect(container.querySelectorAll(".shot").length).toBeGreaterThan(0));

      // 虚拟化已启用：只挂载视口与缓冲区内的部分节点，而非全部 200 条
      const initialShots = container.querySelectorAll(".shot").length;
      expect(initialShots).toBeLessThan(200);
      expect(container.querySelectorAll("section.day").length).toBeGreaterThan(1);

      // 向下滚动到深处再滚回顶部：首屏条目保持 is-static，不重复播放入场动画
      const scrollEl = container.querySelector<HTMLElement>(".history-scroll")!;
      scrollEl.scrollTop = 4000;
      fireEvent.scroll(scrollEl);
      scrollEl.scrollTop = 0;
      fireEvent.scroll(scrollEl);
      await waitFor(() => expect(container.querySelector(".shot")).toBeTruthy());
      expect(container.querySelector(".shot")!.classList.contains("is-static")).toBe(true);

      // 滚在深处时执行搜索与清除筛选：立即重置滚动位置且无空白屏
      scrollEl.scrollTop = 5000;
      fireEvent.scroll(scrollEl);
      fireEvent.change(screen.getByRole("textbox", { name: "搜索截图" }), { target: { value: "UniqueNeedleApp" } });
      expect(await screen.findByRole("button", { name: "标注：UniqueNeedleApp" })).toBeTruthy();
      expect(scrollEl.scrollTop).toBe(0);

      fireEvent.change(screen.getByRole("textbox", { name: "搜索截图" }), { target: { value: "NoSuchItemXYZ" } });
      fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
      await waitFor(() => expect(container.querySelectorAll(".shot").length).toBeGreaterThan(0));

      // 虚拟化下的全选依然选中全部 200 条而非仅当前挂载的几十条
      fireEvent.contextMenu(container.querySelector<HTMLElement>(".shot .tile-main")!);
      fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
      fireEvent.click(screen.getByRole("button", { name: "全选 200 项" }));
      expect(screen.getByText("已选 200 项")).toBeTruthy();
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });
});
