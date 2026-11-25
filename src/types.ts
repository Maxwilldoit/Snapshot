/** 主窗口侧栏里的页面：资料库（截图、Prompt）、桌面伴侣、设置（截图与录制、快捷键） */
export type NavPage =
  | "history"
  | "trash"
  | "clipboard"
  | "prompts"
  | "pet"
  | "capture"
  | "shortcuts";

export type ShortcutAction =
  | "snapshot"
  | "fullscreen"
  | "scrolling"
  | "record"
  | "polish"
  | "prompts"
  | "palette";

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  builtin: boolean;
}

export interface ShortcutBinding {
  action: ShortcutAction;
  accelerator: string | null;
}

/** 一个桌宠动画的画布和脚底锚点。坐标是媒体像素，原点在左上，y 向下 */
export interface PetLayoutFrame {
  entry: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

/**
 * 压缩包里的 pet.json 解析结果。基准画布对应平时那个方窗，
 * 每个 GIF/WebM 动作的脚底锚到基准锚点上。没有这份数据的形象跟以前一样。
 */
export interface PetLayout {
  baseWidth: number;
  baseHeight: number;
  anchorX: number;
  anchorY: number;
  frames: PetLayoutFrame[];
}

interface PetBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Import-time full-frame envelope for an animation. Coordinates are normalized. */
interface PetActionShape {
  width: number;
  height: number;
  bounds: PetBounds;
}

export interface PetBehaviorSleep {
  start: string[];
  loop: string[];
  end: string[];
}

interface PetBehaviorInteractions {
  throw?: boolean;
  slingshot?: boolean;
  sleep?: boolean;
}

export interface PetBehaviorManifest {
  id: string;
  referenceWidth: number;
  weights: { idle: number; turn: number; move: number; action: number };
  idle: string[];
  clicks: string[];
  drag: string[];
  turn?: string[];
  sleep?: PetBehaviorSleep | null;
  moves?: Array<{
    entry: string;
    minDistance: number;
    maxDistance: number;
    leadMs: number;
    tailMs: number;
  }>;
  categories?: Array<{
    id: string;
    weight: number;
    noMirror?: boolean;
    entries: string[];
  }>;
  interactions?: PetBehaviorInteractions | null;
}

export interface PetAsset {
  id: string;
  name: string;
  path: string;
  entry: string;
  animations: string[];
  /** 作者为截图、润色、录制结束等一次性反馈指定的动作 */
  eventActions?: Partial<Record<PetEvent, string>>;
  /** 作者为录制中、快捷键暂停等持续状态指定的动作 */
  stateActions?: Partial<Record<PetPersistentState, string>>;
  /** 素材包 pet.json 声明的动作分池与物理/睡眠互动配置 */
  behavior?: PetBehaviorManifest | null;
  /** 导入时用户选的原文件 */
  source?: string;
  sizeBytes?: number;
  importedAt?: number;
  lastUsedAt?: number;
  /** 素材文件找不到了 */
  missing?: boolean;
  /** 有 pet.json 时才有。用来让人物在各动作里一样大，画布不够时再把窗口撑大 */
  layout?: PetLayout | null;
  /** GIF 导入时逐帧求出的完整透明外框；WebM 的完整范围由播放窗口补齐并缓存。 */
  actionBounds?: Record<string, PetActionShape>;
}

export interface PetCatalogAsset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  version: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  previewUrl: string;
  licenseStatus: string;
}

export type PetEvent =
  | "capture.success"
  | "capture.failure"
  | "recording.started"
  | "recording.stopped"
  | "recording.failure"
  | "polish.success"
  | "polish.failure"
  | "shortcuts.paused"
  | "shortcuts.resumed";

export type PetPersistentState = "recording" | "shortcuts-paused";

export interface Settings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  templates: PromptTemplate[];
  activeTemplateId: string;
  selectedAppearanceId: string;
  petAssets: PetAsset[];
  /** 悬浮大小：当前形象基准大小的百分比（见 lib/petScale.ts 和 lib/petSize.ts）。 */
  petScale: number;
  /** 空闲时沿当前屏幕底部走动 */
  petWander?: boolean;
  /** 空闲时随机播放普通动作 */
  petRandomActions?: boolean;
  /** 拖拽松开后落回工作区底部 */
  petGravity?: boolean;
  /** 桌宠被收起来了：选中的形象保留，只是不显示；旧设置缺省时视为显示 */
  petHidden?: boolean;
  shortcuts: ShortcutBinding[];
  /** 手动暂停全局快捷键；旧设置缺省时视为未暂停 */
  shortcutsPaused?: boolean;
  /** 按「窗口截图」「录屏」快捷键时在桌宠旁弹出窗口列表；关闭时直接作用于上一个应用 */
  shortcutPickWindow?: boolean;
  snapshotFormat: "png" | "jpeg" | "webp";
  saveDir: string;
  recordingDir: string;
  shutterSound: "crisp" | "soft" | "none" | "custom";
  customSoundPath: string | null;
  launchOnBoot: boolean;
  includeCursor: boolean;
  recordSystemAudio: boolean;
  recordMicrophone: boolean;
}

/** 图标不随数据下发，按 pid 经 media:// 协议现取（见 lib/media.ts） */
export interface PreviousApp {
  id: number | null;
  pid: number | null;
  name: string;
  title: string;
}

export interface CapturableWindow {
  id: number;
  pid: number;
  appName: string;
  title: string;
  minimized: boolean;
}

export interface RecordingStatus {
  active: boolean;
  target: string | null;
  startedAt: number | null;
  /** 启动时的提示（如 Linux portal 需重新选窗）；停止时通常缺省 */
  message?: string | null;
}

export interface SnapshotRecord {
  id: string;
  fileName: string;
  appName: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: number;
  /** 来源应用稳定标识。旧记录没有这一项，缺省不显示角标 */
  appId?: string;
}

/** 一段录屏成品。时长和画面尺寸由前端用 video 元素量，后端只给文件信息 */
export interface RecordingRecord {
  id: string;
  fileName: string;
  appName: string;
  sizeBytes: number;
  createdAt: number;
  /** 来源应用稳定标识。旧录像没有这一项，缺省不显示角标 */
  appId?: string;
}

export type TrashEntry = { id: string; trashedAt: number } & (
  | { kind: "snapshot"; record: SnapshotRecord }
  | { kind: "recording"; record: RecordingRecord }
);

/** 一次成功润色保存下来的原文、结果、规则和时间 */
export interface PromptHistoryEntry {
  id: string;
  createdAt: number;
  template: string;
  original: string;
  polished: string;
}

/** 用户主动保存、随时复制的 Prompt；与润色规则和历史完全分开 */
export interface SavedPrompt {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface PetImportResult {
  settings: Settings;
  imported: number;
  failed: Array<{ path: string; reason: string }>;
}

interface CapabilityStatus {
  available: boolean;
}

export interface PlatformCapabilities {
  os: string;
  displayServer: string;
  recording: CapabilityStatus;
  recordingSystemAudio: CapabilityStatus;
  recordingMicrophone: CapabilityStatus;
  autostart: CapabilityStatus;
  /** 仅 Linux 下发：其余平台没有滚动长截图 */
  scrolling?: CapabilityStatus;
  includeCursor: CapabilityStatus;
  /** 剪贴板历史：macOS / Linux 可用 */
  clipboardHistory?: CapabilityStatus;
}

/** 剪贴板历史里的一条：文字全文或图片元信息（图片经 media://clipboard/<id> 取） */
export interface ClipboardHistoryEntry {
  id: string;
  createdAt: number;
  kind: "text" | "image";
  text: string;
  width: number;
  height: number;
  hash: string;
}
