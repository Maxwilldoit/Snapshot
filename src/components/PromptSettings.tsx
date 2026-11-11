import { useState } from "react";
import { useApp } from "../app/context";
import { usePresence } from "../lib/motion";
import { useI18n } from "../lib/i18n";
import { ModelSettingsDialog } from "./ModelSettingsDialog";
import { RulesPanel } from "./RulesPanel";

export function PromptSettings() {
  const { settings, onSaved, notify } = useApp();
  const { t } = useI18n();
  const [editingModel, setEditingModel] = useState(false);
  const modelDialog = usePresence(editingModel || null);
  return (
    <div className="form cols prompt-settings" id="prompt-settings">
      <section className="panel">
        <h2 className="panel-title">{t("润色用的模型")}</h2>
        <div className="rows">
          <div className="row">
            <span className="row-label">{settings.model || t("还没填")}</span>
            <button
              type="button"
              className="link"
              onClick={() => setEditingModel(true)}
            >
              {settings.model ? t("更改") : t("去填写")}
            </button>
          </div>
        </div>
      </section>
      <RulesPanel />
      {modelDialog.item && (
        <ModelSettingsDialog
          settings={settings}
          onSaved={onSaved}
          notify={notify}
          onClose={() => setEditingModel(false)}
          leaving={modelDialog.leaving}
        />
      )}
    </div>
  );
}
