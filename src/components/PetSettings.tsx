import { useEffect, useState } from "react";
import { Switch } from "./ui/Switch";
import { errorText, useApp } from "../app/context";
import { usePreferences } from "../hooks/usePreferences";
import { PET_SCALE } from "../lib/petSize";
import { ensurePetAutoScale, persistPetBaseScale, readPetBaseScale, resetPetBaseScale, watchPetBaseScales } from "../lib/petScale";
import { useI18n } from "../lib/i18n";

/**
 * 桌宠在桌面上的大小和动作。大小、走动、随机动作、重力对所有形象都一样；
 * 「100% 基准大小」是按形象单独存的，给了 assetId 就调那一只（桌面伴侣页正在看的），否则调桌面上那只。
 */
export function PetSettings({ assetId }: { assetId?: string } = {}) {
  const { settings, notify } = useApp();
  const { t } = useI18n();
  const update = usePreferences();
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
