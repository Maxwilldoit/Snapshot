import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyDocumentLanguage, I18nProvider, localizeMessage, translate, useI18n } from "./i18n";
import { englishMessages } from "../i18n/messages";
import { backendErrorEnglish, backendErrorPatterns } from "../i18n/messages/errors";

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
    expect(translate("en", "窗口快照")).toBe("Window Screenshot");
    expect(translate("en", "{count} 项", { count: 3 })).toBe("3 items");
    expect(translate("zh", "{count} 项", { count: 3 })).toBe("3 项");
  });

  it("picks singular or plural English and keeps Chinese untouched", () => {
    expect(translate("en", "{count} 项", { count: 1 })).toBe("1 item");
    expect(translate("en", "{count} 字", { count: "1,024" })).toBe("1,024 characters");
    expect(translate("en", "{count} 字", { count: "1" })).toBe("1 character");
    expect(translate("en", "{count} 个冲突", { count: 2 })).toBe("2 conflicts");
    expect(translate("en", "拉到了 {count} 个模型", { count: 1 })).toBe("Found 1 model");
    expect(translate("zh", "{count} 个冲突", { count: 1 })).toBe("1 个冲突");
  });

  it("lowercases an action word inside an English sentence", () => {
    expect(translate("en", "{action}失败：{detail}", { action: translate("en", "保存"), detail: "Disk full." }))
      .toBe("Couldn’t save. Disk full.");
    expect(translate("zh", "{action}失败：{detail}", { action: "保存", detail: "磁盘已满" })).toBe("保存失败：磁盘已满");
  });

  it("keeps the English glossary consistent", () => {
    const copy = [
      ...Object.values(englishMessages),
      ...Object.values(backendErrorEnglish),
      ...backendErrorPatterns.map(([, text]) => text),
    ];
    // 术语表：截图记录 = History，润色 = Enhance，桌宠 = Pet，编号 = Counter（与 CleanShot X、Shottr、Codex、Augment 等的叫法一致）
    const banned = [/\bcompanion/i, /\bpreferences\b/i, /\bannotat/i, /\bsnapshots?\b(?!\.app)/, /successfully/i, /\bplease\b/i, /!/, /failed to /i, /\bcould not\b/i, /\bfullscreen\b/i, /(?<!prompt )\blibrary\b/i, /\brewrit/i, /\bpolish/i, /numbered step/i, /desktop pets?\b/i];
    for (const text of copy) {
      for (const pattern of banned) {
        if (pattern.test(text)) {
          throw new Error(`“${text}” breaks the glossary (${pattern})`);
        }
      }
    }
  });

  it("uses the settled names for the main features", () => {
    expect(translate("en", "资料库")).toBe("History");
    expect(translate("en", "存入截图记录")).toBe("Save to History");
    expect(translate("en", "润色 Prompt")).toBe("Enhance Prompt");
    expect(translate("en", "桌面伴侣")).toBe("Pets");
    expect(translate("en", "素材库")).toBe("Pet Gallery");
    expect(translate("en", "编号")).toBe("Counter");
  });

  it("translates common native errors, including interpolated details", () => {
    expect(localizeMessage("目标窗口已经关闭", "en")).toBe("That window is closed. Choose another one.");
    expect(localizeMessage("截取失败：permission denied", "en")).toBe("Couldn’t take the screenshot. permission denied");
    expect(localizeMessage("已复制标注图，30 秒后自动清空剪贴板", "en")).toBe("Copied. The clipboard clears in 30 seconds.");
    expect(localizeMessage("已复制，但没能存进历史记录：保存快照失败：disk full", "en")).toBe(
      "Copied, but couldn’t save it to History. Couldn’t save the screenshot. disk full",
    );
    expect(localizeMessage("目标窗口已经关闭", "zh")).toBe("目标窗口已经关闭");
  });

  it("explains background capture errors without requesting Accessibility permission", () => {
    expect(localizeMessage("目标窗口暂无可用画面，若已最小化请先还原后重试", "en"))
      .toBe("That window has nothing to capture right now. If it’s minimized, restore it and try again.");
    expect(localizeMessage("无感窗口采集超时，请检查屏幕录制权限或先还原最小化窗口", "en"))
      .toBe("Capturing the window took too long. Check Screen Recording permission, or restore the window if it’s minimized.");
    expect(localizeMessage("无感窗口采集失败：permission denied", "en"))
      .toBe("Couldn’t capture the window. permission denied");
  });

  it("switches immediately and remembers an explicit choice", () => {
    localStorage.setItem("snapshot-language", "zh");
    render(<I18nProvider><LanguageProbe /></I18nProvider>);
    expect(screen.getByText("偏好设置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByText("Settings")).toBeTruthy();
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
    expect(screen.getByText("Settings")).toBeTruthy();
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
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("sets the document language before the interface renders", () => {
    applyDocumentLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.locale).toBe("en");
  });
});
