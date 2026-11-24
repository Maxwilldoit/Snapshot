import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { englishMessages } from "../i18n/messages";
import { backendErrorEnglish, backendErrorPatterns } from "../i18n/messages/errors";
import { setInterfaceLanguage } from "./backend";

export type Language = "zh" | "en";
export type TranslationParams = Record<string, string | number>;

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let activeLanguage: Language = "zh";

/** 语言始终跟随系统：任何 zh 开头的区域（大陆/港澳台）都用简体中文，其余用英文。 */
function systemLanguage(): Language {
  const locale = navigator.languages?.[0] ?? navigator.language ?? "en";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLanguage(): Language {
  return systemLanguage();
}

export function getActiveLanguage(): Language {
  return activeLanguage;
}

export function applyDocumentLanguage(language: Language) {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.locale = language;
}

function interpolate(text: string, params?: TranslationParams) {
  if (!params) return text;
  return text.replace(/\{(\w+)(?::(lower))?\}/g, (match, key: string, modifier?: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
    const value = String(params[key]);
    return modifier === "lower" ? value.toLowerCase() : value;
  });
}

/** English copy may carry a singular form before "|": "1 item|{count} items". */
function pluralize(text: string, params?: TranslationParams) {
  const split = text.indexOf("|");
  if (split < 0) return text;
  const count = Number(String(params?.count ?? "").replace(/[^\d.-]/g, ""));
  return count === 1 ? text.slice(0, split) : text.slice(split + 1);
}

export function translate(language: Language, source: string, params?: TranslationParams): string {
  const text = language === "en" ? pluralize(englishMessages[source] ?? source, params) : source;
  return interpolate(text, params);
}

export function localizeMessage(message: string, language = getActiveLanguage()): string {
  if (language !== "en") return message;
  const exact = backendErrorEnglish[message] ?? englishMessages[message];
  if (exact) return pluralize(exact);
  for (const [pattern, replacement] of backendErrorPatterns) {
    const match = pattern.exec(message);
    // 嵌套的原因（「保存快照失败：…」里的「…」）也可能是一条后端原文，逐段再译一次
    if (match) return replacement.replace(/\$(\d)/g, (_, group: string) => localizeMessage(match[Number(group)] ?? "", language));
  }
  return message;
}

type I18nValue = {
  language: Language;
  locale: string;
  t: (source: string, params?: TranslationParams) => string;
};

const fallbackValue: I18nValue = {
  language: "zh",
  locale: "zh-CN",
  t: (source, params) => translate("zh", source, params),
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = resolveLanguage();
  activeLanguage = language;
  const t = useCallback(
    (source: string, params?: TranslationParams) => translate(language, source, params),
    [language],
  );

  useEffect(() => {
    activeLanguage = language;
    applyDocumentLanguage(language);
    if (inTauri) void setInterfaceLanguage(language).catch(() => {});
  }, [language]);

  const value = useMemo<I18nValue>(() => ({
    language,
    locale: language === "zh" ? "zh-CN" : "en-US",
    t,
  }), [language, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext) ?? fallbackValue;
}

/** Native window chrome follows the same language as the UI. */
export function useWindowTitle(title: string) {
  useEffect(() => {
    document.title = title;
    if (!inTauri) return;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [title]);
}
