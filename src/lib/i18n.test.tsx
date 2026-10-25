import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyDocumentLanguage, I18nProvider, localizeMessage, translate, useI18n } from "./i18n";

function LanguageProbe() {
  const { language, t, preference, setLanguagePreference } = useI18n();
  return (
    <div>
      <span data-testid="language">{language}</span>
      <span data-testid="preference">{preference}</span>
      <span>{t("偏好设置")}</span>
      <button type="button" onClick={() => setLanguagePreference("en")}>English</button>
      <button type="button" onClick={() => setLanguagePreference("zh")}>Chinese</button>
    </div>
  );
}

describe("interface language", () => {
  it("translates product copy and interpolates dynamic values", () => {
    expect(translate("en", "窗口快照")).toBe("Window capture");
    expect(translate("en", "{count} 项", { count: 3 })).toBe("3 items");
    expect(translate("zh", "{count} 项", { count: 3 })).toBe("3 项");
  });

  it("translates common native errors, including interpolated details", () => {
    expect(localizeMessage("目标窗口已经关闭", "en")).toBe("The target window has closed.");
    expect(localizeMessage("截取失败：permission denied", "en")).toBe("Capture failed: permission denied");
    expect(localizeMessage("目标窗口已经关闭", "zh")).toBe("目标窗口已经关闭");
  });

  it("switches immediately and remembers an explicit choice", () => {
    localStorage.setItem("snapshot-language", "zh");
    render(<I18nProvider><LanguageProbe /></I18nProvider>);
    expect(screen.getByText("偏好设置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByText("Preferences")).toBeTruthy();
    expect(screen.getByTestId("language").textContent).toBe("en");
    expect(localStorage.getItem("snapshot-language")).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "Chinese" }));
    expect(screen.getByText("偏好设置")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("uses the English system locale on first launch", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-GB", "en"]);
    localStorage.removeItem("snapshot-language");
    render(<I18nProvider><LanguageProbe /></I18nProvider>);
    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(screen.getByTestId("language").textContent).toBe("en");
    expect(screen.getByText("Preferences")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("uses Simplified Chinese for a Chinese system locale unless an explicit choice exists", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-TW", "zh"]);
    localStorage.removeItem("snapshot-language");
    const view = render(<I18nProvider><LanguageProbe /></I18nProvider>);
    expect(screen.getByTestId("language").textContent).toBe("zh");
    expect(screen.getByText("偏好设置")).toBeTruthy();

    view.unmount();
    localStorage.setItem("snapshot-language", "en");
    render(<I18nProvider><LanguageProbe /></I18nProvider>);
    expect(screen.getByTestId("language").textContent).toBe("en");
    expect(screen.getByText("Preferences")).toBeTruthy();
  });

  it("sets the document language before the interface renders", () => {
    applyDocumentLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.locale).toBe("en");
  });
});
