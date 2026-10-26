import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { localizeMessage, useI18n } from "../lib/i18n";

type WindowTitleBarProps = {
  children?: ReactNode;
  right?: ReactNode;
  tall?: boolean;
  className?: string;
  onError: (message: string) => void;
};

/** 独立窗口也可复用的主题标题栏，不依赖主窗口的 AppContext。 */
export function WindowTitleBar({ children, right, tall = false, className = "", onError }: WindowTitleBarProps) {
  const { t } = useI18n();
  const appWindow = getCurrentWindow();
  const run = (action: () => Promise<unknown>, label: string) => {
    void action().catch((error: unknown) => {
      onError(t("{action}失败：{detail}", {
        action: label,
        detail: localizeMessage(error instanceof Error ? error.message : String(error)),
      }));
    });
  };

  return (
    <header
      className={`titlebar ${tall ? "is-tall" : ""} ${className}`}
      data-tauri-drag-region
    >
      {children ?? <span className="titlebar-name" data-tauri-drag-region>{t("应用快照")}</span>}
      <span className="titlebar-fill" data-tauri-drag-region />
      {right}
      <span className="window-controls">
        <button type="button" aria-label={t("最小化")} onClick={() => run(() => appWindow.minimize(), t("最小化"))}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
        </button>
        <button type="button" aria-label={t("最大化或还原")} onClick={() => run(() => appWindow.toggleMaximize(), t("最大化"))}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button type="button" className="is-close" aria-label={t("关闭")} onClick={() => run(() => appWindow.close(), t("关闭"))}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
        </button>
      </span>
    </header>
  );
}
