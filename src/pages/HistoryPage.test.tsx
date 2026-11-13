import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("history selection under a filter", () => {
  it("enters multi-select from the check circle and toggles the visible selection", async () => {
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

    await screen.findByRole("button", { name: "放大：Alpha" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alpha" } });
    // 勾选圈进入多选并选中这一格（工具栏不再有「选择」按钮）；此时可见格全选，按钮是「全不选」
    fireEvent.click(screen.getByRole("button", { name: "选择：Alpha" }));
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

    // 勾选圈在挑选模式下与主按钮同名，按 class 取唯一的那个
    const checkCircle = (label: string) =>
      screen.getAllByRole("button", { name: `选择：${label}` }).find((b) => b.classList.contains("tile-check"))!;

    await screen.findByRole("button", { name: "放大：Alpha" });
    fireEvent.click(checkCircle("Alpha"));
    fireEvent.click(checkCircle("Beta"));
    expect(await screen.findByText("已选 2 项")).toBeTruthy();

    // 两格都可见且选中 → 「全不选」；清掉的恰好是可见的这两格
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    await waitFor(() => expect(screen.getByText("已选 0 项")).toBeTruthy());
    expect(checkCircle("Alpha").getAttribute("aria-pressed")).toBe("false");
    expect(checkCircle("Beta").getAttribute("aria-pressed")).toBe("false");

    // 按钮翻成「全选 2 项」；再点一次把可见的两格选回来
    fireEvent.click(screen.getByRole("button", { name: "全选 2 项" }));
    await waitFor(() => expect(screen.getByText("已选 2 项")).toBeTruthy());
    expect(checkCircle("Alpha").getAttribute("aria-pressed")).toBe("true");
    expect(checkCircle("Beta").getAttribute("aria-pressed")).toBe("true");
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
    await screen.findByRole("button", { name: "放大：Gamma" });
    expect(document.querySelector(".tile video")).toBeTruthy();
    expect(document.querySelectorAll(".tile img").length).toBe(2);
    expect(screen.getByRole("button", { name: "放大：Alpha" })).toBeTruthy();
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

    await screen.findByRole("button", { name: "放大：Gamma" });
    fireEvent.click(screen.getByRole("button", { name: "选择：Gamma" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 1 项" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除 1 项" }));
    await waitFor(() => expect(deleted).toEqual([[recording.id]]));
  });
});