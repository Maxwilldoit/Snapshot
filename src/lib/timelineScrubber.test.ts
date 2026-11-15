import { describe, expect, it } from "vitest";
import { sampleTimeline, timelineAdjacentOffset, timelineScrollPosition, timelineTrackSpan, type TimelineStop } from "./timelineScrubber";

const stops: TimelineStop[] = [
  { key: "new", timestamp: new Date(2026, 7, 15).getTime() },
  { key: "middle", timestamp: new Date(2026, 7, 5).getTime() },
  { key: "old", timestamp: new Date(2020, 6, 16).getTime() },
];

describe("content-based date navigation", () => {
  it("scales axis travel to overflow without amplifying short-list movement", () => {
    expect(timelineTrackSpan(480, 500, 0)).toBe(0);
    expect(timelineTrackSpan(480, 500, 20)).toBeCloseTo(18.46, 2);
    expect(timelineTrackSpan(480, 500, 500)).toBe(240);
    expect(timelineTrackSpan(480, 500, 4500)).toBe(432);
    expect(timelineTrackSpan(480, 500, 1_000_000)).toBeLessThan(480);
    expect(timelineTrackSpan(480, 0, 100)).toBe(0);
    expect(timelineTrackSpan(0, 500, 100)).toBe(0);
    expect(timelineTrackSpan(1000, 100, 20)).toBe(20);
  });

  it("bounds decorative ticks by the actual axis length", () => {
    expect(sampleTimeline(0)).toEqual([]);
    expect(sampleTimeline(1)).toEqual([0.5]);
    expect(sampleTimeline(24)).toEqual([0, 0.5, 1]);
    expect(sampleTimeline(240)).toHaveLength(21);
    expect(sampleTimeline(480)).toHaveLength(41);
    expect(sampleTimeline(4000)).toHaveLength(64);
  });

  it("maps dates through cached content offsets while position follows scroll progress", () => {
    const offsets = [12, 800, 1700];
    expect(timelineScrollPosition(stops, offsets, 0, 2000)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops, offsets, 800, 2000)).toEqual({ index: 1, ratio: 0.4 });
    expect(timelineScrollPosition(stops, offsets, 1250, 2000)).toEqual({ index: 1, ratio: 0.625 });
    expect(timelineScrollPosition(stops, offsets, 1850, 2000)).toEqual({ index: 2, ratio: 0.925 });
    expect(timelineScrollPosition(stops, offsets, 1999.9, 2000).ratio).toBeCloseTo(0.99995);
    expect(timelineScrollPosition(stops, offsets, 2000, 2000)).toEqual({ index: 2, ratio: 1 });
  });

  it("keeps sparse years, long final days and unreachable final headings continuous", () => {
    const offsets = [0, 40, 80];
    const positions = Array.from({ length: 101 }, (_, top) => timelineScrollPosition(stops, offsets, top, 100));
    expect(positions.every((position, index) => position.ratio === index / 100)).toBe(true);
    const nearEnd = timelineScrollPosition(stops, [0, 80, 120], 99.9, 100);
    expect(nearEnd.index).toBe(1);
    expect(nearEnd.ratio).toBeCloseTo(0.999);
    expect(timelineScrollPosition(stops, [0, 80, 120], 100, 100)).toEqual({ index: 2, ratio: 1 });
  });

  it("can leave the bottom by keyboard when several dates clamp to the same limit", () => {
    const offsets = [12, 60, 120, 180];
    expect(timelineAdjacentOffset(offsets, 0, 100, 1)).toBe(12);
    expect(timelineAdjacentOffset(offsets, 60, 100, 1)).toBe(100);
    expect(timelineAdjacentOffset(offsets, 100, 100, -1)).toBe(60);
    expect(timelineAdjacentOffset(offsets, 60, 100, -1)).toBe(12);
    expect(timelineAdjacentOffset(offsets, 12, 100, -1)).toBe(0);
    expect(timelineAdjacentOffset([0, 50, 50, 150], 50, 100, 1)).toBe(100);
    expect(timelineAdjacentOffset([0, 50, 50, 150], 50, 100, -1)).toBe(0);
  });

  it("searches the entire date index even with 50,000 dates and only 64 ticks", () => {
    const long = Array.from({ length: 50_000 }, (_, index) => ({ key: String(index), timestamp: Date.UTC(2026, 7, 15) - index * 86_400_000 }));
    const offsets = long.map((_, index) => index * 100);
    expect(sampleTimeline(4000)).toHaveLength(64);
    expect(timelineScrollPosition(long, offsets, 2_499_950, 5_000_000).index).toBe(24_999);
    expect(timelineAdjacentOffset(offsets, 2_499_950, 5_000_000, 1)).toBe(2_500_000);
  });

  it("supports empty, single-day and out-of-range positions", () => {
    expect(timelineScrollPosition([], [], 500, 1000)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops, [0, 10, 20], 0, 0)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops.slice(0, 1), [0], 500, 1000)).toEqual({ index: 0, ratio: 0.5 });
    expect(timelineScrollPosition(stops, [0, 10, 20], -50, 100)).toEqual({ index: 0, ratio: 0 });
    expect(timelineScrollPosition(stops, [0, 10, 20], 150, 100)).toEqual({ index: 2, ratio: 1 });
  });
});
