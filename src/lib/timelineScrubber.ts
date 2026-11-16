/** Complete, newest-first date index. Dates are local day starts, not sample data. */
export type TimelineStop = { key: string; timestamp: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** The axis always spans the full visible height; scroll progress maps onto it
 * continuously regardless of how much the content overflows. */
export function timelineTrackSpan(available: number, max: number): number {
  return available > 0 && max > 0 ? available : 0;
}

/** Decorative ticks share the continuous content axis; tiny overflow needs only
 * one tick. Dates always come from the full cached index, not these samples. */
export function sampleTimeline(height: number): number[] {
  if (height <= 0) return [];
  const count = Math.min(64, Math.floor(height / 12) + 1);
  return Array.from({ length: count }, (_, index) => count === 1 ? 0.5 : index / (count - 1));
}

/** The same continuous wave follows either real scroll progress or a pointer.
 * Distance is measured in tick intervals: 24px -> 17px -> 14px -> 9px. */
export function timelineTickFocus(distance: number) {
  const d = Math.abs(distance);
  // Between ticks, the two nearest lines still form a 22–24px crest.
  const width = d <= 0.5 ? 24 - 4 * d : d <= 1 ? 27 - 10 * d : d <= 2 ? 20 - 3 * d : d < 3 ? 24 - 5 * d : 9;
  return { width, accent: Math.max(0, 1 - d / 2) };
}

/** Cached layout only: native scrolling never walks the date DOM. */
export function timelineScrollPosition(stops: TimelineStop[], offsets: number[], top: number, max: number) {
  if (!stops.length || max <= 0) return { index: 0, ratio: 0 };
  const ratio = clamp(top / max);
  if (ratio === 1) return { index: stops.length - 1, ratio };
  let low = 0;
  let high = Math.min(offsets.length, stops.length) - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (offsets[middle] <= top + 0.5) low = middle;
    else high = middle - 1;
  }
  return { index: low, ratio };
}

/** Adjacent reachable date, including when several final groups share the
 * bottom scroll limit. Searching by scroll offset keeps ArrowUp from sticking. */
export function timelineAdjacentOffset(offsets: number[], top: number, max: number, direction: -1 | 1): number {
  let low = 0;
  let high = offsets.length;
  const threshold = top + direction * 0.5;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (direction === 1 ? offsets[middle] <= threshold : offsets[middle] < threshold) low = middle + 1;
    else high = middle;
  }
  const target = direction === 1 ? offsets[low] ?? max : offsets[low - 1] ?? 0;
  return Math.max(0, Math.min(max, target));
}
