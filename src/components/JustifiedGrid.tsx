import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { aspectOf, justify, JUSTIFY_GAP, targetRowHeight } from "../lib/gallery";

/** 将同一天的一组截图/录屏排成同行等高、整行对齐的自适应拼图；窗口改宽时自动重排。 */
export function JustifiedGrid<T>({
  items,
  size,
  render,
}: {
  items: T[];
  size: (item: T) => { width: number; height: number };
  render: (item: T, box: { width: number; height: number }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

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
    rows = justify(ratios, width).map((row, rowIndex) => (
      <div className="jrow" key={rowIndex} style={{ gap: JUSTIFY_GAP }}>
        {row.widths.map((w) => {
          const item = items[index++];
          return render(item, { width: w, height: row.height });
        })}
      </div>
    ));
  } else {
    const height = targetRowHeight(0);
    rows = (
      <div className="jrow is-wrap" style={{ gap: JUSTIFY_GAP }}>
        {items.map((item, index) =>
          render(item, { width: Math.max(48, Math.round(ratios[index] * height)), height }),
        )}
      </div>
    );
  }

  return (
    <div className="jgrid" ref={ref} style={{ gap: JUSTIFY_GAP }}>
      {rows}
    </div>
  );
}
