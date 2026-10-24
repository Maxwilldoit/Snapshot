/** 主窗口里的页面。home / settings 只在「时间线」布局里出现 */
export type NavPage =
  | "shortcuts"
  | "history"
  | "pet"
  | "prefs"
  | "themes"
  | "home"
  | "settings";

export type ShortcutAction =
  | "snapshot"
  | "fullscreen"
  | "scrolling"
  | "record"
  | "polish"
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

/** 一张 GIF 的画布和脚底锚点。坐标是 GIF 像素，原点在左上，y 向下 */
export interface PetLayoutFrame {
  entry: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

/**
 * 压缩包里的 pet.json 解析结果。基准画布对应平时那个方窗，
 * 每张 GIF 的脚底锚到基准锚点上。没有这份数据的形象跟以前一样。
 */
export interface PetLayout {
  baseWidth: number;
  baseHeight: number;
  anchorX: number;
  anchorY: number;
  frames: PetLayoutFrame[];
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
  /** 导入时用户选的原文件 */
  source?: string;
  sizeBytes?: number;
  importedAt?: number;
  lastUsedAt?: number;
  /** 素材文件找不到了 */
  missing?: boolean;
  /** 有 pet.json 时才有。用来让人物在各动作里一样大，画布不够时再把窗口撑大 */
  layout?: PetLayout | null;
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
  /** 悬浮大小：基准大小的百分比，100 时应用图标为屏幕短边的 8%、宠物为 16%（见 lib/petSize.ts） */
  petScale: number;
  shortcuts: ShortcutBinding[];
  /** 手动暂停全局快捷键；旧设置缺省时视为未暂停 */
  shortcutsPaused?: boolean;
  clipboardAutoClear: "30s" | "60s" | "5m" | "never";
  snapshotFormat: "png" | "jpeg" | "webp";
  saveDir: string;
  recordingDir: string;
  shutterSound: "crisp" | "soft" | "none" | "custom";
  customSoundPath: string | null;
  flashOnCapture: boolean;
  hideAfterCopy: boolean;
  autoSaveLocal: boolean;
  launchOnBoot: boolean;
  includeCursor: boolean;
  recordSystemAudio: boolean;
  recordMicrophone: boolean;
  afterCapture: "clipboard" | "annotate" | "saveas";
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
}

/** 后端记下的一件事：截了什么、录了什么、润色了什么、哪里失败了 */
export interface ActivityEntry {
  id: string;
  at: number;
  kind: "capture" | "record" | "polish" | "error";
  title: string;
  /** 一小段数字信息，如「1920 × 1080」「58 → 427 字」「02:13」 */
  meta?: string;
  /** 润色结果开头、错误原文、录像文件路径 */
  detail?: string;
  snapshotId?: string;
}

/** 一次成功润色保存下来的原文、结果、规则和时间 */
export interface PromptHistoryEntry {
  id: string;
  createdAt: number;
  template: string;
  original: string;
  polished: string;
}

/** 剪贴板里放着我们的图时的状态 */
export interface ClipboardState {
  label: string;
  snapshotId: string | null;
  armedAt: number;
  /** 何时自动清空；null 表示不会 */
  clearAt: number | null;
}

export interface PetImportResult {
  settings: Settings;
  imported: number;
  failed: Array<{ path: string; reason: string }>;
}

export interface CapabilityStatus {
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
}
