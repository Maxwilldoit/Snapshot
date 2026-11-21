import { describe, expect, it } from "vitest";
import { justify, JUSTIFY_GAP } from "./gallery";

function rowWidth(widths: number[], gap = JUSTIFY_GAP) {
  return widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * gap;
}

describe("justify gallery layout", () => {
  it("fills the full row width when a day has two landscape screenshots", () => {
    const rows = justify([1.55, 1.55], 820);
    expect(rows).toHaveLength(1);
    expect(rowWidth(rows[0].widths)).toBe(820);
    expect(rows[0].height).toBeGreaterThan(220);
  });

  it("keeps a single screenshot at a comfortable size without stretching across the whole width", () => {
    const rows = justify([1.6], 820);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeLessThanOrEqual(240);
    expect(rowWidth(rows[0].widths)).toBeLessThan(500);
  });

  it("avoids leaving a single orphan tile on a five-item day", () => {
    const rows = justify([1.78, 1.78, 1.41, 1.6, 1.71], 820);
    expect(rows.map((row) => row.widths.length)).toEqual([2, 3]);
    expect(rowWidth(rows[0].widths)).toBe(820);
    expect(rowWidth(rows[1].widths)).toBe(820);
  });

  it("caps the height of two narrow portrait screenshots so they never blow up vertically", () => {
    const rows = justify([0.6, 0.6], 820);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeLessThanOrEqual(280);
  });
});
