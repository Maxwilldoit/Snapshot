import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isWebmEntry, petThumbUrl, petUrl } from "../lib/media";

export type PetMediaElement = HTMLImageElement | HTMLVideoElement;

type PetMediaProps = {
  src: string | null;
  entry: string | null | undefined;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  hidden?: boolean;
  /** WebM 受这里控制；静态待机预览传 false，不会启动解码播放。 */
  playing?: boolean;
  fallback?: ReactNode;
  onReady?: (element: PetMediaElement) => void;
};

/** PetWindow、伴侣舞台和侧栏共用：GIF 走 img，WebM 走静音透明 video。 */
export function PetMedia({
  src,
  entry,
  className,
  style,
  alt = "",
  hidden,
  playing = true,
  fallback = null,
  onReady,
}: PetMediaProps) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const video = isWebmEntry(entry);

  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (hidden || !playing) {
      if (!element.paused) element.pause();
      return;
    }
    const started = element.play();
    if (started) void started.catch(() => {});
  }, [entry, hidden, playing, src]);

  if (!src || failed) return <>{fallback}</>;

  if (video) {
    return (
      <video
        ref={videoRef}
        className={className}
        style={style}
        src={src}
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        preload={playing ? "auto" : "metadata"}
        disablePictureInPicture
        disableRemotePlayback
        hidden={hidden}
        aria-label={alt || undefined}
        onLoadedData={(event) => {
          const element = event.currentTarget;
          if (!playing) {
            try {
              element.currentTime = 0.001;
            } catch {
              // 元数据尚未稳定时保持首帧即可。
            }
          }
          onReady?.(element);
        }}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <img
      className={className}
      style={style}
      src={src}
      alt={alt}
      hidden={hidden}
      draggable={false}
      onLoad={(event) => onReady?.(event.currentTarget)}
      onError={() => setFailed(true)}
    />
  );
}

/** 形象架/静态侧栏：GIF 用后端首帧，WebM 用暂停视频显示首帧。 */
export function PetThumb({
  assetId,
  entry,
  className,
  fallback,
}: {
  assetId: string;
  entry: string | null | undefined;
  className?: string;
  fallback?: ReactNode;
}) {
  if (isWebmEntry(entry)) {
    return (
      <PetMedia
        src={petUrl(assetId, entry)}
        entry={entry}
        className={className}
        playing={false}
        fallback={fallback}
      />
    );
  }
  return <PetMedia src={petThumbUrl(assetId)} entry={entry} className={className} playing={false} fallback={fallback} />;
}
