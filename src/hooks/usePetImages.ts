import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { petUrl, petWalkUrl } from "../lib/media";
import type { PetMediaElement } from "../components/PetMedia";

/** 新画面准备好后，旧画面在上层短暂淡出，避免 GIF 从半途硬切回首帧。 */
export const PET_IMAGE_FADE_MS = 180;

export interface PetImageFrame {
  key: string;
  assetId: string;
  entry: string | null;
  src: string;
  walk: boolean;
  flip: boolean;
}

export function petImageFrame(assetId: string, entry: string | null, walk = false, flip = false, pulse = 0): PetImageFrame {
  return {
    key: JSON.stringify([assetId, entry, walk, flip, pulse]),
    assetId,
    entry,
    src: walk && entry ? petWalkUrl(assetId, entry) : petUrl(assetId, entry),
    walk,
    flip,
  };
}

/** 保留正在显示的节点，下一张在同一容器中加载、解码完成后才交接。 */
export function usePetImages(target: PetImageFrame | null, preload: PetImageFrame[]) {
  const [active, setActive] = useState<PetImageFrame | null>(null);
  const [previous, setPrevious] = useState<PetImageFrame | null>(null);
  const latestTarget = useRef(target);
  const activeRef = useRef<PetImageFrame | null>(null);
  const fadeTimer = useRef<number | undefined>(undefined);
  latestTarget.current = target;
  const ready = useRef(new Map<string, PetMediaElement>());
  const displayed = active?.assetId === target?.assetId ? active : null;
  const leaving = previous && previous.assetId === target?.assetId && previous.key !== displayed?.key
    ? previous
    : null;
  // 只保留当前动作、左右走路和交接前的旧画面，不把整包 GIF 一直挂在内存里。
  // 顺序不能随 displayed / leaving / preload 的角色变化：重插现有 img 会重启动画，
  // 甚至让仍在等待下一张解码的旧图从透明首帧重新开始。用稳定的 key 顺序保留原节点。
  const frames = [...new Map(
    [...(leaving ? [leaving] : []), ...preload, ...(target ? [target] : []), ...(displayed ? [displayed] : [])]
      .map((frame) => [frame.key, frame] as const),
  ).values()].sort((a, b) => a.key.localeCompare(b.key));

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);

  function show(frame: PetImageFrame) {
    const current = activeRef.current;
    if (current?.key === frame.key) return;
    window.clearTimeout(fadeTimer.current);
    if (current && current.assetId === frame.assetId) {
      setPrevious(current);
      fadeTimer.current = window.setTimeout(() => setPrevious(null), PET_IMAGE_FADE_MS);
    } else {
      setPrevious(null);
    }
    activeRef.current = frame;
    setActive(frame);
  }

  useLayoutEffect(() => {
    for (const [key, image] of ready.current) {
      if (!image.isConnected) ready.current.delete(key);
    }
    if (target && ready.current.get(target.key)?.isConnected) {
      show(target);
    } else if (active && active.assetId !== target?.assetId) {
      window.clearTimeout(fadeTimer.current);
      activeRef.current = null;
      setPrevious(null);
      setActive(null);
    }
  });

  async function onReady(frame: PetImageFrame, element: PetMediaElement) {
    if (element instanceof HTMLImageElement) {
      try {
        await element.decode?.();
      } catch {
        // 某些 WebView 的 GIF decode 会拒绝，但 load 后已有可显示的首帧。
        if (!element.complete || element.naturalWidth === 0) return;
      }
    } else if (element.readyState < 2) {
      return;
    }
    // 快速切换后，旧请求即使晚到也不能把新动作顶掉。
    if (!element.isConnected) return;
    ready.current.set(frame.key, element);
    if (latestTarget.current?.key === frame.key) show(frame);
  }

  return { frames, displayed, leaving, onReady };
}
