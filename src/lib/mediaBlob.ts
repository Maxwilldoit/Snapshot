import { useEffect, useState } from "react";

/**
 * Linux 的 WebKitGTK（GStreamer）播不了自定义 media:// 协议上的音视频，
 * 报 MEDIA_ERR_SRC_NOT_SUPPORTED；同一份字节换成 blob: 地址就能播。
 * 图片不受影响，macOS（WKWebView）和 Windows（http://media.localhost）也不受影响，
 * 所以只在 Linux 上、只对 media:// 地址绕一道 Blob。
 */
export function needsBlobMedia(src: string): boolean {
  if (!src.startsWith("media:")) return false;
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Linux/.test(agent) && !/Android/.test(agent);
}

type Entry = { users: number; url: Promise<string>; objectUrl: string | null };

const entries = new Map<string, Entry>();

/**
 * 取一个能直接播的地址：需要时 fetch 成 Blob 再给 object URL，同一地址共用一份。
 * 用完调 release；最后一个用的人松手时撤销 object URL。取不到 Blob 时退回原地址，
 * 让 <video>/<audio> 照常报错走原来的降级。direct 为 true 时不用等，直接用原地址。
 */
export function acquireMediaUrl(src: string): { url: Promise<string>; direct: boolean; release: () => void } {
  if (!needsBlobMedia(src)) return { url: Promise.resolve(src), direct: true, release: () => {} };
  let entry = entries.get(src);
  if (!entry) {
    const created: Entry = { users: 0, url: Promise.resolve(src), objectUrl: null };
    created.url = fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => {
        if (entries.get(src) !== created) return src;
        created.objectUrl = URL.createObjectURL(blob);
        return created.objectUrl;
      })
      .catch(() => {
        // 失败的不缓存，下次再用时重新取
        if (entries.get(src) === created && created.users === 0) entries.delete(src);
        return src;
      });
    entries.set(src, created);
    entry = created;
  }
  const held = entry;
  held.users += 1;
  let released = false;
  return {
    url: held.url,
    direct: false,
    release: () => {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users > 0 || entries.get(src) !== held) return;
      entries.delete(src);
      if (held.objectUrl) URL.revokeObjectURL(held.objectUrl);
    },
  };
}

/** React 版：不需要绕的地址原样返回；需要时先返回 null，Blob 准备好后换成 blob: 地址。 */
export function usePlayableMediaUrl(src: string | null, enabled = true): string | null {
  const wrap = Boolean(src && enabled && needsBlobMedia(src));
  const [resolved, setResolved] = useState<{ src: string; url: string } | null>(null);
  useEffect(() => {
    if (!wrap || !src) return;
    const { url, release } = acquireMediaUrl(src);
    let alive = true;
    void url.then((value) => { if (alive) setResolved({ src, url: value }); });
    return () => {
      alive = false;
      release();
    };
  }, [src, wrap]);
  if (!src) return null;
  if (!wrap) return src;
  return resolved?.src === src ? resolved.url : null;
}
