import { useLayoutEffect, useRef, useState } from "react";
import { petUrl, petWalkUrl } from "../lib/media";

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
  const latestTarget = useRef(target);
  latestTarget.current = target;
  const ready = useRef(new Map<string, HTMLImageElement>());
  const displayed = active?.assetId === target?.assetId ? active : null;
  // 只保留当前动作、左右走路和交接前的旧画面，不把整包 GIF 一直挂在内存里。
  const frames = [...new Map(
    [...preload, ...(target ? [target] : []), ...(displayed ? [displayed] : [])]
      .map((frame) => [frame.key, frame] as const),
  ).values()];

  useLayoutEffect(() => {
    for (const [key, image] of ready.current) {
      if (!image.isConnected) ready.current.delete(key);
    }
    if (target && ready.current.get(target.key)?.isConnected) {
      if (active?.key !== target.key) setActive(target);
    } else if (active && active.assetId !== target?.assetId) {
      setActive(null);
    }
  });

  async function onLoad(frame: PetImageFrame, image: HTMLImageElement) {
    try {
      await image.decode?.();
    } catch {
      // 某些 WebView 的 GIF decode 会拒绝，但 load 后已有可显示的首帧。
      if (!image.complete || image.naturalWidth === 0) return;
    }
    // 快速切换后，旧请求即使晚到也不能把新动作顶掉。
    if (!image.isConnected) return;
    ready.current.set(frame.key, image);
    if (latestTarget.current?.key === frame.key) setActive(frame);
  }

  return { frames, displayed, onLoad };
}
