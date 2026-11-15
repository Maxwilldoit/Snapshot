/** Complete, newest-first date index. Dates are local day starts, not sample data. */
export type TimelineStop = { key: string; timestamp: number };

type TimelineTick = { ratio: number; index: number; major: boolean };

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function timelineDateRatio(stops: TimelineStop[], timestamp: number): number {
  const newest = stops[0]?.timestamp ?? timestamp;
  const span = newest - (stops.at(-1)?.timestamp ?? newest);
  return span > 0 ? clamp((newest - timestamp) / span) : 0;
}

/** Gaps select the nearest real date; ties prefer the newer record. O(log days). */
export function nearestTimelineDate(stops: TimelineStop[], ratio: number): number {
  if (stops.length < 2) return 0;
  const target = stops[0].timestamp + clamp(ratio) * (stops[stops.length - 1].timestamp - stops[0].timestamp);
  let low = 0;
  let high = stops.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (stops[middle].timestamp > target) low = middle + 1;
    else high = middle;
  }
  return low > 0 && stops[low - 1].timestamp - target <= target - stops[low].timestamp ? low - 1 : low;
}

/** Even time intervals, bounded by viewport space rather than record count. */
export function sampleTimeline(stops: TimelineStop[], height: number): TimelineTick[] {
  if (!stops.length || height <= 0) return [];
  const count = Math.min(64, Math.max(2, Math.floor(height / 12) + 1));
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return { ratio, index: nearestTimelineDate(stops, ratio), major: index % 4 === 0 || index === count - 1 };
  });
}

/** Cached layout only: native scrolling never walks the date DOM. */
export function timelineScrollPosition(stops: TimelineStop[], offsets: number[], top: number, max: number) {
  if (!stops.length || max <= 0) return { index: 0, ratio: 0 };
  if (top >= max - 0.5) return { index: stops.length - 1, ratio: 1 };
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (offsets[middle] <= top + 0.5) low = middle;
    else high = middle - 1;
  }
  const index = Math.min(low, stops.length - 1);
  if (stops.length === 1) return { index, ratio: clamp(top / max) };
  const next = Math.min(index + 1, stops.length - 1);
  const start = index === 0 ? 0 : offsets[index];
  const end = Math.min(offsets[next], max);
  const progress = end > start ? clamp((top - start) / (end - start)) : 0;
  const timestamp = stops[index].timestamp + progress * (stops[next].timestamp - stops[index].timestamp);
  return { index, ratio: timelineDateRatio(stops, timestamp) };
}
