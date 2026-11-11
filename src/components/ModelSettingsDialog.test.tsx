import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { invokeArgs, setupTauriMock } from "../test/tauri";
import { ModelSettingsDialog } from "./ModelSettingsDialog";

const settings = {
  baseUrl: "https://api.example.com/v1",
  model: "demo",
  hasApiKey: true,
  templates: [],
  activeTemplateId: "builtin-default",
} as unknown as Settings;

describe("saved API key", () => {
  it("keeps keyboard focus inside the dialog and restores its opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<ModelSettingsDialog settings={settings} onSaved={() => {}} notify={() => {}} onClose={() => {}} />);
    const first = screen.getByLabelText("接口地址");
    const last = screen.getByRole("button", { name: "保存" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it.each([false, true])("keeps the saved key when saving with replacement cancelled=%s", async (cancelReplacement) => {
    const save = vi.fn((_input: unknown) => settings);
    setupTauriMock((command, payload) => {
      if (command === "save_prompt_settings") return save(invokeArgs(payload).input);
      return undefined;
    });
    render(<ModelSettingsDialog settings={settings} onSaved={() => {}} notify={() => {}} onClose={() => {}} />);
    expect(screen.queryByLabelText("API Key", { exact: true })).toBeNull();
    if (cancelReplacement) {
      fireEvent.click(screen.getByRole("button", { name: "更换" }));
      fireEvent.change(screen.getByLabelText("API Key", { exact: true }), { target: { value: "discarded-test-key" } });
      fireEvent.click(screen.getByRole("button", { name: "取消更换" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: null })));
  });

  it("can be removed from the system credential store", async () => {
    const onSaved = vi.fn();
    setupTauriMock((command) => {
      if (command === "clear_api_key") return { ...settings, hasApiKey: false };
      return undefined;
    });
    render(
      <ModelSettingsDialog
        settings={settings}
        onSaved={onSaved}
        notify={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除已保存的 Key" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      hasApiKey: false,
    }));
  });
});
