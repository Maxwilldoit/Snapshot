export type MotionMode = "full" | "reduced";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下就只在本次会话生效
  }
}

/** 设置动效模式，具体时长和效果由 CSS 与动效函数决定。 */
export function applyMotion(mode: MotionMode) {
  document.documentElement.dataset.motion = mode;
}

const AUTO_COPY_KEY = "snapshot-auto-copy";

/** Prompt 页生成完是否直接放进剪贴板（在偏好设置的「润色规则」里切换） */
export function readAutoCopy(): boolean {
  return read(AUTO_COPY_KEY) === "1";
}

export function persistAutoCopy(value: boolean) {
  write(AUTO_COPY_KEY, value ? "1" : "0");
}
