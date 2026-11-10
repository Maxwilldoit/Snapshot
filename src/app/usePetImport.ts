import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { addPetAssets } from "../lib/backend";
import { fileNameOf } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { errorText, useApp } from "./context";

const ACCEPTED = /\.(zip|gif|webm)$/i;

/**
 * 导入伴侣素材：侧栏的「+」和桌面伴侣页的拖放共用。
 * 导入成功后后端会直接换上新的那只，这里顺手把桌面伴侣页切到它。
 * 没导进来的几个用一条出错提示列出来（出错提示会留着，等用户自己关）。
 */
export function usePetImport() {
  const { onSaved, notify, navigate } = useApp();
  const { t } = useI18n();
  const [importing, setImporting] = useState(false);

  async function importPaths(paths: string[]) {
    const accepted = paths.filter((path) => ACCEPTED.test(path));
    const skipped = paths.filter((path) => !ACCEPTED.test(path));
    if (!accepted.length) {
      if (skipped.length) notify(t("只认 ZIP、GIF 或 WebM"), "error");
      return;
    }
    setImporting(true);
    try {
      const result = await addPetAssets(accepted);
      onSaved(result.settings);
      const failures = [...result.failed, ...skipped.map((path) => ({ path, reason: t("不是 ZIP、GIF 或 WebM") }))];
      if (result.imported > 0) navigate("pet", { petId: result.settings.selectedAppearanceId });
      if (failures.length) {
        notify(
          (failures.length === 1 ? t("这 1 个没导进来：") : t("这 {count} 个没导进来：", { count: failures.length }))
            + failures.map((item) => t("{file}（{reason}）", { file: fileNameOf(item.path), reason: item.reason })).join(t("、")),
          "error",
        );
      } else if (result.imported > 0) {
        notify(result.imported === 1
          ? t("导入了 1 只，已经换上")
          : t("导入了 {count} 只", { count: result.imported }));
      }
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setImporting(false);
    }
  }

  async function pickFiles() {
    try {
      const picked = await open({ multiple: true, directory: false, filters: [{ name: t("伴侣素材"), extensions: ["zip", "gif", "webm"] }] });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (paths.length) await importPaths(paths);
    } catch {
      notify(t("当前环境不支持选择文件"), "error");
    }
  }

  return { importing, importPaths, pickFiles };
}
