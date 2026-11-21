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
});
