import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isWebmEntry, petAlphaUrl } from "../lib/media";
import { usePlayableMediaUrl } from "../lib/mediaBlob";
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

/** PetWindow、伴侣舞台和素材库共用：GIF 走 img，WebM 走静音透明 video。 */
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
  // macOS 走 MacPetVideo（另取透明通道），其余平台的 WebM 在 Linux 上要先换成 blob: 地址
  const macVideo = video && src !== null && petAlphaUrl(src) !== null;
  const videoSrc = usePlayableMediaUrl(src, video && !macVideo);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !videoSrc) return;
    if (hidden || !playing) {
      if (!element.paused) element.pause();
      return;
    }
    const started = element.play();
    if (started) void started.catch(() => errorRef.current?.());
  }, [entry, hidden, playing, loop, src, videoSrc]);

  if (!src || failed) return <>{fallback}</>;

  if (video) {
    const alphaSrc = petAlphaUrl(src);
    if (alphaSrc) return <MacPetVideo key={src} src={src} alphaSrc={alphaSrc} entry={entry}
      className={className} style={style} alt={alt} hidden={hidden} playing={playing} loop={loop}
      onReady={onReady} onEnded={onEnded} onError={() => { setFailed(true); onError?.(); }} />;
    // Blob 还在取（本地文件，通常一帧内就好）
    if (!videoSrc) return null;
    return (
      <video
        ref={videoRef}
        className={className}
        style={style}
        src={videoSrc}
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
