import { useCallback, useEffect, useMemo, useState } from "react";
import { LibraryBig, Settings2 } from "lucide-react";
import { listPromptHistory, onPromptHistoryChanged, runAction, showPromptLibrary } from "../lib/backend";
import { groupByDay } from "../lib/format";
import { PromptHistoryRow } from "../components/PromptHistoryRow";
import { LoadingState } from "../components/LoadingState";
import { Toolbar } from "../app/Shell";
import { SearchField } from "../components/SearchField";
import { PromptSettings } from "../components/PromptSettings";
import { Keys } from "../components/ui/Keys";
import { acceleratorOf } from "../lib/shortcuts";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { PromptHistoryEntry } from "../types";

/** Prompt 记录：每次成功润色的原文、结果和所用规则，按天分组；点一条展开全文 */
export function PromptsPage() {
  const { notify, settings, conflicts } = useApp();
  const { t } = useI18n();
  const [records, setRecords] = useState<PromptHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const shortcut = settings.shortcutsPaused ? null : acceleratorOf(settings, "polish");

  const refresh = useCallback(async () => {
    try {
      const list = await listPromptHistory();
      setRecords(Array.isArray(list) ? list : []);
    } catch (error) {
      setRecords([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const pending = onPromptHistoryChanged(() => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...(records ?? [])].sort((a, b) => b.createdAt - a.createdAt);
    if (!needle) return sorted;
    return sorted.filter((item) => [item.original, item.polished, item.template].some((text) => text.toLowerCase().includes(needle)));
  }, [records, query]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.createdAt), [filtered]);

  const toolbar = (
    <Toolbar title={t("Prompt 记录")}>
      <SearchField value={query} onChange={setQuery} label={t("搜索 Prompt")} />
      <button
        type="button"
        className="tb-btn"
        aria-label={t("打开 Prompt 库")}
        title={t("打开 Prompt 库")}
        onClick={() => void showPromptLibrary().catch((error) => notify(errorText(error), "error"))}
      >
        <LibraryBig aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label={t("设置")}
        title={t("设置")}
        aria-expanded={showSettings}
        aria-controls="prompt-settings"
        onClick={() => setShowSettings((value) => !value)}
      >
        <Settings2 aria-hidden="true" />
      </button>
    </Toolbar>
  );

  if (records === null) {
    return (
      <div className="mw-page">
        {toolbar}
        <LoadingState text={t("正在读取历史记录…")} />
      </div>
    );
  }

  let body;
  if (records.length === 0) {
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有 Prompt 记录")}</h2>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary" onClick={() => void runAction("polish").catch((error) => notify(errorText(error), "error"))}>
            {t("润色 Prompt")}{shortcut && !conflicts.includes(shortcut) && <span aria-hidden="true"><Keys value={shortcut} quiet /></span>}
          </button>
        </div>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <p className="empty-line mw-empty-line">
        {t("没有含「{query}」的历史记录。", { query: query.trim() })}
        <button type="button" className="link" onClick={() => setQuery("")}>{t("清除筛选")}</button>
      </p>
    );
  } else {
    let order = 0;
    body = (
      <div className="prompt-groups">
        {groups.map((group) => (
          <section className="day" key={group.key} aria-label={group.label}>
            <div className="day-label">
              <h2 className="day-title">{group.label}</h2>
            </div>
            <div className="prompt-list">
              {group.items.map((item) => <PromptHistoryRow key={item.id} record={item} index={order++} />)}
            </div>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="mw-page prompts-page">
      {toolbar}
      <div className={`mw-scroll ${showSettings ? "pane" : ""}`}>
        {showSettings ? <PromptSettings /> : body}
      </div>
    </div>
  );
}
