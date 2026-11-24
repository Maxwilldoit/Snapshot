import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { PetWindow } from "./windows/PetWindow";
import { QuickMenuWindow } from "./windows/QuickMenuWindow";
import { AnnotateWindow } from "./windows/AnnotateWindow";
import { LaunchpadWindow } from "./windows/LaunchpadWindow";
import { PetCatalogWindow } from "./windows/PetCatalogWindow";
import { applyTheme, readTheme, watchSystemTheme } from "./lib/theme";
import { suppressNativeContextMenu } from "./lib/contextMenu";
import { viewTransition, watchSystemMotion } from "./lib/motion";
import { installWheelPace } from "./lib/wheelScroll";
import { applyDocumentLanguage, I18nProvider, resolveLanguage } from "./lib/i18n";
import "./styles/variables.css";
import "./styles.css";
import "./styles/app.css";
import "./styles/main-window.css";
import "./styles/library.css";

function mount() {
  const label = getCurrentWindow().label;
  const usesTransparentSurface = label === "pet" || label === "quick-menu" || label === "launchpad";
  document.documentElement.classList.toggle("transparent-window", usesTransparentSurface);
  // 主窗口的新外观只挂在 data-window="main" 下，桌宠、快捷菜单等其它窗口不受影响
  document.documentElement.dataset.window = label;
  document.documentElement.dataset.surface = ["main", "pet-catalog"].includes(label) ? "app" : "overlay";
  document.body.classList.toggle("transparent-window", usesTransparentSurface);

  // 每个 WebView 都在首帧前应用系统颜色和完整动效，不读取旧外观偏好。
  applyDocumentLanguage(resolveLanguage());
  applyTheme(readTheme());
  // 开发时留着系统右键菜单，方便「检查元素」
  if (!import.meta.env.DEV) suppressNativeContextMenu();

  const unwatchMotion = watchSystemMotion();
  import.meta.hot?.dispose(unwatchMotion);
  const unwatchTheme = watchSystemTheme((mode) => {
    if (label === "main") viewTransition("theme", () => applyTheme(mode));
    else applyTheme(mode);
  });
  import.meta.hot?.dispose(unwatchTheme);

  // 滚轮定速：Windows / Linux 下把鼠标滚轮的大颗粒增量收成固定小步。
  // macOS 触控板和鼠标滚轮本身已有原生 120Hz 惯性滚动；挂 passive: false 的全局 wheel 监听
  // 会迫使 WKWebView 退回主线程同步滚动并误拦快速触控板滑动，造成滑动掉帧。
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  if (label !== "launchpad" && label !== "pet" && !isMac) {
    const uninstallWheel = installWheelPace(document.documentElement);
    import.meta.hot?.dispose(uninstallWheel);
  }

  const CurrentWindow =
    label === "pet" ? PetWindow
    : label === "quick-menu" ? QuickMenuWindow
    : label === "annotate" ? AnnotateWindow
    : label === "launchpad" ? LaunchpadWindow
    : label === "pet-catalog" ? PetCatalogWindow
    : App;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <CurrentWindow />
      </I18nProvider>
    </StrictMode>,
  );
}

// 直接在浏览器里打开页面（npm run dev）时没有 Tauri 后端：先装一层假后端再挂载
if ("__TAURI_INTERNALS__" in window) {
  mount();
} else {
  void import("./lib/preview").then(({ installPreviewBackend }) => {
    installPreviewBackend();
    mount();
  });
}
