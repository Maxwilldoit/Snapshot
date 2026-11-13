import { useCallback, useEffect, useMemo, useState } from "react";
import { LibraryBig, Settings2 } from "lucide-react";
import { listPromptHistory, onPromptHistoryChanged, runAction } from "../lib/backend";
import { groupByDay } from "../lib/format";
import { PromptHistoryRow } from "../components/PromptHistoryRow";
import { LoadingState } from "../components/LoadingState";
import { Toolbar } from "../app/Shell";
import { SearchField } from "../components/SearchField";
import { PromptSettings } from "../components/PromptSettings";
import { PromptLibraryPage } from "./PromptLibraryPage";
import { Keys } from "../components/ui/Keys";
import { acceleratorOf } from "../lib/shortcuts";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { PromptHistoryEntry } from "../types";

/**
 * Prompt 页：润色历史按天分组；Prompt 库和润色设置都是页内区块，
 * 用工具栏按钮切换，不再各占一个侧栏入口。
 */
export function PromptsPage({ active = true, libraryRequest = 0 }: { active?: boolean; libraryRequest?: number }) {
  const { notify, settings, conflicts } = useApp();
  const { t } = useI18n();
  const [records, setRecords] = useState<PromptHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"history" | "library" | "settings">("history");
  const [libraryFocusRequest, setLibraryFocusRequest] = useState(0);
  const shortcut = settings.shortcutsPaused ? null : acceleratorOf(settings, "polish");

  // 全局入口（快捷键、快捷菜单）打开库：切到本页、显示库区块并把焦点放进搜索框。
  useEffect(() => {
    if (libraryRequest === 0) return;
    setView("library");
    setLibraryFocusRequest((value) => value + 1);
  }, [libraryRequest]);

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

  const toggles = (
    <>
      <button
        type="button"
        className="tb-btn"
        aria-label={t("Prompt 库")}
        title={t("Prompt 库")}
        aria-expanded={view === "library"}
        onClick={() => setView((current) => (current === "library" ? "history" : "library"))}
      >
        <LibraryBig aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label={t("设置")}
        title={t("设置")}
        aria-expanded={view === "settings"}
        aria-controls="prompt-settings"
        onClick={() => setView((current) => (current === "settings" ? "history" : "settings"))}
      >
        <Settings2 aria-hidden="true" />
      </button>
    </>
  );

  const toolbar = (
    <Toolbar title={t("Prompt")}>
      {/* 页面隐藏时不渲染搜索框，避免抢走其它页的 Ctrl/Cmd+F */}
      {active && <SearchField value={query} onChange={setQuery} label={t("搜索 Prompt")} />}
      {toggles}
    </Toolbar>
  );

  let body;
  if (records === null) {
    body = <LoadingState text={t("正在读取历史记录…")} />;
  } else if (records.length === 0) {
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
      {view !== "library" && (
        <>
          {toolbar}
          {records === null ? body : (
            <div className={`mw-scroll ${view === "settings" ? "pane" : ""}`}>
              {view === "settings" ? <PromptSettings /> : body}
            </div>
          )}
        </>
      )}
      {/* 库常驻挂载：切区块、换页都不丢未保存的草稿；隐藏时不接管键盘。 */}
      <div className="library-embed" hidden={view !== "library"}>
        <PromptLibraryPage
          active={active && view === "library"}
          toolbarExtras={toggles}
          focusRequest={libraryFocusRequest}
        />
      </div>
    </div>
  );
}
