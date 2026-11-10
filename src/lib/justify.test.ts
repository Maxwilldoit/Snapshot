import { describe, expect, it } from "vitest";
import { aspectOf, justify, JUSTIFY_GAP, targetRowHeight } from "./justify";

describe("justified screenshot rows", () => {
  it("fills every full row edge to edge and keeps the original order", () => {
    const ratios = [16 / 9, 4 / 3, 1, 21 / 9, 0.5, 16 / 10, 3 / 2, 16 / 9, 1, 2, 16 / 9];
    const width = 900;
    const rows = justify(ratios, width);
    expect(rows.flatMap((row) => row.widths)).toHaveLength(ratios.length);
    rows.slice(0, -1).forEach((row) => {
      const total = row.widths.reduce((sum, w) => sum + w, 0) + (row.widths.length - 1) * JUSTIFY_GAP;
      expect(total).toBe(width);
    });
  });

  it("keeps row heights near the target and never stretches a lone last image", () => {
    const rows = justify([16 / 9], 1200);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(targetRowHeight(1200));
    expect(rows[0].widths[0]).toBeLessThan(1200);
  });

  it("clamps missing and extreme sizes", () => {
    expect(aspectOf(0, 0)).toBeCloseTo(16 / 9);
    expect(aspectOf(100, 10_000)).toBe(0.25);
    expect(aspectOf(10_000, 100)).toBe(6);
  });
});
