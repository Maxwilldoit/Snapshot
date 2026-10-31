import { createContext, useContext } from "react";
import type {
  ActivityEntry,
  ClipboardState,
  NavPage,
  PlatformCapabilities,
  RecordingStatus,
  Settings,
} from "../types";
import { localizeMessage } from "../lib/i18n";

export type NoticeKind = "info" | "error";
export type Notice = { id: number; text: string; kind: NoticeKind; at: number };

/** 主窗口里各页面共用的东西。页面只管自己那一块，跨页的状态都从这里取 */
export type AppContextValue = {
  settings: Settings;
  onSaved: (settings: Settings) => void;
  /** 一句话提示。由侧栏伴侣说出来，伴侣页里浮在左下角 */
  notify: (text: string, kind?: NoticeKind) => void;
  notice: Notice | null;
  dismissNotice: () => void;
  /** 启动时没注册上的快捷键 */
  conflicts: string[];
  setConflicts: (keys: string[]) => void;
  caps: PlatformCapabilities | null;
  activity: ActivityEntry[];
  clipboard: ClipboardState | null;
  recording: RecordingStatus;
  page: NavPage;
  navigate: (page: NavPage, options?: { previewId?: string }) => void;
  /** navigate 顺带的参数：进历史页直接放大指定截图 */
  pendingPreviewId: string | null;
  consumePreviewId: () => void;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 只能在 App 里用");
  return value;
}

export function errorText(error: unknown): string {
  return localizeMessage(error instanceof Error ? error.message : String(error));
}
