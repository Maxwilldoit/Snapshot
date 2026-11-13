import { open } from "@tauri-apps/plugin-dialog";
import { importCustomSound } from "../lib/backend";
import { previewHintSound } from "../lib/sound";
import { Switch } from "../components/ui/Switch";
import { Choices } from "../components/ui/Choices";
import { errorText, useApp } from "../app/context";
import { RecordingPanel, SnapshotStorageRows } from "../components/CaptureStorage";
import { Toolbar } from "../app/Shell";
import { usePreferences } from "../hooks/usePreferences";
import type { Settings } from "../types";
import { useI18n } from "../lib/i18n";

/** 截完做什么、存不存历史，以及怎么存（剪贴板、格式、位置） */
function SnapshotPanel() {
  const { settings } = useApp();
  const update = usePreferences();
  const { t } = useI18n();
  return (
    <section className="panel">
      <h2 className="panel-title">{t("截图")}</h2>
      <div className="rows">
        <div className="row">
          <span className="row-label">{t("截完之后")}</span>
          <Choices
            ariaLabel={t("截完之后")}
            value={settings.afterCapture}
            onChange={(value) => void update({ afterCapture: value })}
            options={[
              { value: "clipboard", label: t("放进剪贴板") },
              { value: "annotate", label: t("打开标注") },
              { value: "saveas", label: t("仅保存") },
            ]}
          />
        </div>
        <div className="row">
          <label className="row-label" htmlFor="pref-autoSaveLocal">{t("截图同时存进历史")}</label>
          <Switch
            id="pref-autoSaveLocal"
            label={t("截图同时存进历史")}
            value={settings.autoSaveLocal}
            onChange={(value) => void update({ autoSaveLocal: value })}
          />
        </div>
        <div className="row">
          <label className="row-label" htmlFor="pref-hideAfterCopy">{t("复制后隐藏主窗口")}</label>
          <Switch id="pref-hideAfterCopy" label={t("复制后隐藏主窗口")} value={settings.hideAfterCopy} onChange={(value) => void update({ hideAfterCopy: value })} />
        </div>
        <SnapshotStorageRows />
      </div>
    </section>
  );
}

/** 截屏那一下：快门声、闪一下、带不带鼠标指针 */
function BehaviorPanel() {
  const { settings, caps, notify, onSaved } = useApp();
  const update = usePreferences();
  const { t } = useI18n();

  async function importShutterSound() {
    let selected: string | string[] | null;
    try {
      selected = await open({ multiple: false, filters: [{ name: t("音效文件"), extensions: ["mp3", "wav", "ogg", "m4a"] }] });
    } catch {
      notify(t("当前环境不支持选择文件"), "error");
      return;
    }
    if (typeof selected !== "string") return;
    try {
      const saved = await importCustomSound(selected);
      onSaved(saved);
      previewHintSound("crisp", saved.customSoundPath, 80);
      notify(t("自定义音效已导入"));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  function playShutter(value: Settings["shutterSound"], customPath: string | null) {
    if (value === "none") return;
    previewHintSound(value === "soft" ? "soft" : "crisp", value === "custom" ? customPath : null, 80);
  }

  const toggles: Array<{ key: keyof Settings; label: string; disabled?: boolean }> = [
    { key: "flashOnCapture", label: t("截屏时闪一下") },
    { key: "includeCursor", label: t("截图带上鼠标指针"), disabled: caps ? !caps.includeCursor.available : false },
  ];

  return (
    <section className="panel">
      <h2 className="panel-title">{t("截图时")}</h2>
      <div className="rows">
        <div className="row">
          <span className="row-label">{t("快门声")}</span>
          <Choices
            ariaLabel={t("快门声")}
            value={settings.shutterSound}
            onChange={(value) => {
              if (value === "custom" && !settings.customSoundPath) {
                void importShutterSound();
                return;
              }
              if (value !== settings.shutterSound) void update({ shutterSound: value });
              playShutter(value, settings.customSoundPath);
            }}
            options={[
              { value: "crisp", label: t("清脆") },
              { value: "soft", label: t("轻柔") },
              { value: "none", label: t("静音") },
              { value: "custom", label: t("自定义") },
            ]}
          />
        </div>
        {toggles.map((toggle) => (
          <div className="row" key={toggle.key}>
            <label className="row-label" htmlFor={`pref-${toggle.key}`}>{toggle.label}</label>
            <Switch
              id={`pref-${toggle.key}`}
              label={toggle.label}
              value={Boolean(settings[toggle.key])}
              disabled={toggle.disabled}
              onChange={(value) => void update({ [toggle.key]: value } as Partial<Settings>)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** 设置 · 截图与录制：左栏截图，右栏截图时和录制 */
export function CapturePage() {
  const { t } = useI18n();
  return (
    <div className="mw-page">
      <Toolbar title={t("截图与录制")} />
      <div className="mw-scroll pane">
        <div className="form cols">
          <div className="page-col">
            <SnapshotPanel />
          </div>
          <div className="page-col">
            <BehaviorPanel />
            <RecordingPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
