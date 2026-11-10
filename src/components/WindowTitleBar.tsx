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

/**
 * 最小化、最大化、关闭三个按钮。窗口没有系统标题栏（decorations: false），只能自己画。
 * variant="mac" 画成左上角的红黄绿三个圆点，其余平台是右上角的三个方块按钮；做的事完全一样。
 */
export function WindowControls({ variant = "win", onError }: { variant?: "win" | "mac"; onError: (message: string) => void }) {
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
  const close = () => run(() => appWindow.close(), t("关闭"));
  const minimize = () => run(() => appWindow.minimize(), t("最小化"));
  const maximize = () => run(() => appWindow.toggleMaximize(), t("最大化"));

  if (variant === "mac") {
    return (
      <span className="traffic-lights">
        <button type="button" className="is-close" aria-label={t("关闭")} onClick={close} />
        <button type="button" className="is-min" aria-label={t("最小化")} onClick={minimize} />
        <button type="button" className="is-max" aria-label={t("最大化或还原")} onClick={maximize} />
      </span>
    );
  }
  return (
    <span className="window-controls">
      <button type="button" aria-label={t("最小化")} onClick={minimize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
      </button>
      <button type="button" aria-label={t("最大化或还原")} onClick={maximize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
      </button>
      <button type="button" className="is-close" aria-label={t("关闭")} onClick={close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
      </button>
    </span>
  );
}

/** 独立窗口也可复用的主题标题栏，不依赖主窗口的 AppContext。 */
export function WindowTitleBar({ children, right, tall = false, className = "", onError }: WindowTitleBarProps) {
  const { t } = useI18n();
  return (
    <header
      className={`titlebar ${tall ? "is-tall" : ""} ${className}`}
      data-tauri-drag-region
    >
      {children ?? <span className="titlebar-name" data-tauri-drag-region>{t("应用快照")}</span>}
      <span className="titlebar-fill" data-tauri-drag-region />
      {right}
      <WindowControls onError={onError} />
    </header>
  );
}
