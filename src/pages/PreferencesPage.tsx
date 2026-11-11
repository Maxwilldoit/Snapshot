import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { importCustomSound, savePreferences } from "../lib/backend";
import { previewHintSound } from "../lib/sound";
import { Switch } from "../components/ui/Switch";
import { Choices } from "../components/ui/Choices";
import { usePresence } from "../lib/motion";
import { ModelSettingsDialog } from "../components/ModelSettingsDialog";
import { errorText, useApp } from "../app/context";
import { RulesPanel } from "./RulesPanel";
import { RecordingPanel, SnapshotStorageRows } from "./ShortcutsPage";
import { Toolbar } from "../app/Shell";
import { PET_SCALE } from "../lib/petSize";
import { ensurePetAutoScale, persistPetBaseScale, readPetBaseScale, resetPetBaseScale, watchPetBaseScales } from "../lib/petScale";
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

/** 截完做什么、存不存历史，以及怎么存（剪贴板、格式、位置） */
export function SnapshotPanel() {
  const { settings } = useApp();
  const update = usePrefs();
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
        <SnapshotStorageRows />
      </div>
    </section>
  );
}

/** 截屏那一下：快门声、闪一下、带不带鼠标指针 */
export function BehaviorPanel() {
  const { settings, caps, notify, onSaved } = useApp();
  const update = usePrefs();
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
      onSaved(await importCustomSound(selected));
      notify(t("自定义音效已导入"));
    } catch (error) {
      notify(errorText(error), "error");
    }
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

/**
 * 桌宠在桌面上的大小和动作。大小、走动、随机动作、重力对所有形象都一样；
 * 「100% 基准大小」是按形象单独存的，给了 assetId 就调那一只（桌面伴侣页正在看的），否则调桌面上那只。
 */
export function PetPanel({ assetId }: { assetId?: string } = {}) {
  const { settings, notify } = useApp();
  const { t } = useI18n();
  const update = usePrefs();
  // 拖动时滑块跟手：本地先变，每挪一格就存一次，桌宠收到设置变化当场跟着缩放
  const [scale, setScale] = useState(settings.petScale);
  const selected = settings.petAssets.find((asset) => asset.id === (assetId ?? settings.selectedAppearanceId));
  const [baseScale, setBaseScale] = useState(() => readPetBaseScale(selected));
  useEffect(() => setScale(settings.petScale), [settings.petScale]);
  useEffect(() => {
    setBaseScale(readPetBaseScale(selected));
    if (selected) void ensurePetAutoScale(selected);
    return watchPetBaseScales(() => setBaseScale(readPetBaseScale(selected)));
  }, [selected]);
  const change = (value: number) => {
    setScale(value);
    void update({ petScale: value });
  };

  const changeBase = (value: number | null) => {
    if (!selected) return;
    try {
      if (value === null) resetPetBaseScale(selected.id);
      else persistPetBaseScale(selected.id, value);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">{t("桌面")}</h2>
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
        {selected && (
          <div className="row row-stack">
            <div className="row-line">
              <label className="row-label" htmlFor="pref-petBaseScale">{t("100% 基准大小")}</label>
              <span className="row-links small">
                <button type="button" className="link" onClick={() => changeBase(null)}>{t("自动适配")}</button>
                <input
                  id="pref-petBaseScale"
                  className="range"
                  type="range"
                  min={PET_SCALE.min}
                  max={PET_SCALE.max}
                  step={PET_SCALE.step}
                  value={baseScale}
                  aria-valuetext={`${baseScale}%`}
                  onChange={(event) => void changeBase(Number(event.target.value))}
                />
                <span className="mono ink-2 range-value">{baseScale}%</span>
              </span>
            </div>
            <span className="small quiet">{t("素材会自动适配大小；手动调整仅影响「{name}」", { name: selected.name })}</span>
          </div>
        )}
        <div className="row">
          <label className="row-label" htmlFor="pref-petWander">{t("自由走动")}</label>
          <Switch
            id="pref-petWander"
            label={t("自由走动")}
            value={Boolean(settings.petWander)}
            onChange={(value) => void update({ petWander: value })}
          />
        </div>
        <div className="row">
          <label className="row-label" htmlFor="pref-petRandomActions">{t("随机动作")}</label>
          <Switch
            id="pref-petRandomActions"
            label={t("随机动作")}
            value={Boolean(settings.petRandomActions)}
            onChange={(value) => void update({ petRandomActions: value })}
          />
        </div>
        <div className="row">
          <label className="row-label" htmlFor="pref-petGravity">{t("重力")}</label>
          <Switch
            id="pref-petGravity"
            label={t("重力")}
            value={settings.petGravity ?? true}
            onChange={(value) => void update({ petGravity: value })}
          />
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

/** 设置 · 通用：语言和启动、本机与模型在左，润色规则在右 */
export function GeneralPage() {
  const { t } = useI18n();
  return (
    <div className="mw-page">
      <Toolbar title={t("通用")} />
      <div className="mw-scroll pane">
        <div className="form cols">
          <div className="page-col">
            <LanguagePanel />
            <MachinePanel />
          </div>
          <div className="page-col">
            <RulesPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 界面语言、开机启动、复制后隐藏主窗口 */
export function LanguagePanel() {
  const { preference, setLanguagePreference, t } = useI18n();
  const { settings, caps } = useApp();
  const update = usePrefs();
  const toggles: Array<{ key: "launchOnBoot" | "hideAfterCopy"; label: string; disabled?: boolean }> = [
    { key: "launchOnBoot", label: t("开机时静默启动"), disabled: caps ? !caps.autostart.available : false },
    { key: "hideAfterCopy", label: t("复制后隐藏主窗口") },
  ];
  return (
    <section className="panel">
      <h2 className="panel-title">{t("通用")}</h2>
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
        {toggles.map((toggle) => (
          <div className="row" key={toggle.key}>
            <label className="row-label" htmlFor={`pref-${toggle.key}`}>{toggle.label}</label>
            <Switch
              id={`pref-${toggle.key}`}
              label={toggle.label}
              value={Boolean(settings[toggle.key])}
              disabled={toggle.disabled}
              onChange={(value) => void update({ [toggle.key]: value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
