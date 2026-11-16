import { useState } from "react";
import { appIconUrl, appNameIconUrl, recordingUrl, thumbUrl } from "../lib/media";
import { formatClock, formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { MediaItem } from "../lib/mediaTimeline";

/**
 * 历史网格的一格：保留原始宽高比，封面铺满格子（同「照片」App 的「所有照片」）。
 * 平时只露左下角的来源应用图标（录屏再加右下角时长）；悬停或聚焦时底部只浮出时间。
 * 截图点开标注，右键（或 Shift+F10）打开操作菜单。
 * 窄长的竖图给一个最小宽度，整张图居中放在浅底上，不裁成一条缝。
 * 旧记录按应用名查找已安装应用的图标；取不到就不显示角标，不用类型图标顶替——
 * 截图和录屏靠封面与时长就能分清，角标只回答「这是哪个应用」。
 */
export function MediaTile({
  item,
  boxWidth,
  boxHeight,
  selecting = false,
  selected = false,
  onOpen,
  onMenu,
}: {
  item: MediaItem;
  boxWidth: number;
  boxHeight: number;
  selecting?: boolean;
  selected?: boolean;
  onOpen: (item: MediaItem, event: React.MouseEvent) => void;
  onMenu: (item: MediaItem, anchor: HTMLElement, point: { x: number; y: number }) => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const isRecording = item.kind === "recording";
  const narrow = boxWidth < 48;
  const label = item.appName;
  const iconSrc = item.appId ? appIconUrl(item.appId, 20) : appNameIconUrl(item.appName, 20);
  const hasIcon = !iconFailed;

  function openMenu(anchor: HTMLElement, point?: { x: number; y: number }) {
    const box = anchor.getBoundingClientRect();
    onMenu(item, anchor, point ?? { x: box.left + Math.min(20, box.width / 2), y: box.top + Math.min(20, box.height / 2) });
  }

  return (
    <div
      className={`tile ${selected ? "is-selected" : ""} ${selecting ? "is-selecting" : ""} ${hasIcon ? "has-app-icon" : ""} ${narrow ? "is-narrow" : ""} ${failed ? "is-failed" : ""}`}
      style={{ width: boxWidth, height: boxHeight }}
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
      </button>

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

      <div className="tile-info" aria-hidden="true">
        <span className="tile-time mono">{formatClock(item.createdAt)}</span>
      </div>

    </div>
  );
}
