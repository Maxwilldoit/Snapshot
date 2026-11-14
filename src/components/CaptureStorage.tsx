import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getRecordingDir, getSnapshotDir, openRecordingsDir, openSnapshotsDir } from "../lib/backend";
import { middleTruncatePath } from "../lib/format";
import { Choices } from "./ui/Choices";
import { Switch } from "./ui/Switch";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import { usePreferences } from "../hooks/usePreferences";

/** 快照、录像的保存位置：读一次实际路径，设置里的目录变了再读 */
function useStoragePaths() {
  const { settings } = useApp();
  const [snapshotPath, setSnapshotPath] = useState("");
  const [recordingPath, setRecordingPath] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.allSettled([getSnapshotDir(), getRecordingDir()]).then(([snapshot, recording]) => {
      if (!alive) return;
      if (snapshot.status === "fulfilled" && typeof snapshot.value === "string") setSnapshotPath(snapshot.value);
      if (recording.status === "fulfilled" && typeof recording.value === "string") setRecordingPath(recording.value);
    });
    return () => {
      alive = false;
    };
  }, [settings.saveDir, settings.recordingDir]);
  return { snapshotPath, setSnapshotPath, recordingPath, setRecordingPath };
}

function useStorageActions() {
  const { notify } = useApp();
  const { t } = useI18n();
  const update = usePreferences();
  async function pickDir(key: "saveDir" | "recordingDir") {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") await update({ [key]: selected }, key === "saveDir" ? t("快照保存位置已更改") : t("录像保存位置已更改"));
    } catch {
      notify(t("当前环境不支持选择目录"), "error");
    }
  }
  return { update, pickDir };
}

/** 截图怎么存：剪贴板多久清空、图片格式、存到哪个文件夹。放在「截图与录制」左栏 */
export function SnapshotStorageRows() {
  const { settings, notify } = useApp();
  const { t } = useI18n();
  const { snapshotPath, setSnapshotPath } = useStoragePaths();
  const { update, pickDir } = useStorageActions();

  async function openSnapshotFolder() {
    try {
      setSnapshotPath(await openSnapshotsDir());
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  return (
    <>
      <div className="row">
        <span className="row-label">{t("自动清空剪贴板")}</span>
        <Choices
          ariaLabel={t("自动清空剪贴板")}
          value={settings.clipboardAutoClear}
          onChange={(value) => void update({ clipboardAutoClear: value })}
          options={[
            { value: "30s", label: t("30 秒") },
            { value: "60s", label: t("60 秒") },
            { value: "5m", label: t("5 分钟") },
            { value: "never", label: t("不清空") },
          ]}
        />
      </div>
      <div className="row">
        <span className="row-label">{t("图像格式")}</span>
        <Choices
          ariaLabel={t("图像格式")}
          value={settings.snapshotFormat}
          onChange={(value) => void update({ snapshotFormat: value })}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpeg", label: "JPEG" },
            { value: "webp", label: "WebP" },
          ]}
        />
      </div>
      <div className="row storage-path-row">
        <span className="row-label">{t("保存快照到")}</span>
        <span className="row-links">
          <button
            type="button"
            className="storage-path mono small"
            title={snapshotPath || undefined}
            aria-label={t("打开快照文件夹：{path}", { path: snapshotPath || t("正在读取路径") })}
            onClick={() => void openSnapshotFolder()}
          >
            {snapshotPath ? middleTruncatePath(snapshotPath, 30) : t("正在读取路径…")}
          </button>
          <button type="button" className="link" onClick={() => void pickDir("saveDir")}>{t("更改")}</button>
        </span>
      </div>
    </>
  );
}

/** 录像存到哪、录不录声音。放在「截图与录制」右栏 */
export function RecordingPanel() {
  const { settings, caps, notify } = useApp();
  const { t } = useI18n();
  const { recordingPath, setRecordingPath } = useStoragePaths();
  const { update, pickDir } = useStorageActions();
  // Hide unavailable inputs without clearing preferences saved on another system.
  const audioToggles = [
    { key: "recordSystemAudio" as const, label: t("同时录系统声音"), available: !caps || caps.recordingSystemAudio.available },
    { key: "recordMicrophone" as const, label: t("同时录麦克风"), available: !caps || caps.recordingMicrophone.available },
  ].filter((toggle) => toggle.available);

  async function openRecordingFolder() {
    try {
      setRecordingPath(await openRecordingsDir());
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  if (caps && !caps.recording.available) return null;

  return (
    <section className="panel panel-storage">
      <h2 className="panel-title">{t("录制")}</h2>
      <div className="rows">
        <div className="row storage-path-row">
          <span className="row-label">{t("保存录像到")}</span>
          <span className="row-links">
            <button
              type="button"
              className="storage-path mono small"
              title={recordingPath || undefined}
              aria-label={t("打开录像文件夹：{path}", { path: recordingPath || t("正在读取路径") })}
              onClick={() => void openRecordingFolder()}
            >
              {recordingPath ? middleTruncatePath(recordingPath, 30) : t("正在读取路径…")}
            </button>
            <button type="button" className="link" onClick={() => void pickDir("recordingDir")}>{t("更改")}</button>
            {settings.recordingDir && (
              <button type="button" className="link" onClick={() => void update({ recordingDir: "" }, t("已恢复默认录像位置"))}>{t("恢复默认")}</button>
            )}
          </span>
        </div>
        {audioToggles.map((toggle) => (
          <div className="row" key={toggle.key}>
            <label className="row-label" htmlFor={`pref-${toggle.key}`}>{toggle.label}</label>
            <Switch
              id={`pref-${toggle.key}`}
              label={toggle.label}
              value={settings[toggle.key]}
              onChange={(value) => void update({ [toggle.key]: value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

