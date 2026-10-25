import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteSnapshots,
  listPromptHistory,
  listSnapshots,
  onPromptHistoryChanged,
  onSnapshotsChanged,
  openSnapshotsDir,
  savePreferences,
} from "../lib/backend";
import { formatBytes, formatClock, groupByDay } from "../lib/format";
import { useFlip, wait, DURATION, stagger, usePresence } from "../lib/motion";
import { SnapshotThumb } from "../components/SnapshotThumb";
import { Lightbox } from "../components/Lightbox";
import { PromptHistoryRow } from "../components/PromptHistoryRow";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { acceleratorOf } from "./ShortcutsPage";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { PromptHistoryEntry, SnapshotRecord } from "../types";

type HistoryItem =
  | { kind: "snapshot"; at: number; snapshot: SnapshotRecord }
  | { kind: "prompt"; at: number; prompt: PromptHistoryEntry };

export function HistoryPage() {
  const { settings, onSaved, notify, pendingPreviewId, consumePreviewId } = useApp();
  const { t } = useI18n();
  const [records, setRecords] = useState<SnapshotRecord[] | null>(null);
  const [promptRecords, setPromptRecords] = useState<PromptHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const flip = useFlip(listRef);

  const refresh = useCallback(async () => {
    try {
      const list = await listSnapshots();
      const next = Array.isArray(list) ? list : [];
      // 第一次加载不算「新来的」；之后多出来的那几张要从顶上挤进来
      if (known.current) {
        const added = next.filter((item) => !known.current!.has(item.id)).map((item) => item.id);
        if (added.length) setFresh(new Set(added));
      }
      known.current = new Set(next.map((item) => item.id));
      flip.capture();
      setRecords(next);
    } catch (error) {
      setRecords([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPrompts = useCallback(async () => {
    try {
      const list = await listPromptHistory();
      setPromptRecords(Array.isArray(list) ? list : []);
    } catch (error) {
      setPromptRecords([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    void refreshPrompts();
    const pending = onSnapshotsChanged(() => void refresh());
    const promptPending = onPromptHistoryChanged(() => void refreshPrompts());
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
      void promptPending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh, refreshPrompts]);

  // 从时间线点进来的那张，直接放大
  useEffect(() => {
    if (!pendingPreviewId || !records) return;
    if (records.some((item) => item.id === pendingPreviewId)) setPreviewId(pendingPreviewId);
    consumePreviewId();
  }, [pendingPreviewId, records, consumePreviewId]);

  useEffect(() => {
    if (!fresh.size) return;
    const timer = window.setTimeout(() => setFresh(new Set()), 1400);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const historyItems = useMemo<HistoryItem[]>(() => {
    const snapshots: HistoryItem[] = (records ?? []).map((snapshot) => ({
      kind: "snapshot",
      at: snapshot.createdAt,
      snapshot,
    }));
    const prompts: HistoryItem[] = (promptRecords ?? []).map((prompt) => ({
      kind: "prompt",
      at: prompt.createdAt,
      prompt,
    }));
    return [...snapshots, ...prompts].sort((left, right) => right.at - left.at);
  }, [records, promptRecords]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return historyItems.filter((item) => {
      if (selecting && item.kind !== "snapshot") return false;
      if (!needle) return true;
      if (item.kind === "snapshot") return item.snapshot.appName.toLowerCase().includes(needle);
      const prompt = item.prompt;
      return [prompt.original, prompt.polished, prompt.template]
        .some((text) => text.toLowerCase().includes(needle));
    });
  }, [historyItems, query, selecting]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.at), [filtered]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  useEffect(() => {
    if (!selecting || previewId || confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, previewId, confirming, exitSelecting]);

  function toggle(id: string, range: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (range && anchor) {
        const from = filtered.findIndex((item) => item.kind === "snapshot" && item.snapshot.id === anchor);
        const to = filtered.findIndex((item) => item.kind === "snapshot" && item.snapshot.id === id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          filtered.slice(start, end + 1).forEach((item) => {
            if (item.kind === "snapshot") next.add(item.snapshot.id);
          });
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  }

  function toggleGroup(ids: string[]) {
    setSelected((current) => {
      const next = new Set(current);
      const all = ids.every((id) => next.has(id));
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  async function remove(ids: string[]) {
    if (!ids.length) return;
    setDeleting(true);
    try {
      // 先消失再合拢：顺序反了会像是别的条目被删了
      setLeaving(new Set(ids));
      await wait(DURATION.fade);
      const next = await deleteSnapshots(ids);
      known.current = new Set(next.map((item) => item.id));
      flip.capture();
      setRecords(next);
      setLeaving(new Set());
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      notify(t(ids.length === 1 ? "删掉了 1 张快照" : "删掉了 {count} 张快照", { count: ids.length }));
    } catch (error) {
      setLeaving(new Set());
      notify(errorText(error), "error");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  async function revealFolder() {
    try {
      await openSnapshotsDir();
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  const selectedBytes = useMemo(
    () => (records ?? []).filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.sizeBytes, 0),
    [records, selected],
  );

  const total = records?.length ?? 0;
  const promptTotal = promptRecords?.length ?? 0;
  const totalItems = total + promptTotal;
  const visibleSnapshotIds = useMemo(
    () => filtered.flatMap((item) => (item.kind === "snapshot" ? [item.snapshot.id] : [])),
    [filtered],
  );
  const previewRecords = useMemo(() => {
    const visible = filtered.flatMap((item) => (item.kind === "snapshot" ? [item.snapshot] : []));
    return visible.length ? visible : (records ?? []);
  }, [filtered, records]);
  const allSelected = total > 0 && selected.size === total;
  const allVisibleSelected = visibleSnapshotIds.length > 0
    && visibleSnapshotIds.every((id) => selected.has(id));
  // 退场时文案别跟着变成「删除 0 张」：打开那一刻的文案一直留到对话框淡出
  const confirmDialog = usePresence(
    confirming
      ? {
          title: allSelected
            ? t(total === 1 ? "删除全部 1 张快照？" : "删除全部 {count} 张快照？", { count: total })
            : t(selected.size === 1 ? "删除选中的 1 张快照？" : "删除选中的 {count} 张快照？", { count: selected.size }),
          label: t("删除 {count} 张", { count: selected.size }),
        }
      : null,
  );

  if (records === null || promptRecords === null) {
    return <LoadingState text={t("正在读取历史记录…")} />;
  }

  const header = selecting ? (
    <div className="history-bar">
      <span className="strong">{t("已选 {count} 张", { count: selected.size })}</span>
      {selected.size > 0 && <span className="mono small quiet">{formatBytes(selectedBytes)}</span>}
      <button
        type="button"
        className="link small"
        onClick={() => {
          if (allVisibleSelected) {
            setSelected(new Set());
          } else {
            setSelected(new Set([...selected, ...visibleSnapshotIds]));
          }
        }}
      >
        {allVisibleSelected
          ? t("全不选")
          : t("全选 {count} 张", { count: visibleSnapshotIds.length })}
      </button>
      <span className="spacer" />
      <button type="button" className="text-btn ink-2" onClick={exitSelecting}>{t("取消")}</button>
      <button
        type="button"
        className="btn btn-danger btn-small"
        disabled={selected.size === 0}
        onClick={() => setConfirming(true)}
      >
        {selected.size > 0 ? t("删除 {count} 张", { count: selected.size }) : t("删除")}
      </button>
    </div>
  ) : (
    <div className="history-bar">
      <label className="search">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 8l3.5 3.5" stroke="currentColor" strokeWidth="1.2" /></svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索历史记录")} aria-label={t("搜索历史记录")} />
        {query && (
          <button type="button" className="search-clear" aria-label={t("清除筛选")} onClick={() => setQuery("")}>
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M.5.5l7 7M7.5.5l-7 7" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
        )}
      </label>
      <span className="mono small quiet">
        {query ? `${filtered.length} / ${totalItems}` : totalItems === 1 ? t("1 项") : t("{count} 项", { count: totalItems })}
      </span>
      <span className="spacer" />
      <button type="button" className="text-btn small ink-2" onClick={() => void revealFolder()}>{t("打开快照文件夹")}</button>
      <button type="button" className="btn btn-small" onClick={() => setSelecting(true)} disabled={total === 0}>{t("选择快照")}</button>
    </div>
  );

  let body;
  if (totalItems === 0) {
    const shortcut = acceleratorOf(settings, "snapshot");
    body = settings.autoSaveLocal ? (
      <div className="empty">
        <h2 className="empty-title">{t("还没有历史记录")}</h2>
        <p className="empty-body">
          {shortcut
            ? <>
                {t("截取窗口或成功润色后，记录会按时间显示在这里。右键桌宠可打开快捷菜单")}
                {t("；按 {keys} 也可以直接截取当前窗口。", { keys: shortcut })}
              </>
            : t("截取窗口或成功润色后，记录会按时间显示在这里。右键桌宠可打开快捷菜单。")}
        </p>
      </div>
    ) : (
      <div className="empty">
        <h2 className="empty-title">{t("还没有历史记录")}</h2>
        <p className="empty-body">{t("快照和 Prompt 历史会显示在这里；「截图同时存进历史」现在是关的，截图只进剪贴板。")}</p>
        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              savePreferences({ autoSaveLocal: true })
                .then((next) => {
                  onSaved(next);
                  notify(t("打开了：之后的截图会留在这里"));
                })
                .catch((error) => notify(errorText(error), "error"))
            }
          >
            {t("同时保存截图")}
          </button>
        </div>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <p className="empty-line">
        {t("没有含「{query}」的历史记录。", { query: query.trim() })}
        <button type="button" className="link" onClick={() => setQuery("")}>{t("清除筛选")}</button>
      </p>
    );
  } else {
    // 逐个入场只数前十几张：再往后已经在屏幕外，等也白等
    let order = 0;
    body = (
      <div className="history-groups" ref={listRef}>
        {groups.map((group) => {
          const ids = group.items.flatMap((item) => (item.kind === "snapshot" ? [item.snapshot.id] : []));
          const picked = ids.filter((id) => selected.has(id)).length;
          return (
            <section className="day" key={group.key} aria-label={group.label}>
              <div className="day-label">
                <h3 className="day-title">{group.label}</h3>
                <span className="small quiet">
                  {selecting && picked
                    ? t("选了 {picked} / {count}", { picked, count: ids.length })
                    : group.items.length === 1 ? t("1 项") : t("{count} 项", { count: group.items.length })}
                </span>
                {selecting && ids.length > 0 && (
                  <button type="button" className="link small" onClick={() => toggleGroup(ids)}>
                    {picked === ids.length ? t("取消整组") : t("选整组")}
                  </button>
                )}
              </div>
              <div className="day-items">
                {group.items.map((item) =>
                  item.kind === "snapshot" ? (
                    <figure
                      key={`snapshot-${item.snapshot.id}`}
                      data-flip-key={item.snapshot.id}
                      style={stagger(order++)}
                      className={`shot ${leaving.has(item.snapshot.id) ? "is-leaving" : ""} ${fresh.has(item.snapshot.id) ? "is-fresh" : ""}`}
                    >
                      <SnapshotThumb
                        id={item.snapshot.id}
                        width={item.snapshot.width}
                        height={item.snapshot.height}
                        label={item.snapshot.appName}
                        selecting={selecting}
                        selected={selected.has(item.snapshot.id)}
                        onPress={(_element, event) => {
                          if (selecting) toggle(item.snapshot.id, event.shiftKey);
                          else setPreviewId(item.snapshot.id);
                        }}
                      />
                      <figcaption className="shot-caption">
                        <span className="shot-name" title={item.snapshot.appName}>{item.snapshot.appName}</span>
                        <span className="mono small quiet">{formatClock(item.snapshot.createdAt)} · {formatBytes(item.snapshot.sizeBytes)}</span>
                      </figcaption>
                    </figure>
                  ) : (
                    <PromptHistoryRow key={`prompt-${item.prompt.id}`} record={item.prompt} index={order++} />
                  ),
                )}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="history-page">
      {header}
      <div className="history-scroll">{body}</div>

      {previewId && (
        <Lightbox
          records={previewRecords}
          startId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
      {confirmDialog.item && (
        <ConfirmDialog
          title={confirmDialog.item.title}
          body={t("图片文件会从本机一起删掉，没法恢复。")}
          confirmLabel={confirmDialog.item.label}
          busy={deleting}
          leaving={confirmDialog.leaving}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove([...selected]).then(() => allSelected && exitSelecting())}
        />
      )}
    </div>
  );
}
