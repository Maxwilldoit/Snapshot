import { useCallback, useEffect, useRef, useState } from "react";
import { Film, ImageIcon, RotateCcw, Trash2 } from "lucide-react";
import { Toolbar } from "../app/Shell";
import { errorText, useApp } from "../app/context";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { listTrash, onRecordingsChanged, onSnapshotsChanged, purgeTrash, restoreTrash } from "../lib/backend";
import { formatBytes, formatCalendarDate, formatClock } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { trashThumbUrl } from "../lib/media";
import type { TrashEntry } from "../types";

export function TrashPage() {
  const { notify, pageCache } = useApp();
  const { t, language } = useI18n();
  const [entries, setEntries] = useState<TrashEntry[] | null>(() => pageCache?.trash?.entries ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const focusTarget = useRef<HTMLDivElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const revision = ++request.current;
    try {
      const next = await listTrash();
      if (revision !== request.current) return;
      setEntries(next);
      setLoadFailed(false);
    } catch (error) {
      if (revision !== request.current) return;
      setLoadFailed(true);
      notify(errorText(error), "error");
    }
  }, [notify]);

  useEffect(() => {
    if (pageCache && entries !== null) {
      pageCache.trash = { entries };
    }
  }, [pageCache, entries]);

  useEffect(() => {
    void refresh();
    const subscriptions = [onSnapshotsChanged(() => void refresh()), onRecordingsChanged(() => void refresh())];
    return () => {
      request.current += 1;
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  async function perform(operation: () => Promise<void>, message?: string) {
    setBusy(true);
    try {
      await operation();
      if (message) notify(message);
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      await refresh();
      setBusy(false);
      setPending(null);
      focusTarget.current?.focus();
    }
  }

  function confirm(ids: string[], trigger: HTMLButtonElement) {
    dialogTrigger.current = trigger;
    setPending(ids);
  }

  function cancel() {
    if (busy) return;
    setPending(null);
    dialogTrigger.current?.focus();
  }

  return (
    <div className="mw-page trash-page">
      <Toolbar title={t("回收站")}>
        {!!entries?.length && (
          <button type="button" className="tb-btn is-danger" aria-label={t("清空回收站")} title={t("清空回收站")} disabled={busy}
            onClick={(event) => confirm(entries.map((entry) => entry.id), event.currentTarget)}>
            <Trash2 aria-hidden="true" />
          </button>
        )}
      </Toolbar>
      <div className="mw-scroll" role="region" aria-label={t("回收站内容")} tabIndex={-1} ref={focusTarget}>
        {loadFailed ? (
          <div className="empty mw-empty">
            <h2 className="empty-title">{t("无法读取回收站")}</h2>
            <button type="button" className="btn" onClick={() => void refresh()}>{t("重试")}</button>
          </div>
        ) : entries === null ? (
          <LoadingState text={t("正在读取回收站…")} />
        ) : entries.length === 0 ? (
          <div className="empty mw-empty"><h2 className="empty-title">{t("回收站为空")}</h2></div>
        ) : (
          <ul className="trash-list">
            {entries.map((entry) => {
              const { record } = entry;
              const thumb = entry.kind === "snapshot";
              return (
                <li className="trash-row" key={entry.id}>
                  <div className="trash-thumb" aria-hidden="true">
                    {thumb ? <ImageIcon /> : <Film />}
                    {thumb && <img alt="" loading="lazy" decoding="async" src={trashThumbUrl(entry.id)} onError={(event) => { event.currentTarget.hidden = true; }} />}
                  </div>
                  <div className="trash-details">
                    <div className="trash-name" title={record.fileName}>{record.appName || record.fileName}</div>
                    <div className="trash-meta">
                      {t(thumb ? "截图" : "录制")} · {formatBytes(record.sizeBytes)} · {formatCalendarDate(entry.trashedAt, Date.now(), language)} {formatClock(entry.trashedAt)}
                    </div>
                  </div>
                  <button type="button" className="tb-btn" aria-label={t("恢复 {name}", { name: record.fileName })} title={t("恢复")} disabled={busy}
                    onClick={() => void perform(() => restoreTrash(entry.id), t("已恢复到历史记录"))}>
                    <RotateCcw aria-hidden="true" />
                  </button>
                  <button type="button" className="tb-btn is-danger" aria-label={t("永久删除 {name}", { name: record.fileName })} title={t("永久删除")} disabled={busy}
                    onClick={(event) => confirm([entry.id], event.currentTarget)}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {pending && (
        <ConfirmDialog
          title={t(pending.length === 1 ? "永久删除这项？" : "永久删除 {count} 项？", { count: pending.length })}
          body={t("文件会从本机一起删掉，没法恢复。")}
          confirmLabel={t("永久删除")}
          busy={busy}
          onCancel={cancel}
          onConfirm={() => void perform(() => purgeTrash(pending))}
        />
      )}
    </div>
  );
}
