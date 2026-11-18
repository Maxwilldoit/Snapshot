import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineScrubber, buildTimelineTicks, type TimelineGroupInput } from "./TimelineScrubber";

function makeGroups(days: Array<{ y: number; m: number; d: number; label: string; count?: number }>): TimelineGroupInput[] {
  return days.map(({ y, m, d, label, count = 2 }) => ({
    key: String(new Date(y, m - 1, d).getTime()),
    label,
    items: Array.from({ length: count }, (_, i) => i),
  }));
}

describe("TimelineScrubber tick calculation and interaction", () => {
  it("sparsifies dense ticks while preserving endpoints and month boundaries", () => {
    const manyDays = makeGroups(
      Array.from({ length: 40 }, (_, i) => ({
        y: 2026,
        m: i < 20 ? 11 : 10,
        d: (i % 20) + 1,
        label: `Day ${i}`,
      })),
    );
    const tops = manyDays.map((_, i) => i * 50);
    const { nodes, visibleTicks } = buildTimelineTicks(manyDays, tops, 1500, 120);
    expect(nodes).toHaveLength(40);
    expect(visibleTicks.length).toBeLessThan(20);
    expect(visibleTicks[0].groupIndex).toBe(0);
    expect(visibleTicks[visibleTicks.length - 1].groupIndex).toBe(39);
    expect(visibleTicks.some((tick) => tick.groupIndex === 20 && tick.major)).toBe(true);
  });

  it("hides when content fits without scrolling, and jumps/scrubs when overflowing", () => {
    const groups = makeGroups([
      { y: 2026, m: 11, d: 18, label: "今天", count: 3 },
      { y: 2026, m: 11, d: 10, label: "11 月 10 日", count: 5 },
      { y: 2025, m: 9, d: 1, label: "2025 年 9 月 1 日", count: 2 },
    ]);

    function Harness({ scrollHeight }: { scrollHeight: number }) {
      const scrollRef = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div
            data-testid="scroller"
            ref={(node) => {
              scrollRef.current = node;
              if (node) {
                Object.defineProperty(node, "scrollHeight", { value: scrollHeight, configurable: true });
                Object.defineProperty(node, "clientHeight", { value: 400, configurable: true });
                node.scrollTo = vi.fn(({ top }: { top?: number }) => {
                  if (typeof top === "number") node.scrollTop = top;
                }) as unknown as typeof node.scrollTo;
                const secs = node.querySelectorAll<HTMLElement>("section.day");
                secs.forEach((sec, idx) => {
                  Object.defineProperty(sec, "offsetTop", { value: idx * 500, configurable: true });
                });
              }
            }}
          >
            {groups.map((g) => (
              <section key={g.key} className="day" data-day-key={g.key} />
            ))}
          </div>
          <TimelineScrubber groups={groups} scrollRef={scrollRef} />
        </div>
      );
    }

    const { rerender, container } = render(<Harness scrollHeight={360} />);
    expect(screen.queryByRole("slider", { name: "时间定位" })).toBeNull();

    rerender(<Harness scrollHeight={1400} />);
    fireEvent(window, new Event("resize"));
    const slider = screen.getByRole("slider", { name: "时间定位" });
    const track = container.querySelector<HTMLElement>(".timeline-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(940, 20, 18, 300));

    // 悬停中部浮出对应日期胶囊，点击直达该日期分组顶部
    fireEvent.pointerEnter(slider, { pointerType: "mouse", clientY: 170 });
    expect(container.querySelector(".timeline-pill")?.textContent).toContain("11 月 10 日");
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientY: 170 });
    fireEvent.pointerUp(slider, { pointerId: 1, button: 0, clientY: 170 });
    const scroller = screen.getByTestId("scroller");
    expect(scroller.scrollTop).toBe(496);

    // 按住拖拽线性定位
    fireEvent.pointerDown(slider, { pointerId: 2, button: 0, clientY: 50 });
    fireEvent.pointerMove(slider, { pointerId: 2, clientY: 245 });
    fireEvent.pointerUp(slider, { pointerId: 2, button: 0, clientY: 245 });
    expect(scroller.scrollTop).toBe(750);

    // 键盘 End 直达最早一组
    fireEvent.keyDown(slider, { key: "End" });
    expect(scroller.scrollTop).toBe(996);
  });
});
