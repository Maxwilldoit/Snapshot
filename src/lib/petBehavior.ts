import type {
  PetAsset,
  PetBehaviorManifest,
  PetBehaviorSleep,
  PetEvent,
  PetPersistentState,
} from "../types";
import {
  DSH_CHEEK_HIT_ENTRY,
  DSH_FOREHEAD_HIT_ENTRY,
  DSH_HEADTOP_HIT_ENTRY,
  DSH_OUCH_HIT_ENTRY,
  DSH_SIT_HIT_ENTRY,
  isBuiltinHurtEntry,
} from "./petHurtExpression";

export interface PetBehaviorMove {
  entry: string;
  minDistance: number;
  maxDistance: number;
  leadMs: number;
  tailMs: number;
}

export interface PetBehaviorCategory {
  id: string;
  weight: number;
  entries: string[];
  noMirror?: boolean;
}

interface ResolvedPetInteractions {
  throw: boolean;
  slingshot: boolean;
  sleep: boolean;
}

export interface PetBehavior {
  id: string;
  idle: string[];
  clicks: string[];
  drag: string[];
  hit: string[];
  turn: string[];
  sleep: PetBehaviorSleep | null;
  moves: PetBehaviorMove[];
  categories: PetBehaviorCategory[];
  referenceWidth: number;
  weights: { idle: number; turn: number; move: number; action: number };
  interactions: ResolvedPetInteractions;
  eventActions: Partial<Record<PetEvent, string>>;
  stateActions: Partial<Record<PetPersistentState, string>>;
}

// Action names, categories and parameters adapted from PC2005-cloud/dsh-pet (MIT),
// dsh-pet/assets/config.jsonc. Copyright (c) 2026 PC2005-cloud.
// See THIRD_PARTY_NOTICES.md for source and license.
const DSH_IDLE = ["待机呼吸休闲"];
const DSH_DRAG = ["被鼠标拖拽悬空反馈"];
const DSH_BUILTIN_HITS = [
  DSH_OUCH_HIT_ENTRY,
  DSH_FOREHEAD_HIT_ENTRY,
  DSH_CHEEK_HIT_ENTRY,
  DSH_HEADTOP_HIT_ENTRY,
  DSH_SIT_HIT_ENTRY,
] as const;
const DSH_HIT = ["被吓一跳", "原地重力下蹲压缩", "玩游戏气急败坏", "偷吃零食被抓住"];
const DSH_TURN = ["东张西望"];
const DSH_PRIMARY_CLICKS = [
  "点击回应-开心跃动",
  "点击回应-害羞惊讶",
  "点击回应-傲娇生气",
  "点击回应-挠痒咯咯笑",
  "点击回应-元气挥手",
];
const DSH_EXTRA_CLICKS = ["原地敲击桌面互动"];

const DSH_SLEEP_PRIMARY = {
  start: ["睡觉-开始"],
  loop: ["睡觉-循环"],
  end: ["睡觉-起来"],
} as const;

const DSH_SLEEP_FALLBACK = {
  start: ["哈欠连天"],
  loop: ["原地小憩沉眠"],
  end: ["打瞌睡被惊醒"],
} as const;

const DSH_MOVES: readonly PetBehaviorMove[] = [
  { entry: "螃蟹走路", minDistance: 60, maxDistance: 240, leadMs: 2000, tailMs: 2000 },
  { entry: "原地漂浮踏步", minDistance: 40, maxDistance: 120, leadMs: 2000, tailMs: 2000 },
  { entry: "原地左转奔跑", minDistance: 120, maxDistance: 320, leadMs: 1750, tailMs: 4800 },
];

const DSH_CATEGORIES: readonly PetBehaviorCategory[] = [
  {
    id: "小动作", weight: 20, entries: [
      "悠闲哼歌", "超大伸懒腰", "原地重力下蹲压缩", "哈欠连天",
      "原地小憩沉眠", "女仆屈膝礼仪", "被吓一跳", "小幅度原地360度旋转展示",
      "偷吃零食被抓住", "用鲸鱼尾巴拍打地面", "打瞌睡被惊醒", "照镜子", "整体换装试色",
      "轻快记录", "写代码", "摇扇纳凉", "晨间刷牙",
    ],
  },
  {
    id: "玩耍", weight: 20, entries: [
      "原地专心玩魔方", "原地蹲下玩玩具汽车", "鲸鱼吐泡泡特效", "原地跳跃抓碎头顶物品",
      "玩游戏气急败坏", "玩水枪", "小提琴演奏", "蓝鲸现世", "优雅女仆舞", "轻快摇摆舞",
      "可爱宅舞", "吹气球", "动物环绕", "放风筝", "拆礼物", "变鸽子", "扑克魔术",
      "抽陀螺", "吹笛子", "蝴蝶蜜蜂环绕头顶开花", "撸猫", "凭空生花", "骑木马",
      "三球抛接", "踢毽子", "下五子棋", "荡秋千",
    ],
  },
  {
    id: "吃什么", weight: 16, entries: [
      "吃白饭", "大口吃零食", "吃Token", "吃早餐", "吃午餐", "吃晚餐", "吃冰淇淋融化",
      "吃大闸蟹", "吃糖葫芦", "吃长寿面", "吃西瓜", "涮火锅",
    ],
  },
  {
    id: "时节", weight: 14, entries: [
      "被落叶淹没", "中秋赏月吃月饼", "堆雪人", "放烟花", "吃粽子", "吃年糕", "吃青团",
      "吃腊八粥", "吃重阳糕", "收红包", "写福字", "穿针乞巧", "舞狮头", "讨糖南瓜灯",
      "插茱萸赏菊", "放河灯", "萌化小幽灵", "装点圣诞树", "放孔明灯", "吃汤圆", "吃饺子",
    ],
  },
  { id: "文字", weight: 10, noMirror: true, entries: ["是啊，吃什么", "深度思考碎碎念"] },
];

const DSH_EVENT_ACTIONS: Partial<Record<PetEvent, string>> = {
  "capture.success": "工作状态-雀跃庆祝",
  "capture.failure": "工作状态-垂头叹气冒汗",
  "polish.success": "工作状态-雀跃庆祝",
  "polish.failure": "工作状态-垂头叹气冒汗",
  "recording.stopped": "工作状态-雀跃庆祝",
  "recording.failure": "工作状态-垂头叹气冒汗",
  "shortcuts.resumed": "工作状态-雀跃庆祝",
};

const DSH_STATE_ACTIONS: Partial<Record<PetPersistentState, string>> = {
  recording: "工作状态-忙碌点按",
  "shortcuts-paused": "工作状态-原地踱步张望",
};

/** 只匹配完整 WebM 文件名，目录和显示名称不参与语义识别。 */
function webmName(entry: string): string | null {
  const file = entry.split(/[\\/]/).pop() ?? "";
  return /\.webm$/i.test(file) ? file.slice(0, -5) : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function resolveManifestBehavior(
  asset: Pick<PetAsset, "entry" | "animations" | "eventActions" | "stateActions">,
  manifest: PetBehaviorManifest,
): PetBehavior | null {
  const known = new Map<string, string>();
  for (const entry of [asset.entry, ...asset.animations]) {
    if (!entry) continue;
    const key = normalizePath(entry);
    if (!known.has(key)) known.set(key, entry);
  }
  const filterPool = (pool: readonly string[] | undefined): string[] => {
    if (!pool?.length) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of pool) {
      const resolved = known.get(normalizePath(raw));
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        out.push(resolved);
      }
    }
    return out;
  };

  const idle = filterPool(manifest.idle);
  const drag = filterPool(manifest.drag);
  const clicks = filterPool(manifest.clicks);
  if (!idle.length || !drag.length || !clicks.length) return null;
  if (!(manifest.referenceWidth > 0) || !Number.isFinite(manifest.referenceWidth)) return null;

  let sleep: PetBehaviorSleep | null = null;
  if (manifest.sleep) {
    const start = filterPool(manifest.sleep.start);
    const loop = filterPool(manifest.sleep.loop);
    const end = filterPool(manifest.sleep.end);
    if (start.length && loop.length && end.length) {
      sleep = { start, loop, end };
    }
  }

  const eventActions: Partial<Record<PetEvent, string>> = {};
  for (const [key, raw] of Object.entries(asset.eventActions ?? {}) as Array<[PetEvent, string | undefined]>) {
    const resolved = raw ? known.get(normalizePath(raw)) : undefined;
    if (resolved) eventActions[key] = resolved;
  }
  const stateActions: Partial<Record<PetPersistentState, string>> = {};
  for (const [key, raw] of Object.entries(asset.stateActions ?? {}) as Array<[PetPersistentState, string | undefined]>) {
    const resolved = raw ? known.get(normalizePath(raw)) : undefined;
    if (resolved) stateActions[key] = resolved;
  }

  const knownByWebm = new Map<string, string>();
  for (const entry of [asset.entry, ...asset.animations]) {
    const name = webmName(entry);
    if (name !== null && !knownByWebm.has(name)) knownByWebm.set(name, entry);
  }
  const explicitHit = filterPool(manifest.hit);
  const fallbackDshHits = DSH_HIT.flatMap((name) => {
    const entry = knownByWebm.get(name);
    return entry === undefined ? [] : [entry];
  });
  const hit = explicitHit.length
    ? explicitHit
    : manifest.id === "dsh-pet"
      ? [...DSH_BUILTIN_HITS, ...fallbackDshHits]
      : fallbackDshHits;

  return {
    id: manifest.id || "custom-behavior",
    idle,
    clicks,
    drag,
    hit,
    turn: filterPool(manifest.turn),
    sleep,
    moves: (manifest.moves ?? []).flatMap((move) => {
      const resolved = known.get(normalizePath(move.entry));
      return resolved ? [{ ...move, entry: resolved }] : [];
    }),
    categories: (manifest.categories ?? [])
      .map((category) => ({
        id: category.id,
        weight: category.weight,
        ...(category.noMirror ? { noMirror: true } : {}),
        entries: filterPool(category.entries),
      }))
      .filter((category) => category.entries.length > 0),
    referenceWidth: manifest.referenceWidth,
    weights: { ...manifest.weights },
    interactions: {
      throw: Boolean(manifest.interactions?.throw),
      slingshot: Boolean(manifest.interactions?.slingshot),
      sleep: Boolean(manifest.interactions?.sleep) && sleep !== null,
    },
    eventActions,
    stateActions,
  };
}

/** 优先读取素材包 pet.json 随包导入的声明式 behavior；未声明时按内置 DSH 特征保守识别。 */
export function resolvePetBehavior(
  asset: Pick<PetAsset, "entry" | "animations" | "behavior" | "eventActions" | "stateActions"> | null | undefined,
): PetBehavior | null {
  if (!asset) return null;
  if (asset.behavior) {
    return resolveManifestBehavior(asset, asset.behavior);
  }

  const entries = new Map<string, string>();
  // entry 也是素材中已知的默认动画；保留传入的完整路径供调用方播放。
  for (const entry of [asset.entry, ...asset.animations]) {
    const name = webmName(entry);
    if (name !== null && !entries.has(name)) entries.set(name, entry);
  }
  const available = (names: readonly string[]): string[] =>
    names.flatMap((name) => {
      const entry = entries.get(name);
      return entry === undefined ? [] : [entry];
    });

  const idle = available(DSH_IDLE);
  const drag = available(DSH_DRAG);
  const primaryClicks = available(DSH_PRIMARY_CLICKS);
  if (!idle.length || !drag.length || primaryClicks.length < 2) return null;
  const clicks = [...primaryClicks, ...available(DSH_EXTRA_CLICKS)];

  const resolveSleepSet = (set: { readonly start: readonly string[]; readonly loop: readonly string[]; readonly end: readonly string[] }): PetBehaviorSleep | null => {
    const start = available(set.start);
    const loop = available(set.loop);
    const end = available(set.end);
    return start.length && loop.length && end.length ? { start, loop, end } : null;
  };
  const sleep = resolveSleepSet(DSH_SLEEP_PRIMARY) ?? resolveSleepSet(DSH_SLEEP_FALLBACK);

  const resolveActions = <T extends string>(actions: Partial<Record<T, string>>): Partial<Record<T, string>> => {
    const result: Partial<Record<T, string>> = {};
    for (const key of Object.keys(actions) as T[]) {
      const name = actions[key];
      const entry = name === undefined ? undefined : entries.get(name);
      if (entry !== undefined) result[key] = entry;
    }
    return result;
  };

  return {
    id: "dsh-pet",
    idle,
    clicks,
    drag,
    hit: [...DSH_BUILTIN_HITS, ...available(DSH_HIT)],
    turn: available(DSH_TURN),
    sleep,
    moves: DSH_MOVES.flatMap((move) => {
      const entry = entries.get(move.entry);
      return entry === undefined ? [] : [{ ...move, entry }];
    }),
    categories: DSH_CATEGORIES
      .map((category) => ({ ...category, entries: available(category.entries) }))
      .filter((category) => category.entries.length > 0),
    referenceWidth: 462,
    weights: { idle: 60, turn: 5, move: 5, action: 30 },
    interactions: {
      throw: true,
      slingshot: true,
      sleep: sleep !== null,
    },
    eventActions: resolveActions(DSH_EVENT_ACTIONS),
    stateActions: resolveActions(DSH_STATE_ACTIONS),
  };
}

/** 按碰撞边缘挑选受击回应：底部重摔挑跌坐摸头，撞顶挑摸头顶/额角，左右侧撞在三段单手抚头/揉脸动作间轮换。 */
export function pickPetHitEntry(
  behavior: PetBehavior,
  edge: "left" | "right" | "ceiling" | "floor",
  current?: string | null,
  random: () => number = Math.random,
): string | null {
  if (!behavior.hit.length) return null;
  const builtinHits = behavior.hit.filter(isBuiltinHurtEntry);
  const source = builtinHits.length ? builtinHits : behavior.hit;
  const preferred = source.filter((entry) => {
    if (edge === "floor") return /sit|floor|重力|下蹲|压缩|squash|land/i.test(entry);
    if (edge === "ceiling") return /ouch|headtop|forehead|重力|下蹲|压缩/i.test(entry);
    return !/sit|floor|下蹲|squash/i.test(entry);
  });
  return pickPetEntry(preferred.length ? preferred : source, current, random);
}
/** 等概率抽取；有其它候选时避开当前动作，单候选仍可重播，空池返回 null。 */
export function pickPetEntry(
  pool: readonly string[],
  current?: string | null,
  random: () => number = Math.random,
): string | null {
  if (!pool.length) return null;
  const alternatives = pool.filter((entry) => entry !== current);
  const candidates = alternatives.length ? alternatives : pool;
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

/** 先按分类权重抽，再在类内避开当前动作；朝右排除文字类，无可用分类则退回待机。 */
export function pickPetBehaviorAction(
  behavior: PetBehavior,
  facing: "left" | "right",
  current?: string | null,
  random: () => number = Math.random,
): string | null {
  const categories = behavior.categories.filter((category) =>
    category.entries.length > 0 && Number.isFinite(category.weight) && category.weight > 0
    && !(facing === "right" && category.noMirror),
  );
  if (!categories.length) return pickPetEntry(behavior.idle, current, random);

  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0);
  let roll = random() * totalWeight;
  for (const category of categories) {
    if (roll < category.weight) return pickPetEntry(category.entries, current, random);
    roll -= category.weight;
  }
  return pickPetEntry(categories[categories.length - 1].entries, current, random);
}
