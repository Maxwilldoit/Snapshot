import type { ReactNode } from "react";
import { WindowTitleBar } from "./WindowTitleBar";

/** Shared app surface without the main window's context or navigation. */
export function LibraryWindow({
  title,
  onError,
  children,
}: {
  title?: string;
  onError?: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="window mw library-window">
      {title && onError && (
        <WindowTitleBar className="mw-toolbar" onError={onError}>
          <h1 className="mw-title" data-tauri-drag-region>
            {title}
          </h1>
        </WindowTitleBar>
      )}
      {children}
    </div>
  );
}
