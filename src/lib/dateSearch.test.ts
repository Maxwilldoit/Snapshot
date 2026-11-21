import { describe, expect, it } from "vitest";
import { appIdSearchName, matchesDateQuery, matchesSearchEntry } from "./dateSearch";

describe("dateSearch", () => {
  const now = new Date(2026, 10, 21, 18, 40).getTime();
  const nov21 = new Date(2026, 10, 21, 14, 30).getTime();
  const nov20 = new Date(2026, 10, 20, 9, 15).getTime();
  const nov05 = new Date(2026, 10, 5, 11, 0).getTime();
  const may11 = new Date(2026, 4, 11, 8, 20).getTime();
  const dec03_2025 = new Date(2025, 11, 3, 22, 5).getTime();

  it("matches numeric day, month, compact, and separated date queries", () => {
    expect(matchesDateQuery(nov21, "21", now)).toBe(true);
    expect(matchesDateQuery(nov20, "21", now)).toBe(false);

    expect(matchesDateQuery(nov21, "11", now)).toBe(true);
    expect(matchesDateQuery(may11, "11", now)).toBe(true);
    expect(matchesDateQuery(dec03_2025, "11", now)).toBe(false);

    expect(matchesDateQuery(nov21, "1121", now)).toBe(true);
    expect(matchesDateQuery(nov20, "1121", now)).toBe(false);
    expect(matchesDateQuery(nov05, "115", now)).toBe(true);
    expect(matchesDateQuery(nov05, "1105", now)).toBe(true);

    expect(matchesDateQuery(nov21, "11-21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "11/21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "11.21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "11 21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "11月21日", now)).toBe(true);
    expect(matchesDateQuery(nov21, "11月21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "2026-11-21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "20261121", now)).toBe(true);
    expect(matchesDateQuery(nov21, "261121", now)).toBe(true);
    expect(matchesDateQuery(dec03_2025, "2025", now)).toBe(true);
    expect(matchesDateQuery(nov21, "2025", now)).toBe(false);
    expect(matchesDateQuery(nov21, "14:30", now)).toBe(true);
  });

  it("matches relative day words without falsely matching ordinary letters", () => {
    expect(matchesDateQuery(nov21, "今天", now)).toBe(true);
    expect(matchesDateQuery(nov20, "昨天", now)).toBe(true);
    expect(matchesDateQuery(nov21, "today", now)).toBe(true);
    expect(matchesDateQuery(nov20, "yesterday", now)).toBe(true);
    expect(matchesDateQuery(nov21, "nov 21", now)).toBe(true);
    expect(matchesDateQuery(nov21, "a", now)).toBe(false);
    expect(matchesDateQuery(nov21, "相", now)).toBe(false);
  });

  it("supports app name, date, and combined app+date search without splitting standalone dates", () => {
    expect(matchesSearchEntry(nov21, ["相册", appIdSearchName("com.apple.Photos")], "相", now)).toBe(true);
    expect(matchesSearchEntry(nov21, ["相册", appIdSearchName("com.apple.Photos")], "photos", now)).toBe(true);
    expect(matchesSearchEntry(nov21, ["相册", appIdSearchName("com.apple.Photos")], "com", now)).toBe(false);
    expect(matchesSearchEntry(nov21, ["访达"], "相", now)).toBe(false);
    expect(matchesSearchEntry(nov21, ["相册"], "相 21", now)).toBe(true);
    expect(matchesSearchEntry(nov20, ["相册"], "相 21", now)).toBe(false);

    // 独立日期 "11 11" 不能拆成两个 "11" 误匹配 5 月 11 日
    expect(matchesSearchEntry(may11, ["访达"], "11 11", now)).toBe(false);
    expect(matchesSearchEntry(may11, ["访达"], "5 11", now)).toBe(true);
  });
});
