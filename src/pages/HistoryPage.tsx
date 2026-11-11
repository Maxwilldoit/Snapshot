import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import {
  deleteSnapshots,
  listSnapshots,
  onSnapshotsChanged,
  openSnapshotsDir,
  savePreferences,
  runAction,
} from "../lib/backend";
import { formatBytes, formatClock, groupByDay } from "../lib/format";
import { useFlip, wait, DURATION, stagger, usePresence } from "../lib/motion";
import { SnapshotThumb } from "../components/SnapshotThumb";
import { JustifiedGrid } from "../components/JustifiedGrid";
import { Lightbox } from "../components/Lightbox";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { Keys } from "../components/ui/Keys";
import { Toolbar } from "../app/Shell";
import { acceleratorOf } from "./ShortcutsPage";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { SnapshotRecord } from "../types";

/** 截图记录：按天分组、每组排成两端对齐的截图墙；点一张放大，「选择」后可以批量删除 */
export function HistoryPage() {
  const { settings, onSaved, notify, conflicts, pendingPreviewId, consumePreviewId } = useApp();
  const { t } = useI18n();
  const [records, setRecords] = useState<SnapshotRecord[] | null>(null);
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

  useEffect(() => {
    void refresh();
    const pending = onSnapshotsChanged(() => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  // 从别处点进来的那张，直接放大
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

  const sorted = useMemo(() => [...(records ?? [])].sort((a, b) => b.createdAt - a.createdAt), [records]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? sorted.filter((item) => item.appName.toLowerCase().includes(needle)) : sorted;
  }, [sorted, query]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.createdAt), [filtered]);

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
        const from = filtered.findIndex((item) => item.id === anchor);
        const to = filtered.findIndex((item) => item.id === id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          filtered.slice(start, end + 1).forEach((item) => next.add(item.id));
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
  const visibleIds = useMemo(() => filtered.map((item) => item.id), [filtered]);
  const previewRecords = filtered.length ? filtered : sorted;
  const allSelected = total > 0 && selected.size === total;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
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

  if (records === null) {
    return (
      <div className="mw-page">
        <Toolbar title={t("截图记录")} />
        <LoadingState text={t("正在读取历史记录…")} />
      </div>
    );
  }

  // 挑选模式下工具栏只放跟所选有关的操作（像「照片」那样），截取、录制先收起来：
  // 英文按钮更长，挤在一起时「删除 N 张」会压到「截取」上
  const toolbar = selecting ? (
    <Toolbar
      title={
        <>
          {t("已选 {count} 张", { count: selected.size })}
          {selected.size > 0 && <span className="mw-subtitle mono">{formatBytes(selectedBytes)}</span>}
        </>
      }
    >
      <button
        type="button"
        className="tb-btn is-quiet"
        onClick={() => {
          if (allVisibleSelected) setSelected(new Set());
          else setSelected(new Set([...selected, ...visibleIds]));
        }}
      >
        {allVisibleSelected ? t("全不选") : t("全选 {count} 张", { count: visibleIds.length })}
      </button>
      <button type="button" className="tb-btn" onClick={exitSelecting}>{t("取消")}</button>
      <button type="button" className="tb-btn is-danger" disabled={selected.size === 0} onClick={() => setConfirming(true)}>
        {selected.size > 0 ? t("删除 {count} 张", { count: selected.size }) : t("删除")}
      </button>
    </Toolbar>
  ) : (
    <Toolbar title={t("截图记录")}>
      <SearchField value={query} onChange={setQuery} label={t("搜索截图")} />
      <button type="button" className="tb-btn is-icon" aria-label={t("打开快照文件夹")} title={t("打开快照文件夹")} onClick={() => void revealFolder()}>
        <FolderOpen aria-hidden="true" />
      </button>
      <button type="button" className="tb-btn is-quiet" aria-label={t("选择快照")} onClick={() => setSelecting(true)} disabled={total === 0}>
        {t("选择")}
      </button>
    </Toolbar>
  );

  let body;
  if (total === 0) {
    const shortcut = acceleratorOf(settings, "snapshot");
    body = settings.autoSaveLocal || settings.afterCapture === "saveas" ? (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有截图")}</h2>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary" onClick={() => void runAction("capture").catch((error) => notify(errorText(error), "error"))}>
            {t("截图")}{shortcut && !settings.shortcutsPaused && !conflicts.includes(shortcut) && <span aria-hidden="true"><Keys value={shortcut} quiet /></span>}
          </button>
        </div>
      </div>
    ) : (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("截图历史已关闭")}</h2>
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
      <p className="empty-line mw-empty-line">
        {t("没有含「{query}」的历史记录。", { query: query.trim() })}
        <button type="button" className="link" onClick={() => setQuery("")}>{t("清除筛选")}</button>
      </p>
    );
  } else {
    // 逐个入场只数前十几张：再往后已经在屏幕外，等也白等
    let order = 0;
    body = (
      <div className={`history-groups gallery ${selecting ? "is-selecting" : ""}`} ref={listRef}>
        {groups.map((group) => {
          const ids = group.items.map((item) => item.id);
          const picked = ids.filter((id) => selected.has(id)).length;
          return (
            <section className="day" key={group.key} aria-label={group.label}>
              <div className="day-label">
                <h2 className="day-title">{group.label}</h2>
                {selecting && (
                  <>
                    {picked > 0 && <span className="small quiet">{t("选了 {picked} / {count}", { picked, count: ids.length })}</span>}
                    <button type="button" className="link small" onClick={() => toggleGroup(ids)}>
                      {picked === ids.length ? t("取消整组") : t("选整组")}
                    </button>
                  </>
                )}
              </div>
              <JustifiedGrid
                items={group.items}
                size={(item) => item}
                render={(item, box) => (
                  <figure
                    key={item.id}
                    data-flip-key={item.id}
                    style={{ ...stagger(order++), width: box.width }}
                    className={`shot ${leaving.has(item.id) ? "is-leaving" : ""} ${fresh.has(item.id) ? "is-fresh" : ""}`}
                  >
                    <SnapshotThumb
                      id={item.id}
                      width={item.width}
                      height={item.height}
                      thumbHeight={box.height}
                      boxWidth={box.width}
                      label={item.appName}
                      selecting={selecting}
                      selected={selected.has(item.id)}
                      onPress={(_element, event) => {
                        if (selecting) toggle(item.id, event.shiftKey);
                        else setPreviewId(item.id);
                      }}
                    />
                    <figcaption className="shot-caption" title={`${item.appName} · ${item.width} × ${item.height} · ${formatBytes(item.sizeBytes)}`}>
                      <span className="shot-name">{item.appName}</span>
                      <span className="shot-time mono">{formatClock(item.createdAt)}</span>
                    </figcaption>
                  </figure>
                )}
              />
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mw-page history-page">
      {toolbar}
      <div className="mw-scroll history-scroll">{body}</div>

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
