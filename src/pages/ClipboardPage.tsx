import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCopy, Trash2 } from "lucide-react";
import { copyClipboardHistory, deleteClipboardHistory, listClipboardHistory, onClipboardHistoryChanged } from "../lib/backend";
import { clipboardImageUrl } from "../lib/media";
import { formatClock, groupByDay } from "../lib/format";
import { stagger } from "../lib/motion";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { Toolbar } from "../app/Shell";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import { usePreferences } from "../hooks/usePreferences";
import { Switch } from "../components/ui/Switch";
import type { ClipboardHistoryEntry } from "../types";

/**
 * 剪贴板历史（macOS / Linux）：设置打开后记录复制的文字与图片，按天分组。
 * 点一条把它放回剪贴板；可单条删除或整个清空。密码管理器标记的敏感内容不会出现在这里。
 */
export function ClipboardPage() {
  const { settings, notify } = useApp();
  const update = usePreferences();
  const { t } = useI18n();
  const [records, setRecords] = useState<ClipboardHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const enabled = settings.clipboardHistory === true;

  const refresh = useCallback(async () => {
    try {
      const list = await listClipboardHistory();
      setRecords(Array.isArray(list) ? list : []);
    } catch (error) {
      setRecords([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const pending = onClipboardHistoryChanged(() => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const sorted = [...(records ?? [])].sort((a, b) => b.createdAt - a.createdAt);
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((item) => item.kind === "text" && item.text.toLowerCase().includes(needle));
  }, [records, query]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.createdAt), [filtered]);

  async function copyBack(item: ClipboardHistoryEntry) {
    try {
      await copyClipboardHistory(item.id);
      notify(t("已放回剪贴板"));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  async function remove(ids: string[]) {
    setBusy(true);
    try {
      setRecords(await deleteClipboardHistory(ids));
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }

  const toolbar = (
    <Toolbar title={t("剪贴板")}>
      <SearchField value={query} onChange={setQuery} label={t("搜索剪贴板历史")} />
      {(records?.length ?? 0) > 0 && (
        <button
          type="button"
          className="tb-btn"
          aria-label={t("清空剪贴板历史")}
          title={t("清空剪贴板历史")}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 aria-hidden="true" />
        </button>
      )}
    </Toolbar>
  );

  let body;
  if (records === null) {
    body = <LoadingState text={t("正在读取剪贴板历史…")} />;
  } else if (!enabled && records.length === 0) {
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("剪贴板历史未开启")}</h2>
        <p className="empty-body">{t("打开开关后，复制的文字和图片会记录在这里，随时放回剪贴板。密码管理器标记的敏感内容不会被记录。")}</p>
      </div>
    );
  } else if (records.length === 0) {
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有剪贴板记录")}</h2>
        <p className="empty-body">{t("复制一段文字或一张图片，稍等片刻就会出现在这里。")}</p>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <p className="empty-line mw-empty-line">
        {t("没有含「{query}」的剪贴板记录。", { query: query.trim() })}
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
              {group.items.map((item) => (
                <ClipboardRow key={item.id} record={item} index={order++} onCopy={() => void copyBack(item)} onDelete={() => void remove([item.id])} />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="mw-page clipboard-page">
      {toolbar}
      <div className="mw-scroll">
        <div className="clipboard-toggle-row">
          <label className="row-label" htmlFor="pref-clipboardHistory">{t("记录剪贴板历史")}</label>
          <Switch
            id="pref-clipboardHistory"
            label={t("记录剪贴板历史")}
            value={enabled}
            onChange={(value) => void update({ clipboardHistory: value })}
          />
        </div>
        {body}
      </div>
      {confirmClear && (
        <ConfirmDialog
          title={t("清空剪贴板历史？")}
          body={t("所有记录和图片会被删除，无法恢复。")}
          confirmLabel={t("清空")}
          busy={busy}
          onConfirm={() => void remove((records ?? []).map((item) => item.id))}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

function ClipboardRow({ record, index, onCopy, onDelete }: {
  record: ClipboardHistoryEntry;
  index: number;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const isImage = record.kind === "image";
  const summary = isImage
    ? t("图片 {width} × {height}", { width: record.width, height: record.height })
    : record.text.replace(/\s+/g, " ").trim();
  return (
    <div className="clip-entry" style={stagger(index)}>
      <button
        type="button"
        className="clip-main"
        title={t("放回剪贴板")}
        onClick={onCopy}
      >
        <time className="mono small quiet">{formatClock(record.createdAt)}</time>
        {isImage ? (
          <img className="clip-thumb" src={clipboardImageUrl(record.id)} alt={summary} loading="lazy" />
        ) : (
          <span className="clip-text" title={record.text}>{summary}</span>
        )}
        <ClipboardCopy className="clip-copy-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="clip-delete"
        aria-label={t("删除这条记录")}
        title={t("删除这条记录")}
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}
