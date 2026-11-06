import { useEffect, useRef, useState } from "react";
import { applyPetAlpha, registerPetAlpha } from "../lib/petVideoAlpha";
import type { PetMediaProps } from "./PetMedia";

const interrupted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Keep the real video as the playback clock; only its pixels need a WebKit fallback. */
export function MacPetVideo({
  src, alphaSrc, className, style, hidden, alt, playing = true, loop = true, onReady, onEnded, onError,
}: PetMediaProps & { src: string; alphaSrc: string }) {
  const colourRef = useRef<HTMLVideoElement>(null);
  const alphaRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const playback = useRef({ hidden, playing });
  playback.current = { hidden, playing };
  const [opaque, setOpaque] = useState(false);

  useEffect(() => {
    const colour = colourRef.current;
    const alpha = alphaRef.current;
    const canvas = canvasRef.current;
    if (!colour || !alpha || !canvas) return;
    const mask = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const maskContext = mask.getContext("2d", { willReadFrequently: true });
    if (!context || !maskContext) { callbacks.current.onError?.(); return; }
    const unregister = registerPetAlpha(colour, canvas);
    let disposed = false;
    let nativeOnly = false;
    let reported = false;
    let frame: number | null = null;
    let animation: number | null = null;
    let lastDraw = -Infinity;
    const abort = new AbortController();
    const readers = new Set<FileReader>();

    const ready = () => {
      if (reported || disposed) return;
      reported = true;
      callbacks.current.onReady?.(colour);
    };
    const fail = (error?: unknown) => { if (!disposed && !interrupted(error)) callbacks.current.onError?.(); };
    const draw = () => {
      if (disposed || colour.readyState < 2) return;
      if (nativeOnly) { ready(); return; }
      if (alpha.readyState < 2 || colour.seeking || alpha.seeking) return;
      // Never combine a newly sought colour frame with the old opacity frame.
      if (Math.abs(colour.currentTime - alpha.currentTime) > 0.08) {
        alpha.currentTime = colour.currentTime;
        return;
      }
      const { videoWidth: width, videoHeight: height } = colour;
      if (!(width > 0 && height > 0) || width !== alpha.videoWidth || height !== alpha.videoHeight) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = mask.width = width;
        canvas.height = mask.height = height;
      }
      try {
        context.clearRect(0, 0, width, height);
        context.drawImage(colour, 0, 0, width, height);
        maskContext.drawImage(alpha, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        applyPetAlpha(pixels.data, maskContext.getImageData(0, 0, width, height).data);
        context.putImageData(pixels, 0, 0);
        ready();
      } catch { fail(); }
    };
    const schedule = () => {
      if (disposed || nativeOnly || colour.paused || frame !== null || animation !== null) return;
      if (typeof colour.requestVideoFrameCallback === "function") {
        frame = colour.requestVideoFrameCallback(() => { frame = null; draw(); schedule(); });
      } else {
        animation = requestAnimationFrame((now) => {
          animation = null;
          if (now - lastDraw >= 1000 / 30) { lastDraw = now; draw(); }
          schedule();
        });
      }
    };
    const sync = () => {
      if (disposed) return;
      if (nativeOnly) { draw(); return; }
      if (alpha.readyState >= 1 && Math.abs(colour.currentTime - alpha.currentTime) > 0.02) {
        alpha.currentTime = colour.currentTime;
      }
      if (colour.paused) alpha.pause();
      else if (alpha.paused) void alpha.play().catch(fail);
      draw();
      schedule();
    };
    const nativeFallback = () => {
      // A regular, opaque WebM legitimately has no BlockAdditional plane.
      nativeOnly = true;
      unregister();
      alpha.pause();
      setOpaque(true);
      if (colour.readyState >= 2) ready();
    };
    const loaded = () => {
      sync();
      if (!playback.current.hidden && playback.current.playing && colour.paused) void colour.play().catch(fail);
    };
    const listeners: Array<[EventTarget, string, () => void]> = [
      [colour, "loadeddata", loaded], [alpha, "loadeddata", sync],
      [colour, "play", sync], [colour, "pause", sync],
      [colour, "seeking", sync], [colour, "seeked", sync], [alpha, "seeked", draw],
      [alpha, "error", nativeFallback], [colour, "error", fail],
    ];
    for (const [target, event, listener] of listeners) target.addEventListener(event, listener);
    // WebKit taints both media:// videos and blob:tauri:// videos in packaged
    // apps. Data URLs remain origin-clean in both development and production.
    const load = async (url: string, video: HTMLVideoElement) => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`Pet video: ${response.status}`);
      const blob = await response.blob();
      if (disposed) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        readers.add(reader);
        reader.onload = () => { readers.delete(reader); resolve(reader.result as string); };
        reader.onerror = () => { readers.delete(reader); reject(reader.error); };
        reader.onabort = () => { readers.delete(reader); reject(new DOMException("Pet video disposed", "AbortError")); };
        reader.readAsDataURL(blob);
      });
      if (!disposed) video.src = dataUrl;
    };
    void load(src, colour).catch(fail);
    void load(alphaSrc, alpha).catch(() => { if (!disposed) nativeFallback(); });
    return () => {
      disposed = true;
      abort.abort();
      for (const reader of readers) reader.abort();
      unregister();
      for (const [target, event, listener] of listeners) target.removeEventListener(event, listener);
      if (frame !== null) colour.cancelVideoFrameCallback(frame);
      if (animation !== null) cancelAnimationFrame(animation);
      alpha.pause();
      alpha.removeAttribute("src");
      alpha.load();
      colour.pause();
      colour.removeAttribute("src");
      colour.load();
    };
  }, [src, alphaSrc]);

  useEffect(() => {
    const video = colourRef.current;
    if (!video) return;
    let cancelled = false;
    if (hidden || !playing) { if (!video.paused) video.pause(); }
    else if (video.getAttribute("src")) void video.play().catch((error) => {
      if (!cancelled && !interrupted(error)) callbacks.current.onError?.();
    });
    return () => { cancelled = true; };
  }, [hidden, playing, loop]);

  return <>
    <video
      ref={colourRef}
      className={[className, !opaque && "pet-alpha-colour"].filter(Boolean).join(" ")}
      style={style}
      crossOrigin="anonymous"
      muted loop={loop} playsInline preload="auto"
      disablePictureInPicture disableRemotePlayback
      hidden={hidden} aria-label={alt || undefined}
      onEnded={(event) => onEnded?.(event.currentTarget)}
    />
    <video
      ref={alphaRef} className="pet-alpha-mask"
      crossOrigin="anonymous" muted loop={loop} playsInline preload="auto"
      disablePictureInPicture disableRemotePlayback aria-hidden="true"
    />
    <canvas ref={canvasRef} className={className} style={style} hidden={hidden || opaque} aria-hidden="true" />
  </>;
}
