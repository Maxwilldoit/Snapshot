import { describe, expect, it } from "vitest";
import {
  DEAD_ZONE_SPEED,
  estimateThrowVelocity,
  landingSquash,
  slingshotLaunchVelocity,
  SQ_MAX_SQUASH,
  stepThrow,
  trimPointerTrail,
} from "./petThrowPhysics";

describe("petThrowPhysics", () => {
  it("慢拖或停顿后松手返回 null（温柔放下），快速甩动估算合理初速", () => {
    expect(estimateThrowVelocity([], 100)).toBeNull();
    // 慢拖 < DEAD_ZONE_SPEED
    expect(
      estimateThrowVelocity(
        [
          { t: 0, x: 100, y: 100 },
          { t: 100, x: 120, y: 100 },
        ],
        105,
      ),
    ).toBeNull();

    // 快速甩完但停顿超过 150ms 再松手 => 原地放下
    expect(
      estimateThrowVelocity(
        [
          { t: 0, x: 0, y: 0 },
          { t: 40, x: 120, y: -60 },
        ],
        250,
      ),
    ).toBeNull();

    // 快速向右上甩出
    const velocity = estimateThrowVelocity(
      [
        { t: 0, x: 100, y: 300 },
        { t: 16, x: 140, y: 270 },
        { t: 32, x: 210, y: 220 },
      ],
      36,
    );
    expect(velocity).not.toBeNull();
    expect(velocity!.vx).toBeGreaterThan(DEAD_ZONE_SPEED);
    expect(velocity!.vy).toBeLessThan(0);
  });

  it("弹弓发射速度与拉距成正比，方向与拉向严格相反", () => {
    // 往左下（pullX < 0, pullY > 0）拉弓，发射方向应朝右上（vx > 0, vy < 0）
    const near = slingshotLaunchVelocity(-60, 60, 120)!;
    const far = slingshotLaunchVelocity(-120, 120, 120)!;
    expect(near.vx).toBeGreaterThan(0);
    expect(near.vy).toBeLessThan(0);
    expect(Math.hypot(far.vx, far.vy)).toBeCloseTo(Math.hypot(near.vx, near.vy) * 2, 4);
  });

  it("抛体在四壁工作区内反弹并在地面摩擦停稳", () => {
    const bounds = { minX: 0, maxX: 400, minY: 0, maxY: 300 };
    let state = { x: 380, y: 100, vx: 900, vy: -600 };
    let hitRight = false;
    let hitCeiling = false;
    let hitFloor = false;
    let rested = false;

    for (let i = 0; i < 600; i += 1) {
      const next = stepThrow(state, 1 / 60, bounds, true);
      if (next.hit?.edge === "right") hitRight = true;
      if (next.hit?.edge === "ceiling") hitCeiling = true;
      if (next.hit?.edge === "floor") hitFloor = true;
      state = next;
      if (next.atRest) {
        rested = true;
        break;
      }
    }

    expect(hitRight).toBe(true);
    expect(hitCeiling).toBe(true);
    expect(hitFloor).toBe(true);
    expect(rested).toBe(true);
    expect(state.y).toBe(bounds.maxY);
    expect(state.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(state.x).toBeLessThanOrEqual(bounds.maxX);
  });

  it("trimPointerTrail 裁剪过期采样，landingSquash 随冲击速度单调下压", () => {
    const trimmed = trimPointerTrail(
      [
        { t: 10, x: 0, y: 0 },
        { t: 150, x: 10, y: 0 },
        { t: 250, x: 20, y: 0 },
      ],
      260,
    );
    expect(trimmed).toHaveLength(2);
    expect(landingSquash(100)).toBeCloseTo(0.8, 5);
    expect(landingSquash(2000)).toBeCloseTo(SQ_MAX_SQUASH, 5);
  });
});
