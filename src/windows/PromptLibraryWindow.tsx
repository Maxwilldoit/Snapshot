import { LibraryWindow } from "../components/LibraryWindow";
import { useI18n, useWindowTitle } from "../lib/i18n";
import { PromptLibraryPage } from "../pages/PromptLibraryPage";

/** 兼容已有的窗口 label；正常入口在主窗口中打开同一份 Prompt 库。 */
export function PromptLibraryWindow() {
  const { t } = useI18n();
  useWindowTitle(t("Prompt 库"));
  return <LibraryWindow><PromptLibraryPage standalone /></LibraryWindow>;
}
