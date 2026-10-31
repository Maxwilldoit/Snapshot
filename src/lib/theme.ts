/** 实际落到 DOM 上的主题，只有两种 */
export type ThemeMode = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 始终读取系统颜色，忽略旧版本保存的主题选择。 */
export function readTheme(): ThemeMode {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** 主窗口、桌宠、快捷菜单等 WebView 各自独立，都要调用一次 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

/**
 * 每个 WebView 独立监听系统颜色，变化时立刻跟上。
 * 返回取消监听的函数；matchMedia 不可用时返回空操作。
 */
export function watchSystemTheme(onChange: (mode: ThemeMode) => void): () => void {
  const query = window.matchMedia?.(DARK_QUERY);
  if (!query) return () => {};
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? "dark" : "light");
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}
