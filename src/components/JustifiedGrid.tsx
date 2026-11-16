import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { aspectOf, justify, zoomGap, ZOOM_ROW_HEIGHTS, DEFAULT_ZOOM } from "../lib/justify";

/** 一组截图排成两端对齐的几行（同「照片」）。容器宽度或缩放档位变了就重排 */
export function JustifiedGrid<T>({
  items,
  size,
  render,
  zoom = DEFAULT_ZOOM,
}: {
  items: T[];
  size: (item: T) => { width: number; height: number };
  render: (item: T, box: { width: number; height: number }) => ReactNode;
  zoom?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const target = ZOOM_ROW_HEIGHTS[Math.max(0, Math.min(ZOOM_ROW_HEIGHTS.length - 1, zoom))];
  const gap = zoomGap(target);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const ratios = items.map((item) => {
    const { width: w, height: h } = size(item);
    return aspectOf(w, h);
  });

  let rows: ReactNode;
  if (width > 0) {
    let index = 0;
    rows = justify(ratios, width, gap, target).map((row, rowIndex) => (
      <div className="jrow" key={rowIndex} style={{ gap }}>
        {row.widths.map((w) => {
          const item = items[index++];
          return render(item, { width: w, height: row.height });
        })}
      </div>
    ));
  } else {
    // 量不到宽度（测试环境、首帧）：按目标行高自然换行
    rows = (
      <div className="jrow is-wrap" style={{ gap }}>
        {items.map((item, index) => render(item, { width: Math.round(ratios[index] * target), height: target }))}
      </div>
    );
  }

  return <div className={`jgrid ${gap === 0 ? "is-flush" : ""}`} ref={ref}>{rows}</div>;
}
