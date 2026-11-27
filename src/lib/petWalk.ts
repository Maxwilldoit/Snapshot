/**
 * 走路动作：只在向左 / 向右拖动桌宠时播放，不参与点击切换。
 *
 * 靠文件名认：名字里带 walk / run / move（或 走 / 跑）的算走路；
 * 单独写了 left / right（或 左 / 右）朝向的也算，比如 nashor_burrow_left 钻地往左走。
 * 带朝向的就是朝那个方向走。以后导入的包按同样的规则认。
 */

export type PetFacing = "left" | "right";
export type WalkDirection = PetFacing | "up" | "down";

export interface WalkChoice {
  entry: string;
  /** 包里只有反方向的走路动作时，镜像过来用 */
  flip: boolean;
}

function stemOf(entry: string) {
  return (entry.split("/").pop() ?? entry).replace(/\.[^.]+$/, "").toLowerCase();
}

const MOVE_VERB = /walk|run|move|climb|fly|swim|float|走|跑|游|爬|飞/;

/** 名字里有单独的横向朝向词：burrow_left 的 left 算，frightened 里的 right 不算 */
function namesSide(stem: string) {
  return stem.split(/[^a-z]+/).some((word) => word === "left" || word === "right") || /左|右/.test(stem);
}

function namesVertical(stem: string): "up" | "down" | null {
  const words = stem.split(/[^a-z]+/);
  if (words.some((word) => word === "up" || word === "north") || /向上|往上|朝上/.test(stem) || (MOVE_VERB.test(stem) && /上|北/.test(stem))) {
    return "up";
  }
  if (words.some((word) => word === "down" || word === "south") || /向下|往下|朝下/.test(stem) || (MOVE_VERB.test(stem) && /下|南/.test(stem))) {
    return "down";
  }
  return null;
}

export function isWalkEntry(entry: string): boolean {
  const stem = stemOf(entry);
  return MOVE_VERB.test(stem) || namesSide(stem);
}

/** 名字里写明的朝向；没写就是 null（比如 crabwalk，往哪边拖都能用） */
export function walkDirection(entry: string): WalkDirection | null {
  const stem = stemOf(entry);
  if (/left|左/.test(stem)) return "left";
  if (/right|右/.test(stem)) return "right";
  if (MOVE_VERB.test(stem)) {
    const vertical = namesVertical(stem);
    if (vertical) return vertical;
  }
  return null;
}

export function hasVerticalWalkEntries(entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const dir = walkDirection(entry);
    return dir === "up" || dir === "down";
  });
}

/** 根据任意二维速度向量选展示方向：仅当角色有上下行走图或纯竖直移动时才报 up/down。 */
export function vectorWalkDirection(
  dx: number,
  dy: number,
  hasVertical = false,
  fallback: WalkDirection = "left",
): WalkDirection {
  if (hasVertical && Math.abs(dy) > Math.abs(dx)) {
    return dy < 0 ? "up" : "down";
  }
  if (Math.abs(dx) > 1e-3) {
    return dx < 0 ? "left" : "right";
  }
  if (Math.abs(dy) > 1e-3) {
    return dy < 0 ? "up" : "down";
  }
  return fallback;
}

/** 生成无重力全平面漫游的单位方向向量：兼顾纯水平、纯竖直与任意 360° 斜向角度。 */
export function pickWanderVector(
  canX: boolean,
  canY: boolean,
  random: () => number = Math.random,
): { ux: number; uy: number } {
  if (!canX && !canY) return { ux: 0, uy: 0 };
  if (!canY) return { ux: random() < 0.5 ? -1 : 1, uy: 0 };
  if (!canX) return { ux: 0, uy: random() < 0.5 ? -1 : 1 };
  const mode = random();
  if (mode < 0.18) return { ux: random() < 0.5 ? -1 : 1, uy: 0 };
  if (mode < 0.36) return { ux: 0, uy: random() < 0.5 ? -1 : 1 };
  const angle = random() * Math.PI * 2;
  return { ux: Math.cos(angle), uy: Math.sin(angle) };
}

/** 点击切换用的动作：去掉走路的。整包都是走路时就不去了，免得没东西可播 */
export function cycleEntries(entries: string[]): string[] {
  const rest = entries.filter((entry) => !isWalkEntry(entry));
  return rest.length ? rest : entries;
}

/** 两个名字开头有几段相同，用来认同一套装扮（店员的 clerk_idle 和 clerk_walk_left） */
function sharedHead(a: string, b: string) {
  const left = a.split(/[-_\s]+/);
  const right = b.split(/[-_\s]+/);
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

/**
 * 朝某个方向拖时播哪个走路动作。
 * 同方向的优先；没有就把反方向的镜像过来；再没有就用不分方向的。
 * 同一档里先挑和当前动作同一套装扮的，再挑原地走的（名字带 move 的通常是横穿画布的版本），最后挑名字短的。
 */
export function pickWalk(entries: string[], direction: WalkDirection, current: string | null): WalkChoice | null {
  const walks = entries.filter(isWalkEntry);
  const tiers: Array<[string[], boolean]> = direction === "left" || direction === "right"
    ? [
        [walks.filter((entry) => walkDirection(entry) === direction), false],
        [walks.filter((entry) => walkDirection(entry) === (direction === "left" ? "right" : "left")), true],
        [walks.filter((entry) => walkDirection(entry) === null), false],
      ]
    : [
        [walks.filter((entry) => walkDirection(entry) === direction), false],
        [walks.filter((entry) => walkDirection(entry) === null), false],
        [walks.filter((entry) => walkDirection(entry) === "left"), false],
        [walks.filter((entry) => walkDirection(entry) === "right"), false],
      ];
  const reference = current ? stemOf(current) : "";
  const rank = (entry: string) => {
    const stem = stemOf(entry);
    return [sharedHead(stem, reference), /move/.test(stem) ? 0 : 1, -stem.length];
  };
  const better = (a: number[], b: number[]) => {
    const index = a.findIndex((value, position) => value !== b[position]);
    return index >= 0 && a[index] > b[index];
  };
  for (const [candidates, flip] of tiers) {
    if (!candidates.length) continue;
    const entry = candidates.reduce((best, entry) => (better(rank(entry), rank(best)) ? entry : best));
    return { entry, flip };
  }
  return null;
}

export interface DragWalk {
  direction: WalkDirection | null;
  /** 往反方向累计拖了多少像素，够了才转身 */
  backtrack: number;
}

export const STANDING: DragWalk = { direction: null, backtrack: 0 };

/** 往回拖够这么多（物理像素）才转身，手抖一两个像素不来回翻 */
const TURN_AFTER = 4;

/**
 * 拖动时窗口每移动一次，算一下该朝哪边走。
 * 默认主要是上下拖的不算走，返回 null；开启竖向行走时上下拖也更新方向。
 */
export function nextDragWalk(state: DragWalk, dx: number, dy: number, allowVertical = false): DragWalk | null {
  if (!allowVertical) {
    if (dx === 0 || Math.abs(dx) * 2 < Math.abs(dy)) return null;
    const direction: WalkDirection = dx < 0 ? "left" : "right";
    if (state.direction === null || state.direction === direction) return { direction, backtrack: 0 };
    const backtrack = state.backtrack + Math.abs(dx);
    return backtrack >= TURN_AFTER ? { direction, backtrack: 0 } : { direction: state.direction, backtrack };
  }
  if (dx === 0 && dy === 0) return null;
  const vertical = Math.abs(dy) > Math.abs(dx) * 1.5;
  const direction: WalkDirection = vertical ? (dy < 0 ? "up" : "down") : (dx < 0 ? "left" : "right");
  const step = vertical ? Math.abs(dy) : Math.abs(dx);
  if (state.direction === null || state.direction === direction) return { direction, backtrack: 0 };
  const backtrack = state.backtrack + step;
  return backtrack >= TURN_AFTER ? { direction, backtrack: 0 } : { direction: state.direction, backtrack };
}
