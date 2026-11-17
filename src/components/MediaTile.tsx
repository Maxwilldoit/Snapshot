import { useState } from "react";
import { appIconUrl, appNameIconUrl, recordingUrl, thumbUrl } from "../lib/media";
import { formatClock, formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { MediaItem } from "../lib/mediaTimeline";

/**
 * 历史网格的统一格位：横图、竖图与长截图都按原比例完整居中显示。
 * 来源图标、时长和悬停时间贴着图片边缘；点击预览，右键或 Shift+F10 打开菜单。
 */
export function MediaTile({
  item,
  selecting = false,
  selected = false,
  onOpen,
  onMenu,
}: {
  item: MediaItem;
  selecting?: boolean;
  selected?: boolean;
  onOpen: (item: MediaItem, event: React.MouseEvent) => void;
  onMenu: (item: MediaItem, anchor: HTMLElement, point: { x: number; y: number }) => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const isRecording = item.kind === "recording";
  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 16 / 9;
  const label = item.appName;
  const iconSrc = item.appId ? appIconUrl(item.appId, 20) : appNameIconUrl(item.appName, 20);
  const hasIcon = !iconFailed;

  function openMenu(anchor: HTMLElement, point?: { x: number; y: number }) {
    const box = anchor.getBoundingClientRect();
    onMenu(item, anchor, point ?? { x: box.left + Math.min(20, box.width / 2), y: box.top + Math.min(20, box.height / 2) });
  }

  return (
    <div
      className={`tile ${selected ? "is-selected" : ""} ${selecting ? "is-selecting" : ""} ${hasIcon ? "has-app-icon" : ""} ${failed ? "is-failed" : ""}`}
    >
      <button
        type="button"
        className="tile-main"
        data-thumb-id={item.id}
        aria-label={selecting ? t("选择：{label}", { label }) : t(isRecording ? "播放：{label}" : "查看：{label}", { label })}
        aria-keyshortcuts="Shift+F10"
        aria-pressed={selecting ? selected : undefined}
        onClick={(event) => onOpen(item, event)}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          openMenu(event.currentTarget);
        }}
      >
        <span
          className="tile-preview"
          style={{ width: `${Math.min(1, ratio) * 100}%`, height: `${Math.min(1, 1 / ratio) * 100}%` }}
        >
          {isRecording ? (
            <video
              src={`${recordingUrl(item.id)}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              tabIndex={-1}
              draggable={false}
              onError={() => setFailed(true)}
            />
          ) : (
            !failed && (
              <img src={thumbUrl(item.id)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
            )
          )}
          {hasIcon && (
            <img
              className="tile-app"
              src={iconSrc}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          )}
          {isRecording && item.durationMs != null && (
            <span className="tile-duration mono">{formatDuration(item.durationMs)}</span>
          )}

          <span className="tile-info" aria-hidden="true">
            <span className="tile-time mono">{formatClock(item.createdAt)}</span>
          </span>
        </span>
      </button>
    </div>
  );
}
