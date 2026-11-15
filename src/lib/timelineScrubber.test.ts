import { describe, expect, it } from "vitest";
import { nearestTimelineDate, sampleTimeline, timelineDateRatio, timelineScrollPosition, type TimelineStop } from "./timelineScrubber";

const stops: TimelineStop[] = [
  { key: "new", timestamp: new Date(2026, 7, 15).getTime() },
  { key: "middle", timestamp: new Date(2026, 7, 5).getTime() },
  { key: "old", timestamp: new Date(2026, 6, 16).getTime() },
];

describe("date navigation index", () => {
  it("samples the real time range and resolves gaps to the closest existing date", () => {
    expect(nearestTimelineDate(stops, 0)).toBe(0);
    expect(nearestTimelineDate(stops, 1)).toBe(2);
    expect(nearestTimelineDate(stops, 0.5)).toBe(1);
    expect(nearestTimelineDate(stops, 2 / 3)).toBe(1); // equal distances prefer newer
    expect(nearestTimelineDate(stops, 0.8)).toBe(2);
    expect(timelineDateRatio(stops, stops[1].timestamp)).toBeCloseTo(1 / 3);
    const ticks = sampleTimeline(stops, 360);
    expect(ticks[0]).toMatchObject({ ratio: 0, index: 0 });
    expect(ticks.at(-1)).toMatchObject({ ratio: 1, index: 2 });
    expect(ticks.every((tick) => stops[tick.index])).toBe(true);
  });

  it("adapts to available height and stays bounded across 50,000 real dates", () => {
    const long = Array.from({ length: 50_000 }, (_, index) => ({ key: String(index), timestamp: Date.UTC(2026, 7, 15) - index * 86_400_000 }));
    expect(sampleTimeline(long, 240)).toHaveLength(21);
    expect(sampleTimeline(long, 480)).toHaveLength(41);
    expect(sampleTimeline(long, 4000)).toHaveLength(64);
    const ticks = sampleTimeline(long, 480);
    expect(ticks.map((tick) => tick.index)).toEqual([...ticks.map((tick) => tick.index)].sort((a, b) => a - b));
    expect(ticks.at(-1)?.index).toBe(49_999);
    expect(nearestTimelineDate(long, 0.5)).toBe(24_999);
  });

  it("uses cached content offsets for scroll synchronization, including both ends", () => {
    const offsets = [12, 800, 1700];
    expect(timelineScrollPosition(stops, offsets, 0, 2000)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops, offsets, 800, 2000)).toEqual({ index: 1, ratio: 1 / 3 });
    expect(timelineScrollPosition(stops, offsets, 1250, 2000)).toEqual({ index: 1, ratio: 2 / 3 });
    expect(timelineScrollPosition(stops, offsets, 2000, 2000)).toEqual({ index: 2, ratio: 1 });
  });

  it("supports empty, short, single-day and out-of-range positions", () => {
    expect(sampleTimeline([], 360)).toEqual([]);
    expect(sampleTimeline(stops, 0)).toEqual([]);
    expect(sampleTimeline(stops, 1)).toHaveLength(2);
    expect(nearestTimelineDate([], 0.5)).toBe(0);
    expect(nearestTimelineDate(stops, -1)).toBe(0);
    expect(nearestTimelineDate(stops, 3)).toBe(2);
    expect(timelineScrollPosition(stops, [0, 10, 20], 0, 0)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops.slice(0, 1), [0], 500, 1000)).toEqual({ index: 0, ratio: 0.5 });
    expect(sampleTimeline(stops.slice(0, 1), 240).every((tick) => tick.index === 0)).toBe(true);
  });
});
