import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes, formatCalendarDate, formatClock, formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { appIconUrl, appNameIconUrl, recordingUrl, snapshotUrl, thumbUrl } from "../lib/media";
import type { MediaItem, RecordingMeta } from "../lib/mediaTimeline";

export type HoverPreviewAnchor = {
  item: MediaItem;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  pointerX?: number;
};

type HoverPreviewBox = {
  side: "left" | "right";
  left: number;
  top: number;
  cardWidth: number;
  stageWidth: number;
  mediaWidth: number;
  mediaHeight: number;
  hasRealDims: boolean;
};

const MARGIN = 12;
const GAP = 12;
const PAD = 6;
const FOOTER_H = 26;
const MIN_CARD_W = 228;
const MAX_CARD_W = 760;

/**
 * 计算悬停无损预览窗的左右方位与尺寸：
 * - 优先放在缩略图左/右空间更宽裕的一侧，严丝合缝避开被悬停卡片本身；
 * - 若单张超宽图占满整行，则放到远离鼠标指针的一侧，保证绝不遮挡光标；
 * - 小尺寸截图按 1:1 原始像素呈现不放大糊化，大图在可用空间内完整等比展示。
 */
export function computeHoverPreviewBox(
  anchor: HoverPreviewAnchor,
  viewport: { width: number; height: number },
): HoverPreviewBox {
  const vw = Math.max(320, viewport.width);
  const vh = Math.max(240, viewport.height);
  const { item, rect } = anchor;

  const rightSpace = vw - rect.right - GAP - MARGIN;
  const leftSpace = rect.left - GAP - MARGIN;
  const tileSideAvailable = Math.max(rightSpace, leftSpace) >= 260;

  let side: "left" | "right";
  let availWidth: number;
  if (tileSideAvailable) {
    side = rightSpace >= leftSpace ? "right" : "left";
    availWidth = Math.min(MAX_CARD_W, side === "right" ? rightSpace : leftSpace);
  } else {
    const px = anchor.pointerX ?? (rect.left + rect.right) / 2;
    const rightFromCursor = vw - px - 24 - MARGIN;
    const leftFromCursor = px - 24 - MARGIN;
    side = rightFromCursor >= leftFromCursor ? "right" : "left";
    availWidth = Math.max(
      MIN_CARD_W,
      Math.min(MAX_CARD_W, Math.floor(vw * 0.56), side === "right" ? rightFromCursor : leftFromCursor),
    );
  }

  const isPlaceholderRecording = item.kind === "recording" && item.width <= 16 && item.height <= 9;
  const hasRealDims = !isPlaceholderRecording && item.width > 0 && item.height > 0;
  const natW = isPlaceholderRecording ? 1280 : Math.max(1, item.width || 1280);
  const natH = isPlaceholderRecording ? 720 : Math.max(1, item.height || 800);

  const maxMediaW = Math.max(120, availWidth - PAD * 2);
  const maxMediaH = Math.max(120, vh - MARGIN * 2 - FOOTER_H - PAD * 2);
  const scale = Math.min(maxMediaW / natW, maxMediaH / natH, 1);

  const mediaWidth = Math.max(48, Math.round(natW * scale));
  const mediaHeight = Math.max(36, Math.round(natH * scale));
  const stageWidth = Math.max(MIN_CARD_W - PAD * 2, mediaWidth);
  const cardWidth = stageWidth + PAD * 2;
  const cardHeight = mediaHeight + PAD * 2 + FOOTER_H;

  let left: number;
  if (tileSideAvailable) {
    left = side === "right" ? rect.right + GAP : rect.left - GAP - cardWidth;
    left = Math.max(MARGIN, Math.min(vw - MARGIN - cardWidth, left));
  } else {
    left = side === "right" ? vw - MARGIN - cardWidth : MARGIN;
  }

  const centerY = (rect.top + rect.bottom) / 2;
  const top = Math.max(MARGIN, Math.min(vh - MARGIN - cardHeight, centerY - cardHeight / 2));

  return {
    side,
    left: Math.round(left),
    top: Math.round(top),
    cardWidth,
    stageWidth,
    mediaWidth,
    mediaHeight,
    hasRealDims,
  };
}

/** 历史缩略图悬停无损预览窗：在左/右侧即时浮出原图（或录屏静音预览），底部仅附带分辨率、格式、体积与拍摄时间。 */
export function HoverPreview({
  anchor,
  onMeta,
}: {
  anchor: HoverPreviewAnchor;
  onMeta?: (id: string, meta: RecordingMeta) => void;
}) {
  const { language } = useI18n();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [iconFailedId, setIconFailedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 960,
    height: typeof window !== "undefined" ? window.innerHeight : 600,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { item } = anchor;
  const isRecording = item.kind === "recording";
  const box = computeHoverPreviewBox(anchor, viewport);
  const ext = isRecording
    ? "MP4"
    : (item.fileName.split(".").pop()?.toUpperCase() || "PNG");

  const specs: string[] = [];
  if (box.hasRealDims) specs.push(`${item.width} × ${item.height}`);
  if (isRecording && item.durationMs != null) specs.push(formatDuration(item.durationMs));
  specs.push(ext);
  specs.push(formatBytes(item.sizeBytes));

  const fullLoaded = loadedId === item.id;
  const iconSrc = item.appId ? appIconUrl(item.appId, 16) : appNameIconUrl(item.appName, 16);
  const showIcon = iconFailedId !== item.id;

  return createPortal(
    <div
      className="hover-preview"
      data-side={box.side}
      role="tooltip"
      style={{ left: box.left, top: box.top, width: box.cardWidth }}
    >
      <div className="hover-preview-stage" style={{ width: box.stageWidth, height: box.mediaHeight }}>
        {isRecording ? (
          <video
            key={item.id}
            className="hover-preview-video"
            src={recordingUrl(item.id)}
            style={{ width: box.mediaWidth, height: box.mediaHeight }}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
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
          <>
            <img
              className="hover-preview-thumb"
              src={thumbUrl(item.id)}
              alt=""
              style={{ width: box.mediaWidth, height: box.mediaHeight }}
              decoding="sync"
            />
            <img
              key={item.id}
              className={`hover-preview-full ${fullLoaded ? "is-loaded" : ""}`}
              src={snapshotUrl(item.id)}
              alt=""
              style={{ width: box.mediaWidth, height: box.mediaHeight }}
              decoding="async"
              onLoad={() => setLoadedId(item.id)}
            />
          </>
        )}
      </div>
      <div className="hover-preview-foot mono">
        <span className="hover-preview-lead">
          {showIcon && (
            <img
              key={item.id}
              className="hover-preview-app-icon"
              src={iconSrc}
              alt=""
              aria-hidden="true"
              decoding="async"
              onError={() => setIconFailedId(item.id)}
            />
          )}
          <span className="hover-preview-specs">{specs.join(" · ")}</span>
        </span>
        <time className="hover-preview-time" dateTime={new Date(item.createdAt).toISOString()}>
          {formatCalendarDate(item.createdAt, Date.now(), language)} {formatClock(item.createdAt)}
        </time>
      </div>
    </div>,
    document.body,
  );
}
