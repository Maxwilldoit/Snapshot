import { useState } from "react";
import { Camera, Check, Copy, PenLine, Trash2, Video } from "lucide-react";
import { recordingUrl, thumbUrl } from "../lib/media";
import { formatClock, formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { MediaItem, RecordingMeta } from "../lib/mediaTimeline";

/**
 * 时间线上的一格：截图或录屏。封面铺满格子，平时只露左下角的类型标记（录屏再加右下角时长）；
 * 悬停或聚焦时底部浮出窗口名和时间，右上角浮出复制/标注/删除，左上角的勾选圈进入多选。
 * 窄长的竖图给一个最小宽度，整张图居中放在浅底上，不裁成一条缝。
 */
export function MediaTile({
  item,
  boxWidth,
  boxHeight,
  selecting = false,
  selected = false,
  onOpen,
  onCheck,
  onCopy,
  onAnnotate,
  onDelete,
  onMeta,
}: {
  item: MediaItem;
  boxWidth: number;
  boxHeight: number;
  selecting?: boolean;
  selected?: boolean;
  onOpen: (item: MediaItem, event: React.MouseEvent) => void;
  onCheck: (item: MediaItem, event: React.MouseEvent) => void;
  onCopy?: (item: MediaItem) => void;
  onAnnotate?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
  onMeta?: (id: string, meta: RecordingMeta) => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const isRecording = item.kind === "recording";
  const narrow = boxWidth < 48;
  const label = item.appName;

  return (
    <div
      className={`tile ${selected ? "is-selected" : ""} ${selecting ? "is-selecting" : ""} ${narrow ? "is-narrow" : ""} ${failed ? "is-failed" : ""}`}
      style={{ width: boxWidth, height: boxHeight }}
    >
      <button
        type="button"
        className="tile-main"
        data-thumb-id={item.id}
        aria-label={selecting ? t("选择：{label}", { label }) : t("放大：{label}", { label })}
        aria-pressed={selecting ? selected : undefined}
        onClick={(event) => onOpen(item, event)}
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
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth && video.videoHeight) {
                onMeta?.(item.id, {
                  width: video.videoWidth,
                  height: video.videoHeight,
                  durationMs: Math.round(video.duration * 1000),
                });
              }
            }}
          />
        ) : (
          !failed && (
            <img src={thumbUrl(item.id)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
          )
        )}
      </button>

      <span className="tile-type" aria-hidden="true">
        {isRecording ? <Video /> : <Camera />}
      </span>
      {isRecording && item.durationMs != null && (
        <span className="tile-duration mono">{formatDuration(item.durationMs)}</span>
      )}

      <div className="tile-info" aria-hidden="true">
        <span className="tile-name">{label}</span>
        <span className="tile-time mono">{formatClock(item.createdAt)}</span>
      </div>

      <button
        type="button"
        className="tile-check"
        aria-label={t("选择：{label}", { label })}
        aria-pressed={selected}
        onClick={(event) => onCheck(item, event)}
      >
        {selected && <Check aria-hidden="true" />}
      </button>

      <div className="tile-actions">
        {!isRecording && (
          <>
            <button type="button" className="tile-action" aria-label={t("复制")} title={t("复制")} onClick={() => onCopy?.(item)}>
              <Copy aria-hidden="true" />
            </button>
            <button type="button" className="tile-action" aria-label={t("标注")} title={t("标注")} onClick={() => onAnnotate?.(item)}>
              <PenLine aria-hidden="true" />
            </button>
          </>
        )}
        <button type="button" className="tile-action is-danger" aria-label={t("删除")} title={t("删除")} onClick={() => onDelete?.(item)}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}