import type { PetAsset, PetEvent, PetPersistentState } from "../types";

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

export interface PetBehavior {
  id: string;
  idle: string[];
  clicks: string[];
  drag: string[];
  turn: string[];
  moves: PetBehaviorMove[];
  categories: PetBehaviorCategory[];
  referenceWidth: number;
  weights: { idle: number; turn: number; move: number; action: number };
  eventActions: Partial<Record<PetEvent, string>>;
  stateActions: Partial<Record<PetPersistentState, string>>;
}

// Action names, categories and parameters adapted from PC2005-cloud/dsh-pet (MIT),
// dsh-pet/assets/config.jsonc at 3229ab287d82d7621af2ee51544a0e746c2e40fd.
// Copyright (c) 2026 PC2005-cloud. See THIRD_PARTY_NOTICES.md for source and license.
const DSH_IDLE = ["待机呼吸休闲"];
const DSH_DRAG = ["被鼠标拖拽悬空反馈"];
const DSH_TURN = ["东张西望"];
const DSH_CLICKS = [
  "点击回应-开心跃动",
  "点击回应-害羞惊讶",
  "点击回应-傲娇生气",
  "点击回应-挠痒咯咯笑",
  "点击回应-元气挥手",
];

const DSH_MOVES: readonly PetBehaviorMove[] = [
  { entry: "螃蟹走路", minDistance: 60, maxDistance: 240, leadMs: 2000, tailMs: 2000 },
  { entry: "原地漂浮踏步", minDistance: 40, maxDistance: 120, leadMs: 2000, tailMs: 2000 },
  { entry: "原地左转奔跑", minDistance: 120, maxDistance: 320, leadMs: 1750, tailMs: 4800 },
];

const DSH_CATEGORIES: readonly PetBehaviorCategory[] = [
  {
    id: "小动作", weight: 20, entries: [
      "悠闲哼歌", "超大伸懒腰", "原地敲击桌面互动", "原地重力下蹲压缩", "哈欠连天",
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

/** 以待机 + 悬空拖拽 + 至少两个不同点击回应识别 DSH，缺失的动作一律不补造。 */
export function resolvePetBehavior(
  asset: Pick<PetAsset, "entry" | "animations"> | null | undefined,
): PetBehavior | null {
  if (!asset) return null;

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
  const clicks = available(DSH_CLICKS);
  if (!idle.length || !drag.length || clicks.length < 2) return null;

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
    turn: available(DSH_TURN),
    moves: DSH_MOVES.flatMap((move) => {
      const entry = entries.get(move.entry);
      return entry === undefined ? [] : [{ ...move, entry }];
    }),
    categories: DSH_CATEGORIES
      .map((category) => ({ ...category, entries: available(category.entries) }))
      .filter((category) => category.entries.length > 0),
    referenceWidth: 462,
    weights: { idle: 10, turn: 5, move: 5, action: 80 },
    eventActions: resolveActions(DSH_EVENT_ACTIONS),
    stateActions: resolveActions(DSH_STATE_ACTIONS),
  };
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
