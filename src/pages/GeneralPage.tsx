import { Switch } from "../components/ui/Switch";
import { Choices } from "../components/ui/Choices";
import { useApp } from "../app/context";
import { Toolbar } from "../app/Shell";
import { usePreferences } from "../hooks/usePreferences";
import { useI18n } from "../lib/i18n";

/** 通用只管理应用级偏好；模型和规则在 Prompt 页。 */
export function GeneralPage() {
  const { t } = useI18n();
  return (
    <div className="mw-page">
      <Toolbar title={t("通用")} />
      <div className="mw-scroll pane">
        <div className="form form-narrow">
          <LanguagePanel />
        </div>
      </div>
    </div>
  );
}

/** 应用级偏好：语言和开机启动。 */
function LanguagePanel() {
  const { preference, setLanguagePreference, t } = useI18n();
  const { settings, caps } = useApp();
  const update = usePreferences();
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
        {caps?.autostart.available !== false && (
          <div className="row">
            <label className="row-label" htmlFor="pref-launchOnBoot">{t("开机时静默启动")}</label>
            <Switch
              id="pref-launchOnBoot"
              label={t("开机时静默启动")}
              value={settings.launchOnBoot}
              onChange={(value) => void update({ launchOnBoot: value })}
            />
          </div>
        )}
      </div>
    </section>
  );
}
