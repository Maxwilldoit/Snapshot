import { memo, useState } from "react";
import { appIconUrl, appNameIconUrl, recordingUrl, thumbUrl } from "../lib/media";
import { formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { MediaItem, RecordingMeta } from "../lib/mediaTimeline";

/**
 * 历史拼图中的一格：按给定 boxWidth × boxHeight 完整铺满同行等高格位。
 * 普通横竖图严丝合缝铺满圆角卡片；超长滚动截图（is-narrow）居中衬底完整呈现，不裁成细条。
 * 左下角显示来源应用图标，录屏右下角显示时长；拍摄时间与规格统一在悬停预览窗展示。
 */
export const MediaTile = memo(function MediaTile({
  item,
  boxWidth,
  boxHeight,
  selecting = false,
  selected = false,
  onOpen,
  onMenu,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
  onMeta,
}: {
  item: MediaItem;
  boxWidth?: number;
  boxHeight?: number;
  selecting?: boolean;
  selected?: boolean;
  onOpen: (item: MediaItem, event: React.MouseEvent) => void;
  onMenu: (item: MediaItem, anchor: HTMLElement, point: { x: number; y: number }) => void;
  onHoverStart?: (item: MediaItem, anchor: HTMLElement, pointerX?: number) => void;
  onHoverMove?: (pointerX: number) => void;
  onHoverEnd?: (item: MediaItem) => void;
  onMeta?: (id: string, meta: RecordingMeta) => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const isRecording = item.kind === "recording";
  const rawRatio = item.width > 0 && item.height > 0 ? item.width / item.height : 16 / 9;
  const narrow = rawRatio < 0.34 || (typeof boxWidth === "number" && boxWidth < 52);
  const label = item.appName;
  const iconSrc = item.appId ? appIconUrl(item.appId, 20) : appNameIconUrl(item.appName, 20);
  const hasIcon = !iconFailed;

  function openMenu(anchor: HTMLElement, point?: { x: number; y: number }) {
    const box = anchor.getBoundingClientRect();
    onMenu(item, anchor, point ?? { x: box.left + Math.min(20, box.width / 2), y: box.top + Math.min(20, box.height / 2) });
  }

  const sizeStyle = typeof boxWidth === "number" && typeof boxHeight === "number"
    ? { width: boxWidth, height: boxHeight }
    : undefined;

  return (
    <div
      className={`tile ${selected ? "is-selected" : ""} ${selecting ? "is-selecting" : ""} ${hasIcon ? "has-app-icon" : ""} ${narrow ? "is-narrow" : ""} ${failed ? "is-failed" : ""}`}
      style={sizeStyle}
    >
      <button
        type="button"
        className="tile-main"
        data-thumb-id={item.id}
        aria-label={selecting ? t("选择：{label}", { label }) : t(isRecording ? "播放：{label}" : "标注：{label}", { label })}
        aria-keyshortcuts="Shift+F10"
        aria-pressed={selecting ? selected : undefined}
        onClick={(event) => onOpen(item, event)}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") onHoverStart?.(item, event.currentTarget, event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch") onHoverMove?.(event.clientX);
        }}
        onPointerLeave={() => onHoverEnd?.(item)}
        onFocus={(event) => {
          try {
            if (event.currentTarget.matches(":focus-visible")) onHoverStart?.(item, event.currentTarget);
          } catch { /* unsupported selector */ }
        }}
        onBlur={() => onHoverEnd?.(item)}
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
        <span className="tile-preview">
          {isRecording ? (
            <video
              src={`${recordingUrl(item.id)}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              tabIndex={-1}
              draggable={false}
              onError={() => setFailed(true)}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                  onMeta?.(item.id, {
                    width: video.videoWidth,
                    height: video.videoHeight,
                    durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : item.durationMs ?? 0,
                  });
                }
              }}
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
        </span>
      </button>
    </div>
  );
});
