import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { setupTauriMock } from "../test/tauri";
import { ModelSettingsDialog } from "./ModelSettingsDialog";

const settings = {
  baseUrl: "https://api.example.com/v1",
  model: "demo",
  hasApiKey: true,
  templates: [],
  activeTemplateId: "builtin-default",
} as unknown as Settings;

describe("saved API key", () => {
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
