import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isWebmEntry, petAlphaUrl, petThumbUrl, petUrl } from "../lib/media";
import { MacPetVideo } from "./MacPetVideo";

export type PetMediaElement = HTMLImageElement | HTMLVideoElement;

export type PetMediaProps = {
  src: string | null;
  entry: string | null | undefined;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  hidden?: boolean;
  /** WebM 受这里控制；静态待机预览传 false，不会启动解码播放。 */
  playing?: boolean;
  /** Floating companions can play an interaction once; library previews keep looping by default. */
  loop?: boolean;
  fallback?: ReactNode;
  onReady?: (element: PetMediaElement) => void;
  onEnded?: (element: HTMLVideoElement) => void;
  onError?: () => void;
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
  loop = true,
  fallback = null,
  onReady,
  onEnded,
  onError,
}: PetMediaProps) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const video = isWebmEntry(entry);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (hidden || !playing) {
      if (!element.paused) element.pause();
      return;
    }
    const started = element.play();
    if (started) void started.catch(() => errorRef.current?.());
  }, [entry, hidden, playing, loop, src]);

  if (!src || failed) return <>{fallback}</>;

  if (video) {
    const alphaSrc = petAlphaUrl(src);
    if (alphaSrc) return <MacPetVideo key={src} src={src} alphaSrc={alphaSrc} entry={entry}
      className={className} style={style} alt={alt} hidden={hidden} playing={playing} loop={loop}
      onReady={onReady} onEnded={onEnded} onError={() => { setFailed(true); onError?.(); }} />;
    return (
      <video
        ref={videoRef}
        className={className}
        style={style}
        src={src}
        crossOrigin="anonymous"
        muted
        loop={loop}
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
        onEnded={(event) => onEnded?.(event.currentTarget)}
        onError={() => { setFailed(true); onError?.(); }}
      />
    );
  }

  return (
    <img
      className={className}
      style={style}
      src={src}
      crossOrigin="anonymous"
      alt={alt}
      hidden={hidden}
      draggable={false}
      onLoad={(event) => onReady?.(event.currentTarget)}
      onError={() => { setFailed(true); onError?.(); }}
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
