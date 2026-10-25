import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { englishMessages } from "../i18n/messages";
import { backendErrorEnglish, backendErrorPatterns } from "../i18n/messages/errors";
import { setInterfaceLanguage } from "./backend";

export type Language = "zh" | "en";
export type LanguagePreference = "system" | Language;
export type TranslationParams = Record<string, string | number>;

const LANGUAGE_KEY = "snapshot-language";
const LANGUAGE_EVENT = "language-changed";
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let activeLanguage: Language = "zh";

function systemLanguage(): Language {
  const locale = navigator.languages?.[0] ?? navigator.language ?? "en";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function readLanguagePreference(): LanguagePreference {
  const stored = localStorage.getItem(LANGUAGE_KEY);
  return stored === "zh" || stored === "en" || stored === "system" ? stored : "system";
}

export function resolveLanguage(preference: LanguagePreference): Language {
  return preference === "system" ? systemLanguage() : preference;
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
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

export function translate(language: Language, source: string, params?: TranslationParams): string {
  const text = language === "en" ? (englishMessages[source] ?? source) : source;
  return interpolate(text, params);
}

export function localizeMessage(message: string, language = getActiveLanguage()): string {
  if (language !== "en") return message;
  const exact = backendErrorEnglish[message];
  if (exact) return exact;
  for (const [pattern, replacement] of backendErrorPatterns) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}

type I18nValue = {
  language: Language;
  preference: LanguagePreference;
  locale: string;
  t: (source: string, params?: TranslationParams) => string;
  setLanguagePreference: (next: LanguagePreference) => void;
};

const fallbackValue: I18nValue = {
  language: "zh",
  preference: "system",
  locale: "zh-CN",
  t: (source, params) => translate("zh", source, params),
  setLanguagePreference: () => {},
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LanguagePreference>(readLanguagePreference);
  const language = resolveLanguage(preference);
  activeLanguage = language;
  const t = useCallback(
    (source: string, params?: TranslationParams) => translate(language, source, params),
    [language],
  );

  const setLanguagePreference = useCallback((next: LanguagePreference) => {
    localStorage.setItem(LANGUAGE_KEY, next);
    setPreference(next);
    if (inTauri) void setInterfaceLanguage(resolveLanguage(next)).catch(() => {});
    if (inTauri) void emit(LANGUAGE_EVENT, next).catch(() => {});
  }, []);

  useEffect(() => {
    activeLanguage = language;
    applyDocumentLanguage(language);
    if (inTauri) void setInterfaceLanguage(language).catch(() => {});
  }, [language]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_KEY) setPreference(readLanguagePreference());
    };
    window.addEventListener("storage", onStorage);
    const pending = inTauri
      ? listen<LanguagePreference>(LANGUAGE_EVENT, ({ payload }) => {
          if (payload === "system" || payload === "zh" || payload === "en") setPreference(payload);
        })
      : Promise.resolve(() => {});
    return () => {
      window.removeEventListener("storage", onStorage);
      void pending.then((unlisten) => {
        try { unlisten(); } catch { /* The WebView is already closing. */ }
      }).catch(() => {});
    };
  }, []);

  const value = useMemo<I18nValue>(() => ({
    language,
    preference,
    locale: language === "zh" ? "zh-CN" : "en-US",
    t,
    setLanguagePreference,
  }), [language, preference, setLanguagePreference, t]);

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
