import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppContext, type AppContextValue } from "../app/context";
import { setupTauriMock } from "../test/tauri";
import type { Settings, SnapshotRecord } from "../types";
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

describe("history selection under a filter", () => {
  it("toggles all visible snapshots back off without touching hidden selections", async () => {
    setupTauriMock((command) => {
      if (command === "list_snapshots") return structuredClone(snapshots);
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
    fireEvent.click(screen.getByRole("button", { name: "选择快照" }));
    fireEvent.click(screen.getByRole("button", { name: "全选 1 张" }));
    expect(await screen.findByText("已选 1 张")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    await waitFor(() => expect(screen.getByText("已选 0 张")).toBeTruthy());
  });
});
