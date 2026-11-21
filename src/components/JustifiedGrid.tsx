import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aspectOf, justify, JUSTIFY_GAP, targetRowHeight } from "../lib/gallery";

let lastMeasuredGridWidth = 0;

export function getLastMeasuredGridWidth(): number {
  return lastMeasuredGridWidth;
}

export function setLastMeasuredGridWidth(width: number): void {
  if (width > 0) lastMeasuredGridWidth = width;
}

type JustifiedRowLayout = {
  widths: number[];
  height: number;
  top: number;
  startIndex: number;
};

export type JustifiedGridLayout = {
  rows: JustifiedRowLayout[];
  totalHeight: number;
};

export type VisibleVerticalRange = {
  top: number;
  bottom: number;
};

export const OFFSCREEN_VERTICAL_RANGE: VisibleVerticalRange = { top: -1, bottom: -1 };

export function computeJustifiedGridLayout<T>(
  items: T[],
  size: (item: T) => { width: number; height: number },
  width: number,
): JustifiedGridLayout | null {
  if (width <= 0) return null;
  if (items.length === 0) return { rows: [], totalHeight: 0 };
  const ratios = items.map((item) => {
    const { width: w, height: h } = size(item);
    return aspectOf(w, h);
  });
  const rawRows = justify(ratios, width);
  const rows: JustifiedRowLayout[] = [];
  let top = 0;
  let startIndex = 0;
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    rows.push({ widths: row.widths, height: row.height, top, startIndex });
    top += row.height + JUSTIFY_GAP;
    startIndex += row.widths.length;
  }
  const totalHeight = rows.length > 0 ? top - JUSTIFY_GAP : 0;
  return { rows, totalHeight };
}

/** 将同一天的一组截图/录屏排成同行等高、整行对齐的自适应拼图；窗口改宽时自动重排。 */
function JustifiedGridInner<T>({
  items,
  size,
  render,
  startIndex = 0,
  layout: externalLayout,
  visibleRange,
}: {
  items: T[];
  size: (item: T) => { width: number; height: number };
  render: (item: T, box: { width: number; height: number }, slot: number) => ReactNode;
  startIndex?: number;
  layout?: JustifiedGridLayout | null;
  visibleRange?: VisibleVerticalRange;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasExternalLayout = externalLayout !== undefined;
  const [width, setWidth] = useState(lastMeasuredGridWidth);

  useLayoutEffect(() => {
    if (hasExternalLayout) return;
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = Math.floor(node.clientWidth);
      if (next > 0) lastMeasuredGridWidth = next;
      setWidth((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasExternalLayout]);

  const internalLayout = useMemo(
    () => (hasExternalLayout ? null : computeJustifiedGridLayout(items, size, width)),
    [hasExternalLayout, items, size, width],
  );
  const layout = hasExternalLayout ? externalLayout : internalLayout;

  if (layout) {
    const { rows: allRows, totalHeight } = layout;
    if (!visibleRange) {
      return (
        <div className="jgrid" ref={ref} style={{ gap: JUSTIFY_GAP }}>
          {allRows.map((row, rowIndex) => (
            <div className="jrow" key={rowIndex} style={{ gap: JUSTIFY_GAP, height: row.height }}>
              {row.widths.map((w, col) => {
                const idx = row.startIndex + col;
                return render(items[idx], { width: w, height: row.height }, startIndex + idx);
              })}
            </div>
          ))}
        </div>
      );
    }

    if (visibleRange.bottom < 0 || visibleRange.top > totalHeight || allRows.length === 0) {
      return <div className="jgrid" ref={ref} style={{ gap: JUSTIFY_GAP, height: totalHeight }} />;
    }

    let startRow = 0;
    while (startRow < allRows.length && allRows[startRow].top + allRows[startRow].height < visibleRange.top) {
      startRow++;
    }
    let endRow = startRow;
    while (endRow < allRows.length && allRows[endRow].top <= visibleRange.bottom) {
      endRow++;
    }

    if (startRow >= endRow) {
      return <div className="jgrid" ref={ref} style={{ gap: JUSTIFY_GAP, height: totalHeight }} />;
    }

    const topPad = allRows[startRow].top;
    const visibleRows: ReactNode[] = [];
    for (let r = startRow; r < endRow; r++) {
      const row = allRows[r];
      visibleRows.push(
        <div className="jrow" key={r} style={{ gap: JUSTIFY_GAP, height: row.height, flexShrink: 0 }}>
          {row.widths.map((w, col) => {
            const idx = row.startIndex + col;
            return render(items[idx], { width: w, height: row.height }, startIndex + idx);
          })}
        </div>,
      );
    }

    return (
      <div
        className="jgrid"
        ref={ref}
        style={{ gap: JUSTIFY_GAP, height: totalHeight, paddingTop: topPad, boxSizing: "border-box" }}
      >
        {visibleRows}
      </div>
    );
  }

  const height = targetRowHeight(0);
  return (
    <div className="jgrid" ref={ref} style={{ gap: JUSTIFY_GAP }}>
      <div className="jrow is-wrap" style={{ gap: JUSTIFY_GAP }}>
        {items.map((item, index) => {
          const { width: w, height: h } = size(item);
          const ratio = aspectOf(w, h);
          return render(item, { width: Math.max(48, Math.round(ratio * height)), height }, startIndex + index);
        })}
      </div>
    </div>
  );
}

export const JustifiedGrid = memo(JustifiedGridInner) as typeof JustifiedGridInner;
