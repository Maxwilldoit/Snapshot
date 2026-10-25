import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { ActivityEntry, PetAsset, PetCatalogAsset, PlatformCapabilities, PromptHistoryEntry, Settings, SnapshotRecord } from "../types";

/**
 * 浏览器预览（直接 `npm run dev` 打开页面）用的假后端。
 *
 * 界面代码只认 invoke；这里在最底层把 invoke 接住，业务代码就不必每个函数都判断
 * 「是不是在 Tauri 里」。只在没有 Tauri 时由 main.tsx 动态加载，不进正式包的执行路径。
 *
 * 地址里带 `?demo` 时装一份演示数据（历史、活动、伴侣），方便看界面在「用了一阵子」之后的样子；
 * `?window=quick-menu` 可以单独看输入框。
 */

const params = new URLSearchParams(window.location.search);
const demo = params.has("demo");
const windowLabel = params.get("window") ?? "main";

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

const BUILTIN_PROMPT = "你是提示词改写专家。保持原意不变，将用户草稿整理为清晰、完整、可执行的指令。只输出改写后的提示词。";

/** 素材库的演示图内嵌在预览后端，不访问真实仓库，也不代表真实素材或授权。 */
function demoCatalogPreview(body: string, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="130" viewBox="0 0 160 130"><g stroke="#403d36" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M48 119h64" stroke="#c9c3b7"/><g fill="${color}">${body}</g><path d="M68 71v5m24-5v5m-17 10q5 5 10 0" fill="none"/><path d="M60 113v5m40-5v5"/></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const catalogFixtures: PetCatalogAsset[] = [
  {
    id: "demo-paper", name: "演示 · 纸团", description: "圆滚滚的纸面小伙伴。这是浏览器演示素材，供预览和试用导入流程。",
    tags: ["演示", "纸面", "安静"], version: "1.0.0-demo", file: "demo-paper.zip", sizeBytes: 1_572_864,
    previewUrl: demoCatalogPreview('<path d="M42 53 45 24 65 43Q80 37 95 43L115 24 118 53Q132 75 117 101Q108 116 80 115Q52 116 43 101Q28 75 42 53Z"/><path d="M47 56 57 60m52-4-10 4" fill="none"/>', "#e8d8bc"),
    sha256: "0".repeat(64), downloadUrl: "https://example.invalid/snapshot-demo/demo-paper.zip", licenseStatus: "演示数据 · 不代表素材授权",
  },
  {
    id: "demo-block", name: "演示 · 方块", description: "一位有棱有角的桌面伙伴。示例图与素材信息均为本地演示数据。",
    tags: ["演示", "几何"], version: "1.2.0-demo", file: "demo-block.zip", sizeBytes: 3_145_728,
    previewUrl: demoCatalogPreview('<rect x="41" y="43" width="78" height="70" rx="10"/><path d="M80 43V27m-8 0h16M41 80H30v15m89-15h11v15" fill="none"/>', "#b5c7c3"),
    sha256: "1".repeat(64), downloadUrl: "https://example.invalid/snapshot-demo/demo-block.zip", licenseStatus: "演示数据 · 不代表素材授权",
  },
  {
    id: "demo-sprout", name: "演示 · 绿芽", description: "顶着一片新叶的小伙伴。可以试着导入、改名，再回到素材库重新导入。",
    tags: ["演示", "植物", "轻巧"], version: "1.0.0-demo", file: "demo-sprout.zip", sizeBytes: 786_432,
    previewUrl: demoCatalogPreview('<path d="M80 48Q42 45 40 81Q37 114 80 114Q123 114 120 81Q118 45 80 48Z"/><path d="M80 48Q79 18 106 19Q107 44 80 48Z" fill="#a8b895"/><path d="M80 46 94 32" fill="none"/>', "#ded4b8"),
    sha256: "2".repeat(64), downloadUrl: "https://example.invalid/snapshot-demo/demo-sprout.zip", licenseStatus: "演示数据 · 不代表素材授权",
  },
];

let settings: Settings = {
  baseUrl: demo ? "https://api.deepseek.com/v1" : "",
  model: demo ? "deepseek-chat" : "",
  hasApiKey: demo,
  templates: [
    {
      id: "builtin-default",
      name: "清晰、可执行",
      builtin: true,
      content: BUILTIN_PROMPT,
    },
    ...(demo
      ? [
          { id: "custom-code", name: "代码修改任务", builtin: false, content: "把草稿改写成给编程助手的修改任务……" },
          { id: "custom-en", name: "翻成英文", builtin: false, content: "Translate the draft into natural English." },
        ]
      : []),
  ],
  activeTemplateId: demo ? "custom-code" : "builtin-default",
  selectedAppearanceId: demo ? "pet-calico" : "app-icon",
  petAssets: demo
    ? [
        { id: "pet-calico", name: "三花猫", path: "pets/pet-calico.zip", entry: "idle.gif", animations: ["idle.gif", "打招呼.gif", "敲键盘.gif", "撒娇.gif", "撒娇2.gif", "睡觉.gif"], source: "D:\\素材\\伴侣\\三花猫-v3-最终.zip", sizeBytes: 24_530_000, importedAt: minutesAgo(9000), lastUsedAt: minutesAgo(10) },
        { id: "pet-typing", name: "键盘三花", path: "pets/pet-typing.gif", entry: "typing.gif", animations: ["typing.gif"], sizeBytes: 3_200_000, importedAt: minutesAgo(8000), lastUsedAt: minutesAgo(600) },
        { id: "pet-idea", name: "灵感三花", path: "pets/pet-idea.gif", entry: "idea.gif", animations: ["idea.gif"], importedAt: minutesAgo(7000), lastUsedAt: minutesAgo(1200) },
        { id: "pet-cheer", name: "三花猫-欢呼-2026春节限定版", path: "pets/pet-cheer.gif", entry: "cheer.gif", animations: ["cheer.gif"], importedAt: minutesAgo(6000), lastUsedAt: minutesAgo(3000) },
        { id: "pet-sit", name: "坐姿三花", path: "pets/pet-sit.gif", entry: "sit.gif", animations: ["sit.gif"], importedAt: minutesAgo(5000) },
        { id: "pet-question", name: "问号三花", path: "pets/pet-question.gif", entry: "q.gif", animations: ["q.gif"], importedAt: minutesAgo(4000) },
        { id: "pet-chubby", name: "胖三花", path: "pets/pet-chubby.gif", entry: "c.gif", animations: ["c.gif"], importedAt: minutesAgo(3000) },
        { id: "pet-clawd", name: "clawd", path: "C:\\Users\\max\\Downloads\\clawd.zip", entry: "idle.gif", animations: ["idle.gif"], importedAt: minutesAgo(2000), missing: true },
      ]
    : [],
  petScale: 100,
  petWander: false,
  petRandomActions: false,
  petGravity: true,
  shortcutsPaused: false,
  shortcuts: [
    { action: "snapshot", accelerator: demo ? "CommandOrControl+Shift+A" : null },
    { action: "fullscreen", accelerator: demo ? "CommandOrControl+Shift+F" : null },
    { action: "record", accelerator: demo ? "CommandOrControl+Alt+R" : null },
    { action: "polish", accelerator: null },
    { action: "palette", accelerator: demo ? "Alt+Space" : null },
  ],
  clipboardAutoClear: "60s",
  snapshotFormat: "png",
  saveDir: demo ? "D:\\Dropbox\\工作\\2026\\截图归档\\应用快照\\原始文件" : "",
  recordingDir: "",
  shutterSound: "crisp",
  customSoundPath: null,
  flashOnCapture: true,
  hideAfterCopy: false,
  autoSaveLocal: true,
  launchOnBoot: false,
  includeCursor: false,
  recordSystemAudio: demo,
  recordMicrophone: false,
  afterCapture: "clipboard",
};

const demoApps: Array<[string, number, number, number]> = [
  ["Visual Studio Code — HistoryPage.tsx — 应用快照", 1920, 1080, 412_000],
  ["微信", 1100, 780, 96_000],
  ["Google Chrome", 1280, 6400, 2_800_000],
  ["Windows Terminal", 1200, 700, 64_000],
  ["Q3 预算-终版-改2.xlsx - Excel", 2560, 1440, 1_100_000],
  ["记事本", 640, 480, 18_000],
  ["飞书", 1440, 900, 388_000],
  ["Microsoft Edge", 3840, 2160, 5_600_000],
  ["资源管理器", 800, 600, 120_000],
  ["PowerShell", 1100, 620, 80_000],
  ["画图", 1024, 768, 210_000],
];

let snapshots: SnapshotRecord[] = demo
  ? Array.from({ length: 186 }, (_, index) => {
      const [appName, width, height, sizeBytes] = demoApps[index % demoApps.length];
      const minutes = index < 4 ? [6, 33, 165, 254][index] : index < 8 ? 60 * 24 + index * 70 : 60 * 24 * 3 + index * 40;
      return { id: `snap-${index}`, fileName: `snap-${index}.png`, appName, width, height, sizeBytes, createdAt: minutesAgo(minutes) };
    })
  : [];

const activity: ActivityEntry[] = demo
  ? [
      { id: "a1", at: minutesAgo(6), kind: "capture", title: demoApps[0][0], meta: "1920 × 1080", snapshotId: "snap-0" },
      {
        id: "a2",
        at: minutesAgo(33),
        kind: "polish",
        title: "代码修改任务",
        meta: "58 → 427 字",
        detail:
          "你在修改一个 Tauri 2 + React 的桌面应用「应用快照」。这次只动 src/pages/HistoryPage.tsx，不要改 Rust 侧的命令，也不要改 listSnapshots() 的返回结构。要做的事：1. 历史记录按日期分组……",
      },
      { id: "a3", at: minutesAgo(48), kind: "record", title: "Google Chrome", meta: "02:13", detail: "C:\\Users\\max\\Downloads\\应用快照-2026-09-24_13-50-02.mp4" },
      { id: "a4", at: minutesAgo(165), kind: "capture", title: "Google Chrome", meta: "1280 × 6400", snapshotId: "snap-2" },
      { id: "a5", at: minutesAgo(210), kind: "error", title: "润色失败", detail: "请求超时（180 秒）" },
      { id: "a6", at: minutesAgo(254), kind: "capture", title: "Windows Terminal", meta: "1200 × 700", snapshotId: "snap-3" },
      { id: "a7", at: minutesAgo(300), kind: "error", title: "快捷键没注册上", detail: "CommandOrControl+Alt+R" },
    ]
  : [];

const promptHistory: PromptHistoryEntry[] = demo
  ? [
      {
        id: "prompt-demo-1",
        createdAt: minutesAgo(33),
        template: "代码修改任务",
        original: "把历史页按日期分组，空状态也写清楚。",
        polished: "修改 src/pages/HistoryPage.tsx：将历史记录按日期分组展示；每组显示日期与记录数量；为空时说明如何生成第一条记录。保持现有数据结构与交互，不修改 Rust 命令。",
      },
      {
        id: "prompt-demo-2",
        createdAt: minutesAgo(180),
        template: "清晰、可执行",
        original: "检查右键菜单，去掉搜索框和打开主窗口。",
        polished: "检查右键桌宠打开的快捷菜单，移除搜索框及其筛选、粘贴润色逻辑，同时移除“打开主窗口”入口；保留快照、全屏截图、录制和润色动作，并保持键盘上下选择、回车执行与 Esc 关闭可用。",
      },
    ]
  : [];

const demoClipboard = demo
  ? { label: "Visual Studio Code 截图", snapshotId: "snap-0", armedAt: Date.now() - 18_000, clearAt: Date.now() + 42_000 }
  : null;

const unavailable = { available: false };
const capabilities: PlatformCapabilities = demo
  ? {
      os: "windows",
      displayServer: "desktop",
      recording: { available: true },
      recordingSystemAudio: { available: true },
      recordingMicrophone: { available: true },
      autostart: { available: true },
      includeCursor: { available: true },
    }
  : {
      os: "preview",
      displayServer: "n/a",
      recording: unavailable,
      recordingSystemAudio: unavailable,
      recordingMicrophone: unavailable,
      autostart: unavailable,
      scrolling: unavailable,
      includeCursor: unavailable,
    };

const idleRecording = { active: false, target: null, startedAt: null };
const noFileManager = "预览模式下不会打开文件管理器";

/** 改设置的命令在预览里也要「生效」，页面才能照常来回切换 */
function update(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  return structuredClone(settings);
}

async function handle(command: string, payload?: InvokeArgs): Promise<unknown> {
  // 入参形状由 backend.ts 那一侧的类型保证，这里只是假后端，不再重复校验
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = (payload ?? {}) as Record<string, any>;
  switch (command) {
    case "load_settings":
      return structuredClone(settings);
    case "save_prompt_settings": {
      const input = { ...args.input };
      delete input.apiKey;
      return update(input);
    }
    case "clear_api_key":
      return update({ hasApiKey: false });
    case "save_preferences":
      return update(args.prefs);
    case "save_shortcuts":
      return update({ shortcuts: args.shortcuts });
    case "set_shortcuts_paused":
      return update({ shortcutsPaused: args.paused });
    case "select_pet_appearance":
      return update({
        selectedAppearanceId: args.id,
        petAssets: settings.petAssets.map((asset) => (asset.id === args.id ? { ...asset, lastUsedAt: Date.now() } : asset)),
      });
    case "show_pet_catalog": {
      const url = new URL(window.location.href);
      url.searchParams.set("window", "pet-catalog");
      const catalog = window.open(url, "snapshot-pet-catalog", "popup,width=920,height=720");
      if (!catalog) throw new Error("请允许弹出素材库窗口");
      catalog.focus();
      return;
    }
    case "fetch_pet_catalog":
      await new Promise((resolve) => setTimeout(resolve, 350));
      return structuredClone(catalogFixtures);
    case "install_catalog_pet": {
      const item = catalogFixtures.find((asset) => asset.id === args.id);
      if (!item) throw new Error("演示素材不存在，请刷新素材库");
      await new Promise((resolve) => setTimeout(resolve, 700));
      const source = `https://github.com/Maxwilldoit/Pets#${item.id}`;
      const existing = settings.petAssets.find((asset) => asset.source === source);
      const asset: PetAsset = {
        id: existing?.id ?? `catalog-${item.id}`,
        name: existing?.name ?? item.name,
        path: `preview/${item.file}`,
        entry: "preview.svg",
        animations: ["preview.svg"],
        source,
        sizeBytes: item.sizeBytes,
        importedAt: existing?.importedAt ?? Date.now(),
        lastUsedAt: Date.now(),
      };
      return update({
        selectedAppearanceId: asset.id,
        petAssets: existing ? settings.petAssets.map((pet) => pet.id === existing.id ? asset : pet) : [...settings.petAssets, asset],
      });
    }
    case "add_pet_assets": {
      const added = (args.paths as string[]).map((path, index) => ({
        id: `pet-${Date.now()}-${index}`,
        name: (path.split(/[\\/]/).pop() ?? "伴侣").replace(/\.[^.]+$/, ""),
        path,
        entry: "",
        animations: [],
        importedAt: Date.now(),
        lastUsedAt: Date.now(),
      }));
      const next = update({ selectedAppearanceId: added[added.length - 1]?.id ?? settings.selectedAppearanceId, petAssets: [...settings.petAssets, ...added] });
      return { settings: next, imported: added.length, failed: [] };
    }
    case "rename_pet_asset":
      return update({ petAssets: settings.petAssets.map((asset) => (asset.id === args.id ? { ...asset, name: args.name } : asset)) });
    case "delete_pet_asset":
      return update({
        selectedAppearanceId: settings.selectedAppearanceId === args.id ? "app-icon" : settings.selectedAppearanceId,
        petAssets: settings.petAssets.filter((asset) => asset.id !== args.id),
      });
    case "default_prompt":
      return BUILTIN_PROMPT;
    case "fetch_models":
      return ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"];
    case "get_previous_app":
      return { id: null, pid: null, name: "上一个应用", title: "等待切换应用" };
    case "capture_window":
    case "run_action":
      return "预览模式下不会读取系统窗口";
    case "toggle_recording":
    case "get_recording_status":
      return idleRecording;
    case "polish_clipboard":
      return "预览模式下不会访问剪贴板";
    case "read_clipboard_text":
      return "帮我把历史页按日期分一下组，长截图别裁成方的，名字太长就截断";
    case "polish_text":
      await new Promise((resolve) => setTimeout(resolve, 600));
      return `【预览模式：未调用模型】\n\n${String(args.text).trim()}`;
    case "open_snapshots_dir":
    case "open_recordings_dir":
      return noFileManager;
    case "get_snapshot_dir":
      return demo ? "D:\\Dropbox\\工作\\2026\\截图归档\\应用快照\\原始文件" : "~/Pictures/Snapshot";
    case "get_recording_dir":
      return "~/Downloads";
    case "list_snapshots":
      return structuredClone(snapshots);
    case "list_prompt_history":
      return structuredClone(promptHistory);
    case "delete_snapshots":
      snapshots = snapshots.filter((item) => !(args.ids as string[]).includes(item.id));
      return structuredClone(snapshots);
    case "copy_snapshot":
      return "预览模式下不会写剪贴板";
    case "annotate_snapshot":
      throw new Error("请在桌面应用中打开标注窗口");
    case "list_activity":
      return structuredClone(activity);
    case "get_clipboard_state":
      return demoClipboard;
    case "list_capturable_windows":
      return demo
        ? [
            { id: 1, pid: 1, appName: "Visual Studio Code", title: "HistoryPage.tsx — 应用快照" },
            { id: 2, pid: 2, appName: "Google Chrome", title: "Tauri 2 · Window Customization" },
            { id: 3, pid: 3, appName: "微信", title: "微信" },
          ]
        : [];
    case "get_shortcut_conflicts":
      return demo && !settings.shortcutsPaused ? ["CommandOrControl+Alt+R"] : [];
    case "platform_capabilities":
      return capabilities;
    default:
      // 窗口控制、对话框、事件订阅、剪贴板写入等：预览里什么都不做
      return undefined;
  }
}

export function installPreviewBackend() {
  mockWindows(windowLabel);
  mockConvertFileSrc("windows");
  // 导入演示素材后，舞台与形象架也使用同一张内嵌预览图。
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string, protocol?: string) => string } }).__TAURI_INTERNALS__;
  const convertFileSrc = internals.convertFileSrc;
  internals.convertFileSrc = (path, protocol) => {
    const [kind, id] = path.split("/");
    if (protocol === "media" && (kind === "pet" || kind === "pet-thumb")) {
      const source = settings.petAssets.find((asset) => asset.id === id)?.source;
      const item = catalogFixtures.find((asset) => source === `https://github.com/Maxwilldoit/Pets#${asset.id}`);
      if (item) return item.previewUrl;
    }
    return convertFileSrc(path, protocol);
  };
  mockIPC(handle, { shouldMockEvents: true });
}
