import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { aspectOf, justify, JUSTIFY_GAP, targetRowHeight } from "../lib/justify";

/** 一组截图排成两端对齐的几行。容器宽度变了（拖窗口、开关侧栏）就重排 */
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
    // 量不到宽度（测试环境、首帧）：按目标行高自然换行
    const height = targetRowHeight(0);
    rows = (
      <div className="jrow is-wrap" style={{ gap: JUSTIFY_GAP }}>
        {items.map((item, index) => render(item, { width: Math.round(ratios[index] * height), height }))}
      </div>
    );
  }

  return <div className="jgrid" ref={ref}>{rows}</div>;
}
