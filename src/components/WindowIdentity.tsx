import { iconUrl } from "../lib/media";
import { windowPickerLabels } from "../lib/windowList";
import { useI18n } from "../lib/i18n";
import type { CapturableWindow } from "../types";
import { MediaImage } from "./MediaImage";

/** Both pickers show the same identity; the host owns focus and selection. */
export function WindowIdentity({ item, variant }: { item: CapturableWindow; variant: "menu" | "palette" }) {
  const { t } = useI18n();
  const labels = windowPickerLabels(item);
  const menu = variant === "menu";
  return (
    <span className={menu ? "mw-window-item" : "palette-window"}>
      <span className={menu ? "mw-window-icon" : "palette-icon"}>
        <MediaImage src={iconUrl(item.pid, menu ? 16 : 20)} fallback={<span className={menu ? "mw-window-blank" : "palette-icon-blank"} />} />
      </span>
      <span className={menu ? "mw-window-name" : "palette-window-name"}>{labels.name}</span>
      {labels.title && <span className={menu ? "mw-window-title" : "palette-window-title small quiet"}>{labels.title}</span>}
      {!menu && item.minimized && <span className="palette-window-state small quiet">{t("已最小化")}</span>}
    </span>
  );
}
