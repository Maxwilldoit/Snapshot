import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { savePreferences } from "../lib/backend";
import { previewHintSound } from "../lib/sound";
import { Switch } from "../components/ui/Switch";
import { Choices } from "../components/ui/Choices";
import { usePresence } from "../lib/motion";
import { ModelSettingsDialog } from "../components/ModelSettingsDialog";
import { errorText, useApp } from "../app/context";
import { RulesPanel } from "./RulesPanel";
import { PET_SCALE } from "../lib/petSize";
import type { Settings } from "../types";
import { useI18n } from "../lib/i18n";

function usePrefs() {
  const { onSaved, notify } = useApp();
  return async (patch: Partial<Settings>, message?: string) => {
    try {
      onSaved(await savePreferences(patch));
      if (message) notify(message);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };
}

/** 截屏时的声音、闪烁、截完做什么 */
export function BehaviorPanel() {
  const { settings, caps, notify } = useApp();
  const update = usePrefs();
  const { t } = useI18n();

  async function importShutterSound() {
    try {
      const selected = await open({ multiple: false, filters: [{ name: t("音效文件"), extensions: ["mp3", "wav", "ogg", "m4a"] }] });
      if (typeof selected === "string") {
        await update({ shutterSound: "custom", customSoundPath: selected }, t("自定义音效已导入"));
      }
    } catch {
      notify(t("当前环境不支持选择文件"), "error");
    }
  }

  const toggles: Array<{ key: keyof Settings; label: string; disabled?: boolean }> = [
    { key: "flashOnCapture", label: t("截屏时闪一下") },
    { key: "autoSaveLocal", label: t("截图同时存进历史") },
    { key: "hideAfterCopy", label: t("复制后隐藏主窗口") },
    { key: "includeCursor", label: t("截图带上鼠标指针"), disabled: caps ? !caps.includeCursor.available : false },
    { key: "launchOnBoot", label: t("开机时静默启动"), disabled: caps ? !caps.autostart.available : false },
  ];

  return (
    <section className="panel">
      <h2 className="panel-title">{t("截屏与行为")}</h2>
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
          <span className="sound-label">
            <span className="row-label">{t("快门声")}</span>
            {settings.shutterSound !== "none" && (
              <button
                type="button"
                className="link sound-preview"
                onClick={() =>
                  previewHintSound(
                    settings.shutterSound === "soft" ? "soft" : "crisp",
                    settings.shutterSound === "custom" ? settings.customSoundPath : null,
                    80,
                  )
                }
              >
                {t("试听")}
              </button>
            )}
          </span>
          <Choices
            ariaLabel={t("快门声")}
            value={settings.shutterSound}
            onChange={(value) => {
              if (value === "custom" && !settings.customSoundPath) {
                void importShutterSound();
                return;
              }
              void update({ shutterSound: value });
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

/** 桌宠在桌面上的大小 */
export function PetPanel() {
  const { settings } = useApp();
  const { t } = useI18n();
  const update = usePrefs();
  // 拖动时滑块跟手：本地先变，每挪一格就存一次，桌宠收到设置变化当场跟着缩放
  const [scale, setScale] = useState(settings.petScale);
  const change = (value: number) => {
    setScale(value);
    void update({ petScale: value });
  };

  return (
    <section className="panel">
      <h2 className="panel-title">{t("桌面宠物")}</h2>
      <div className="rows">
        <div className="row">
          <label className="row-label" htmlFor="pref-petScale">{t("大小")}</label>
          <span className="row-links small">
            {scale !== PET_SCALE.default && (
              <button type="button" className="link" onClick={() => change(PET_SCALE.default)}>{t("恢复默认")}</button>
            )}
            <input
              id="pref-petScale"
              className="range"
              type="range"
              min={PET_SCALE.min}
              max={PET_SCALE.max}
              step={PET_SCALE.step}
              value={scale}
              aria-valuetext={`${scale}%`}
              onChange={(event) => change(Number(event.target.value))}
            />
            <span className="mono ink-2 range-value">{scale}%</span>
          </span>
        </div>
      </div>
    </section>
  );
}

/** 这台机器能做什么（各端 adapter 实时报告）+ 模型 */
export function MachinePanel() {
  const { settings, caps } = useApp();
  const { t } = useI18n();
  const [editingModel, setEditingModel] = useState(false);
  const modelDialog = usePresence(editingModel || null);
  const { onSaved, notify } = useApp();

  const capabilities = caps
    ? [
        { label: t("窗口录制"), ...caps.recording },
        ...(caps.scrolling ? [{ label: t("滚动长截图"), ...caps.scrolling }] : []),
      ]
    : [];

  return (
    <section className="panel">
      <h2 className="panel-title">{t("本机与模型")}</h2>
      <div className="rows">
        <div className="row">
          <span className="row-label">{t("润色用的模型")}</span>
          <span className="row-links small">
            <span className={settings.model ? "mono ink-2" : "signal"}>{settings.model || t("还没填")}</span>
            <button type="button" className="link" onClick={() => setEditingModel(true)}>
              {settings.model ? t("修改") : t("去填写")}
            </button>
          </span>
        </div>
        {caps && (
          <div className="row">
            <span className="row-label">{t("系统")}</span>
            <span className="mono small ink-2">{caps.os} · {caps.displayServer}</span>
          </div>
        )}
        {capabilities.map((capability) => (
          <div className="row" key={capability.label}>
            <span className="row-label">{capability.label}</span>
            <span className={`small ${capability.available ? "ink-2" : "signal"}`}>{capability.available ? t("可用") : t("不可用")}</span>
          </div>
        ))}
      </div>
      {modelDialog.item && (
        <ModelSettingsDialog
          settings={settings}
          onSaved={onSaved}
          notify={notify}
          onClose={() => setEditingModel(false)}
          leaving={modelDialog.leaving}
        />
      )}
    </section>
  );
}

export function PreferencesPage() {
  return (
    <div className="page-grid page-grid-2">
      <div className="page-col">
        <LanguagePanel />
        <BehaviorPanel />
        <PetPanel />
      </div>
      <div className="page-col">
        <MachinePanel />
        <RulesPanel />
      </div>
    </div>
  );
}

export function LanguagePanel() {
  const { preference, setLanguagePreference, t } = useI18n();
  return (
    <section className="panel">
      <h2 className="panel-title">{t("界面语言")}</h2>
      <div className="rows">
        <div className="row">
          <span className="row-label">{t("界面语言")}</span>
          <Choices
            ariaLabel={t("界面语言")}
            value={preference}
            onChange={setLanguagePreference}
            options={[
              { value: "system", label: t("跟随系统") },
              { value: "zh", label: t("简体中文") },
              { value: "en", label: "English" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
