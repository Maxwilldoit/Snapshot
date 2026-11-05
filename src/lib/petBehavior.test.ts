import { describe, expect, it, vi } from "vitest";
import type { PetAsset } from "../types";
import {
  pickPetBehaviorAction,
  pickPetEntry,
  resolvePetBehavior,
  type PetBehavior,
  type PetBehaviorCategory,
} from "./petBehavior";

const IDLE = "待机呼吸休闲";
const DRAG = "被鼠标拖拽悬空反馈";
const CLICKS = [
  "点击回应-开心跃动", "点击回应-害羞惊讶", "点击回应-傲娇生气",
  "点击回应-挠痒咯咯笑", "点击回应-元气挥手",
];
const CELEBRATE = "工作状态-雀跃庆祝";
const FAILURE = "工作状态-垂头叹气冒汗";
const BUSY = "工作状态-忙碌点按";
const PACING = "工作状态-原地踱步张望";
const webm = (name: string) => `${name}.webm`;

// 当前导入包的 106 个视频文件名；来自固定上游配置，许可见 THIRD_PARTY_NOTICES.md。
// 独立保存素材清单，测试不依赖本机设置、上游 checkout 或网络。
const importedNames = `
待机呼吸休闲
三球抛接
下五子棋
东张西望
中秋赏月吃月饼
优雅女仆舞
余额-分文不剩
余额-数金皱眉
余额-袋空如洗
余额-金袋叮当
余额-钱袋如常
余额-钱袋满溢
偷吃零食被抓住
写代码
写福字
凭空生花
动物环绕
原地专心玩魔方
原地小憩沉眠
原地左转奔跑
原地敲击桌面互动
原地漂浮踏步
原地跳跃抓碎头顶物品
原地蹲下玩玩具汽车
原地重力下蹲压缩
变鸽子
可爱宅舞
吃Token
吃冰淇淋融化
吃午餐
吃大闸蟹
吃年糕
吃早餐
吃晚餐
吃汤圆
吃白饭
吃粽子
吃糖葫芦
吃腊八粥
吃西瓜
吃重阳糕
吃长寿面
吃青团
吃饺子
吹气球
吹笛子
哈欠连天
堆雪人
大口吃零食
女仆屈膝礼仪
小幅度原地360度旋转展示
小提琴演奏
工作状态-原地踱步张望
工作状态-垂头叹气冒汗
工作状态-忙碌点按
工作状态-思考冒泡
工作状态-清点归档
工作状态-雀跃庆祝
悠闲哼歌
扑克魔术
打瞌睡被惊醒
抽陀螺
拆礼物
插茱萸赏菊
摇扇纳凉
撸猫
收红包
放孔明灯
放河灯
放烟花
放风筝
整体换装试色
是啊，吃什么
晨间刷牙
涮火锅
深度思考碎碎念
点击回应-傲娇生气
点击回应-元气挥手
点击回应-害羞惊讶
点击回应-开心跃动
点击回应-挠痒咯咯笑
照镜子
玩水枪
玩游戏气急败坏
用鲸鱼尾巴拍打地面
碎碎念-发呆碎碎念
碎碎念-对屏碎碎念
碎碎念-擦桌碎碎念
穿针乞巧
舞狮头
荡秋千
萌化小幽灵
蓝鲸现世
蝴蝶蜜蜂环绕头顶开花
螃蟹走路
被吓一跳
被落叶淹没
被鼠标拖拽悬空反馈
装点圣诞树
讨糖南瓜灯
超大伸懒腰
踢毽子
轻快摇摆舞
轻快记录
骑木马
鲸鱼吐泡泡特效
`.trim().split(/\s+/);

function assetFromNames(names: readonly string[]): Pick<PetAsset, "entry" | "animations"> {
  const animations = names.map(webm);
  return { entry: animations[0] ?? "", animations };
}

const imported = assetFromNames(importedNames);
const minimal = assetFromNames([IDLE, DRAG, CLICKS[0], CLICKS[1]]);

function resolved(asset = imported): PetBehavior {
  const behavior = resolvePetBehavior(asset);
  expect(behavior).not.toBeNull();
  return behavior!;
}

function allEntries(behavior: PetBehavior): string[] {
  return [
    ...behavior.idle, ...behavior.clicks, ...behavior.drag, ...behavior.turn,
    ...behavior.moves.map((move) => move.entry),
    ...behavior.categories.flatMap((category) => category.entries),
    ...Object.values(behavior.eventActions), ...Object.values(behavior.stateActions),
  ];
}

describe("DSH 动作语义识别", () => {
  it("识别实际 106 视频包，保留点击顺序、分类与上游权重", () => {
    expect(imported.animations).toHaveLength(106);
    const behavior = resolved();
    expect(behavior.id).toBe("dsh-pet");
    expect(behavior.idle).toEqual([webm(IDLE)]);
    expect(behavior.drag).toEqual([webm(DRAG)]);
    expect(behavior.turn).toEqual(["东张西望.webm"]);
    expect(behavior.clicks).toEqual(CLICKS.map(webm));
    expect(behavior.referenceWidth).toBe(462);
    expect(behavior.weights).toEqual({ idle: 10, turn: 5, move: 5, action: 80 });
    expect(behavior.categories.map(({ id, weight, entries, noMirror }) =>
      [id, weight, entries.length, noMirror === true],
    )).toEqual([
      ["小动作", 20, 18, false], ["玩耍", 20, 27, false], ["吃什么", 16, 12, false],
      ["时节", 14, 21, false], ["文字", 10, 2, true],
    ]);

    const entries = allEntries(behavior);
    expect(new Set(entries).size).toBe(95);
    expect(entries.every((entry) => imported.animations.includes(entry))).toBe(true);
    expect(entries.some((entry) => /^(余额-|碎碎念-|睡觉-)/.test(entry))).toBe(false);
    expect(entries).not.toContain("工作状态-思考冒泡.webm");
    expect(entries).not.toContain("工作状态-清点归档.webm");
  });

  it("三个移动动作继承默认值，并把秒精确换算为毫秒", () => {
    expect(resolved().moves).toEqual([
      { entry: "螃蟹走路.webm", minDistance: 60, maxDistance: 240, leadMs: 2000, tailMs: 2000 },
      { entry: "原地漂浮踏步.webm", minDistance: 40, maxDistance: 120, leadMs: 2000, tailMs: 2000 },
      { entry: "原地左转奔跑.webm", minDistance: 120, maxDistance: 320, leadMs: 1750, tailMs: 4800 },
    ]);
  });

  it.each(["renamed/深层/assets/webm/", "renamed\\深层\\assets\\webm\\"])(
    "包改名、非待机默认动作和嵌套路径 %s 不影响识别，输出保留原始路径",
    (prefix) => {
      const asset: PetAsset = {
        id: "unrelated-id", name: "完全改名", path: "renamed.zip",
        entry: `${prefix}吃Token.WEBM`,
        animations: importedNames.map((name) => `${prefix}${name}.WEBM`),
      };
      const behavior = resolved(asset);
      expect(allEntries(behavior).map((entry) => entry.slice(prefix.length).replace(/\.WEBM$/, ".webm")))
        .toEqual(allEntries(resolved()));
      expect(behavior.eventActions["capture.success"]).toBe(`${prefix}${CELEBRATE}.WEBM`);
    },
  );

  it.each([
    ["没有待机", [DRAG, CLICKS[0], CLICKS[1]]],
    ["没有悬空拖拽", [IDLE, CLICKS[0], CLICKS[1]]],
    ["只有一个点击回应", [IDLE, DRAG, CLICKS[0]]],
  ])("保守识别：%s 时不匹配", (_label, names) => {
    expect(resolvePetBehavior(assetFromNames(names))).toBeNull();
  });

  it("最小组合允许任意两个已知点击回应，其它缺失池和映射保持为空", () => {
    const behavior = resolved(assetFromNames([IDLE, DRAG, CLICKS[2], CLICKS[4]]));
    expect(behavior.clicks).toEqual([webm(CLICKS[2]), webm(CLICKS[4])]);
    expect(behavior.turn).toEqual([]);
    expect(behavior.moves).toEqual([]);
    expect(behavior.categories).toEqual([]);
    expect(behavior.eventActions).toEqual({});
    expect(behavior.stateActions).toEqual({});
  });

  it("重复路径和同名文件只算一种点击回应", () => {
    const animations = [webm(IDLE), webm(DRAG), webm(CLICKS[0]), webm(CLICKS[0]), `nested/${webm(CLICKS[0])}`];
    expect(resolvePetBehavior({ entry: animations[0], animations })).toBeNull();
  });

  it.each([
    ["同名 GIF", minimal.animations.map((entry) => entry.replace(".webm", ".gif"))],
    ["名字只含已知词", minimal.animations.map((entry) => `预览-${entry}`)],
    ["后缀不完整", minimal.animations.map((entry) => `${entry}.bak`)],
    ["目录叫动作名", minimal.animations.map((entry) => `${entry}/preview.webm`)],
    ["未经配置的点击回应", [webm(IDLE), webm(DRAG), webm(CLICKS[0]), "点击回应-未知.webm"]],
  ])("不把 %s 当成 DSH 动作组合", (_label, animations) => {
    expect(resolvePetBehavior({ entry: animations[0], animations })).toBeNull();
  });

  it("默认 entry 是已知文件时也参与组合，重复列出时只输出一次", () => {
    const animations = minimal.animations.slice(1);
    const behavior = resolved({ entry: webm(IDLE), animations });
    expect(behavior.idle).toEqual([webm(IDLE)]);
    expect(behavior).toEqual(resolved(minimal));
  });

  it("null、空素材、普通 makima / nashor 及伪装显示名称均返回 null", () => {
    expect(resolvePetBehavior(null)).toBeNull();
    expect(resolvePetBehavior(undefined)).toBeNull();
    const ordinaryAssets: PetAsset[] = [
      { id: "empty", name: "大肥鱼", path: "empty.zip", entry: "", animations: [] },
      {
        id: "dsh-pet", name: "大肥鱼", path: "makima.zip", entry: "makima_pixel/gifs/makima_idle.gif",
        animations: ["makima_pixel/gifs/makima_idle.gif", "makima_pixel/gifs/makima_wave.gif", "feedback/success.gif"],
      },
      {
        id: "nashor", name: "大肥鱼", path: "nashor.zip", entry: "nashor_pet_v2/gifs/nashor_idle.gif",
        animations: ["nashor_pet_v2/gifs/nashor_idle.gif", "nashor_pet_v2/gifs/nashor_burrow_left.gif", "feedback/recording.gif"],
      },
      {
        id: "nashor-webm", name: "大肥鱼", path: "nashor-webm.zip", entry: "待机.webm",
        animations: ["待机.webm", "伏地.webm", "倒下.webm", "钻出.webm", "舞蹈.webm"],
      },
    ];
    for (const asset of ordinaryAssets) expect(resolvePetBehavior(asset)).toBeNull();
  });

  it("过滤不存在的转向、移动和分类动作，保留剩余分类的原权重及 noMirror", () => {
    const behavior = resolved(assetFromNames([
      IDLE, DRAG, CLICKS[0], CLICKS[1], "原地漂浮踏步", "照镜子", "是啊，吃什么", BUSY,
    ]));
    expect(behavior.turn).toEqual([]);
    expect(behavior.moves).toEqual([
      { entry: "原地漂浮踏步.webm", minDistance: 40, maxDistance: 120, leadMs: 2000, tailMs: 2000 },
    ]);
    expect(behavior.categories).toEqual([
      { id: "小动作", weight: 20, entries: ["照镜子.webm"] },
      { id: "文字", weight: 10, noMirror: true, entries: ["是啊，吃什么.webm"] },
    ]);
    expect(behavior.eventActions).toEqual({});
    expect(behavior.stateActions).toEqual({ recording: webm(BUSY) });
  });

  it("使用 Snapshot 现有事件和持续状态，不添加其它 DSH 事件", () => {
    const behavior = resolved();
    expect(behavior.eventActions).toEqual({
      "capture.success": webm(CELEBRATE), "polish.success": webm(CELEBRATE),
      "recording.stopped": webm(CELEBRATE), "shortcuts.resumed": webm(CELEBRATE),
      "capture.failure": webm(FAILURE), "polish.failure": webm(FAILURE), "recording.failure": webm(FAILURE),
    });
    expect(behavior.stateActions).toEqual({ recording: webm(BUSY), "shortcuts-paused": webm(PACING) });
  });

  it.each([
    [CELEBRATE, 3, 2], [FAILURE, 4, 2], [BUSY, 7, 1], [PACING, 7, 1],
  ])("缺少 %s 时删除相关映射，不留下 undefined 键或其它无效条目", (missing, events, states) => {
    const asset = assetFromNames(importedNames.filter((name) => name !== missing));
    const behavior = resolved(asset);
    expect(Object.keys(behavior.eventActions)).toHaveLength(events);
    expect(Object.keys(behavior.stateActions)).toHaveLength(states);
    expect(allEntries(behavior).every((entry) => asset.animations.includes(entry))).toBe(true);
  });

  it("不修改输入，也不在多次解析之间共享可变池、参数或映射", () => {
    const original = structuredClone(imported);
    const expected = resolved();
    const changed = resolved();
    changed.idle.length = 0;
    changed.clicks.reverse();
    changed.moves[0].leadMs = -1;
    changed.categories[0].entries.length = 0;
    changed.weights.idle = -1;
    changed.eventActions["capture.success"] = "wrong.webm";
    changed.stateActions.recording = "wrong.webm";
    expect(resolved()).toEqual(expected);
    expect(imported).toEqual(original);
  });
});

describe("pickPetEntry", () => {
  it("空池返回 null，单候选允许重播", () => {
    const random = vi.fn(() => 0);
    expect(pickPetEntry([], null, random)).toBeNull();
    expect(random).not.toHaveBeenCalled();
    expect(pickPetEntry(["solo"], "solo", random)).toBe("solo");
    expect(pickPetEntry(["solo", "solo"], "solo", random)).toBe("solo");
  });

  it("按等概率区间选择，不修改只读池", () => {
    const pool = Object.freeze(["first", "middle", "last"]);
    expect(pickPetEntry(pool, null, () => 0)).toBe("first");
    expect(pickPetEntry(pool, undefined, () => 0.5)).toBe("middle");
    expect(pickPetEntry(pool, "absent", () => 0.999999)).toBe("last");
    expect(pool).toEqual(["first", "middle", "last"]);
  });

  it("有其它候选时避开当前值的所有重复项", () => {
    expect(pickPetEntry(["current", "next", "current"], "current", () => 0.999999)).toBe("next");
  });

  it("未注入随机数时使用 Math.random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(pickPetEntry(["a", "b"])).toBe("b");
  });
});

describe("pickPetBehaviorAction", () => {
  it.each([
    [0, "悠闲哼歌"], [0.249999, "悠闲哼歌"], [0.25, "原地专心玩魔方"],
    [0.5, "吃白饭"], [0.7, "被落叶淹没"], [0.875, "是啊，吃什么"], [0.999999, "是啊，吃什么"],
  ])("roll=%s 先按分类权重选，再独立选类内条目", (roll, name) => {
    const random = vi.fn().mockReturnValueOnce(roll).mockReturnValueOnce(0);
    expect(pickPetBehaviorAction(resolved(), "left", null, random)).toBe(webm(name));
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("在已选分类内部避免连抽当前，不改变分类权重或跳到别的分类", () => {
    const behavior = resolved();
    const random = vi.fn(() => 0);
    expect(pickPetBehaviorAction(behavior, "left", "悠闲哼歌.webm", random)).toBe("超大伸懒腰.webm");
    behavior.categories = [
      { id: "single", weight: 1, entries: ["current"] },
      { id: "other", weight: 1, entries: ["other"] },
    ];
    expect(pickPetBehaviorAction(behavior, "left", "current", random)).toBe("current");
  });

  it("朝右过滤 noMirror 并按剩余 70 权重重算区间", () => {
    const random = () => vi.fn().mockReturnValueOnce(0.27).mockReturnValueOnce(0);
    expect(pickPetBehaviorAction(resolved(), "left", null, random())).toBe("原地专心玩魔方.webm");
    expect(pickPetBehaviorAction(resolved(), "right", null, random())).toBe("悠闲哼歌.webm");
    const last = vi.fn().mockReturnValueOnce(0.999999).mockReturnValueOnce(0);
    expect(pickPetBehaviorAction(resolved(), "right", null, last)).toBe("被落叶淹没.webm");
  });

  it.each<{ label: string; categories: PetBehaviorCategory[] }>([
    { label: "没有分类", categories: [] },
    { label: "仅有不可镜像分类", categories: [{ id: "text", weight: 100, noMirror: true, entries: ["text"] }] },
    { label: "仅有空分类", categories: [{ id: "empty", weight: 100, entries: [] }] },
    {
      label: "仅有非正或无效权重",
      categories: [0, -1, NaN, Infinity].map((weight) => ({ id: String(weight), weight, entries: ["invalid"] })),
    },
  ])("$label 时回退 idle，也尽量避开当前", ({ categories }) => {
    const behavior = { ...resolved(minimal), idle: ["idle-a", "idle-b"], categories };
    expect(pickPetBehaviorAction(behavior, "right", "idle-a", () => 0)).toBe("idle-b");
    behavior.idle = [];
    expect(pickPetBehaviorAction(behavior, "right", null, () => 0)).toBeNull();
  });

  it("空分类和无效权重不抢占有效分类的抽选区间", () => {
    const behavior: PetBehavior = {
      ...resolved(minimal),
      categories: [
        { id: "zero", weight: 0, entries: ["zero"] },
        { id: "empty", weight: 1000, entries: [] },
        { id: "valid", weight: 3, entries: ["valid"] },
      ],
    };
    expect(pickPetBehaviorAction(behavior, "left", null, () => 0)).toBe("valid");
    expect(pickPetBehaviorAction(behavior, "left", null, () => 0.999999)).toBe("valid");
  });
});
