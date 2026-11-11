import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { PetWindow } from "./windows/PetWindow";
import { QuickMenuWindow } from "./windows/QuickMenuWindow";
import { AnnotateWindow } from "./windows/AnnotateWindow";
import { LaunchpadWindow } from "./windows/LaunchpadWindow";
import { PetCatalogWindow } from "./windows/PetCatalogWindow";
import { PromptLibraryWindow } from "./windows/PromptLibraryWindow";
import { applyTheme, readTheme, watchSystemTheme } from "./lib/theme";
import { applyMotion } from "./lib/prefs";
import { suppressNativeContextMenu } from "./lib/contextMenu";
import { viewTransition } from "./lib/motion";
import { applyDocumentLanguage, I18nProvider, readLanguagePreference, resolveLanguage } from "./lib/i18n";
import "./styles/variables.css";
import "./styles.css";
import "./styles/app.css";
import "./styles/main-window.css";

function mount() {
  const label = getCurrentWindow().label;
  const usesTransparentSurface = label === "pet" || label === "quick-menu" || label === "launchpad";
  document.documentElement.classList.toggle("transparent-window", usesTransparentSurface);
  // 主窗口的新外观只挂在 data-window="main" 下，桌宠、快捷菜单等其它窗口不受影响
  document.documentElement.dataset.window = label;
  document.body.classList.toggle("transparent-window", usesTransparentSurface);

  // 每个 WebView 都在首帧前应用系统颜色和完整动效，不读取旧外观偏好。
  applyDocumentLanguage(resolveLanguage(readLanguagePreference()));
  applyTheme(readTheme());
  applyMotion("full");
  // 开发时留着系统右键菜单，方便「检查元素」
  if (!import.meta.env.DEV) suppressNativeContextMenu();

  const unwatchTheme = watchSystemTheme((mode) => {
    if (label === "main") viewTransition("theme", () => applyTheme(mode));
    else applyTheme(mode);
  });
  import.meta.hot?.dispose(unwatchTheme);

  const CurrentWindow =
    label === "pet" ? PetWindow
    : label === "quick-menu" ? QuickMenuWindow
    : label === "annotate" ? AnnotateWindow
    : label === "launchpad" ? LaunchpadWindow
    : label === "pet-catalog" ? PetCatalogWindow
    : label === "prompt-library" ? PromptLibraryWindow
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
