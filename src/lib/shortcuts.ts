import type { Settings, ShortcutAction } from "../types";

/** 给别处用：某个动作当前绑的键（输入框里要显示） */
export function acceleratorOf(settings: Settings, action: ShortcutAction) {
  return settings.shortcuts.find((item) => item.action === action)?.accelerator ?? null;
}

