import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, FolderOpen, Trash2, X } from "lucide-react";
import {
  annotateSnapshot,
  copySnapshot,
  deleteRecordings,
  deleteSnapshots,
  listRecordings,
  listSnapshots,
  onRecordingsChanged,
  onSnapshotsChanged,
  openSnapshotsDir,
  savePreferences,
} from "../lib/backend";
import { formatBytes, groupByDay } from "../lib/format";
import { useFlip, wait, DURATION, stagger, usePresence } from "../lib/motion";
import { MediaTile } from "../components/MediaTile";
import { JustifiedGrid } from "../components/JustifiedGrid";
import { Lightbox } from "../components/Lightbox";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { TimelineScrollbar } from "../components/TimelineScrollbar";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { Keys } from "../components/ui/Keys";
import { Toolbar } from "../app/Shell";
import { acceleratorOf } from "../lib/shortcuts";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import { mergeTimeline, type MediaItem, type RecordingMeta } from "../lib/mediaTimeline";
import type { RecordingRecord, SnapshotRecord } from "../types";

type HistoryMenu = { item: MediaItem; anchor: HTMLElement; point: { x: number; y: number } };

/** 历史：截图点开标注，录屏点开播放；右键进入多选、复制或确认删除。 */
export function HistoryPage() {
  const { settings, onSaved, notify, conflicts, pendingPreviewId, consumePreviewId, navigate } = useApp();
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<SnapshotRecord[] | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [recordingMeta, setRecordingMeta] = useState<Record<string, RecordingMeta>>({});
  const metaRef = useRef<Record<string, RecordingMeta>>({});
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<HistoryMenu | null>(null);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const confirming = deleteIds !== null;
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const flip = useFlip(listRef);
  const pendingHandled = useRef<string | null>(null);
  const annotateItem = useCallback((item: MediaItem) => {
    void annotateSnapshot(item.id).catch((error) => notify(errorText(error), "error"));
  }, [notify]);

  // 录屏封面 video 读到真实尺寸/时长后回填，时间线据此重新排版
  const reportMeta = useCallback((id: string, meta: RecordingMeta) => {
    if (metaRef.current[id]?.durationMs === meta.durationMs && metaRef.current[id]?.width === meta.width) return;
    metaRef.current = { ...metaRef.current, [id]: meta };
    setRecordingMeta(metaRef.current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const snapList = await listSnapshots();
      const snaps = Array.isArray(snapList) ? snapList : [];
      // 录屏是补充内容：读不到也不该让截图墙整个空掉，单独兜底
      const recList = await listRecordings().catch(() => [] as RecordingRecord[]);
      const recs = Array.isArray(recList) ? recList : [];
      const next = mergeTimeline(snaps, recs, metaRef.current);
      // 第一次加载不算「新来的」；之后多出来的那几格要从顶上挤进来
      if (known.current) {
        const added = next.filter((item) => !known.current!.has(item.id)).map((item) => item.id);
        if (added.length) setFresh(new Set(added));
      }
      known.current = new Set(next.map((item) => item.id));
      flip.capture();
      setSnapshots(snaps);
      setRecordings(recs);
    } catch (error) {
      setSnapshots([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const pendingSnapshots = onSnapshotsChanged(() => void refresh());
    const pendingRecordings = onRecordingsChanged(() => void refresh());
    return () => {
      void pendingSnapshots.then((unlisten) => unlisten()).catch(() => {});
      void pendingRecordings.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  // 从别处点进来的截图也直接标注；录屏仍打开播放器。
  useEffect(() => {
    if (!pendingPreviewId) {
      pendingHandled.current = null;
      return;
    }
    if (snapshots === null || pendingHandled.current === pendingPreviewId) return;
    pendingHandled.current = pendingPreviewId;
    const items = mergeTimeline(snapshots, recordings, metaRef.current);
    const item = items.find((item) => item.id === pendingPreviewId);
    if (item?.kind === "snapshot") annotateItem(item);
    else if (item) setPreviewId(item.id);
    consumePreviewId();
  }, [pendingPreviewId, snapshots, recordings, consumePreviewId, annotateItem]);

  useEffect(() => {
    if (!fresh.size) return;
    const timer = window.setTimeout(() => setFresh(new Set()), 1400);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const items = useMemo(
    () => (snapshots === null ? null : mergeTimeline(snapshots, recordings, recordingMeta)),
    [snapshots, recordings, recordingMeta],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = items ?? [];
    return needle ? all.filter((item) => item.appName.toLowerCase().includes(needle)) : all;
  }, [items, query]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.createdAt), [filtered]);
  const timelineStops = useMemo(() => groups.map((group) => ({ key: group.key, label: group.label })), [groups]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  useEffect(() => {
    if (!selecting || previewId || confirming || contextMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, previewId, confirming, contextMenu, exitSelecting]);

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

  function open(item: MediaItem, event: React.MouseEvent) {
    if (selecting) toggle(item.id, event.shiftKey);
    else if (item.kind === "snapshot") annotateItem(item);
    else setPreviewId(item.id);
  }

  function selectItem(item: MediaItem) {
    setSelecting(true);
    toggle(item.id, false);
  }

  function menuAction(action: (item: MediaItem) => void) {
    if (!contextMenu) return;
    contextMenu.anchor.focus({ preventScroll: true });
    closeMenu();
    action(contextMenu.item);
  }

  async function remove(ids: string[]) {
    if (!ids.length) return false;
    setDeleting(true);
    try {
      // 先消失再合拢：顺序反了会像是别的条目被删了
      setLeaving(new Set(ids));
      await wait(DURATION.fade);
      const all = items ?? [];
      const snapIds = ids.filter((id) => all.find((item) => item.id === id)?.kind === "snapshot");
      const recIds = ids.filter((id) => all.find((item) => item.id === id)?.kind === "recording");
      const [nextSnaps, nextRecs] = await Promise.all([
        snapIds.length ? deleteSnapshots(snapIds) : Promise.resolve(snapshots ?? []),
        recIds.length ? deleteRecordings(recIds) : Promise.resolve(recordings),
      ]);
      const next = mergeTimeline(nextSnaps, nextRecs, metaRef.current);
      known.current = new Set(next.map((item) => item.id));
      flip.capture();
      setSnapshots(nextSnaps);
      setRecordings(nextRecs);
      setLeaving(new Set());
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      notify(t(ids.length === 1 ? "删掉了 1 项" : "删掉了 {count} 项", { count: ids.length }));
      return true;
    } catch (error) {
      setLeaving(new Set());
      notify(errorText(error), "error");
      return false;
    } finally {
      setDeleting(false);
      setDeleteIds(null);
    }
  }

  async function revealFolder() {
    try {
      await openSnapshotsDir();
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  function copyItem(item: MediaItem) {
    void copySnapshot(item.id)
      .then((message) => notify(message))
      .catch((error) => notify(errorText(error), "error"));
  }

  // 右键已选项时作用于整批；右键未选项时仅删除该项，取消确认不改变原选择。
  function deleteItem(item: MediaItem) {
    setDeleteIds(selecting && selected.has(item.id) ? [...selected] : [item.id]);
  }

  const selectedBytes = useMemo(
    () => (items ?? []).filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.sizeBytes, 0),
    [items, selected],
  );

  const total = items?.length ?? 0;
  const visibleIds = useMemo(() => filtered.map((item) => item.id), [filtered]);
  const previewRecords = (filtered.length ? filtered : (items ?? [])).filter((item) => item.kind === "recording");
  const allDeleting = total > 0 && deleteIds?.length === total;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  // 退场时文案别跟着变成「删除 0 项」：打开那一刻的文案一直留到对话框淡出
  const confirmDialog = usePresence(
    confirming
      ? {
          title: allDeleting
            ? t(total === 1 ? "删除全部 1 项？" : "删除全部 {count} 项？", { count: total })
            : t(deleteIds.length === 1 ? "删除选中的 1 项？" : "删除选中的 {count} 项？", { count: deleteIds.length }),
          label: t("删除 {count} 项", { count: deleteIds.length }),
        }
      : null,
  );

  if (items === null) {
    return (
      <div className="mw-page">
        <Toolbar title={t("历史")} />
        <LoadingState text={t("正在读取历史记录…")} />
      </div>
    );
  }

  // 挑选模式下工具栏只放跟所选有关的操作（像「照片」那样）；数量在标题里，按钮只留图标
  const selectAllLabel = allVisibleSelected ? t("全不选") : t("全选 {count} 项", { count: visibleIds.length });
  const deleteLabel = selected.size > 0 ? t("删除 {count} 项", { count: selected.size }) : t("删除");
  const toolbar = selecting ? (
    <Toolbar
      title={
        <>
          {t("已选 {count} 项", { count: selected.size })}
          {selected.size > 0 && <span className="mw-subtitle mono">{formatBytes(selectedBytes)}</span>}
        </>
      }
    >
      <button
        type="button"
        className="tb-btn"
        aria-label={selectAllLabel}
        title={selectAllLabel}
        onClick={() => {
          // 全选/全不选都只作用于当前可见的格；被搜索过滤隐藏的已选项保持不变
          if (allVisibleSelected) setSelected(new Set([...selected].filter((id) => !visibleIds.includes(id))));
          else setSelected(new Set([...selected, ...visibleIds]));
        }}
      >
        <CheckCheck aria-hidden="true" />
      </button>
      <button type="button" className="tb-btn" aria-label={t("取消")} title={t("取消")} onClick={exitSelecting}>
        <X aria-hidden="true" />
      </button>
      <button type="button" className="tb-btn is-danger" aria-label={deleteLabel} title={deleteLabel} disabled={selected.size === 0} onClick={() => setDeleteIds([...selected])}>
        <Trash2 aria-hidden="true" />
      </button>
    </Toolbar>
  ) : (
    <Toolbar title={t("历史")}>
      <SearchField value={query} onChange={setQuery} label={t("搜索截图")} />
      <button type="button" className="tb-btn" aria-label={t("打开快照文件夹")} title={t("打开快照文件夹")} onClick={() => void revealFolder()}>
        <FolderOpen aria-hidden="true" />
      </button>
    </Toolbar>
  );

  let body;
  if (total === 0) {
    const shortcut = acceleratorOf(settings, "snapshot");
    const bound = shortcut && !settings.shortcutsPaused && !conflicts.includes(shortcut);
    const historyOff = !settings.autoSaveLocal && settings.afterCapture !== "saveas";
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有截图或录屏")}</h2>
        {historyOff ? (
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
        ) : bound ? (
          <p className="empty-hint">
            <Keys value={shortcut} />
            <span>{t("截图后会自动留在这里")}</span>
          </p>
        ) : (
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate("shortcuts")}>
              {t("设置截图快捷键")}
            </button>
          </div>
        )}
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
    // 逐个入场只数前十几格：再往后已经在屏幕外，等也白等
    let order = 0;
    body = (
      <div className={`history-groups gallery ${selecting ? "is-selecting" : ""}`} ref={listRef}>
        {groups.map((group) => {
          return (
            <section className="day" key={group.key} data-day-key={group.key} aria-label={group.label}>
              <div className="day-label">
                <h2 className="day-title">{group.label}</h2>
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
                    <MediaTile
                      item={item}
                      boxWidth={box.width}
                      boxHeight={box.height}
                      selecting={selecting}
                      selected={selected.has(item.id)}
                      onOpen={open}
                      onMenu={(item, anchor, point) => setContextMenu({ item, anchor, point })}
                      onMeta={reportMeta}
                    />
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
      <div className="history-body">
        <div className="mw-scroll history-scroll" ref={scrollRef}>{body}</div>
        <TimelineScrollbar scrollRef={scrollRef} stops={timelineStops} />
      </div>

      {contextMenu && (
        <Menu anchor={contextMenu.anchor} point={contextMenu.point} onClose={closeMenu} label={t("历史操作")}>
          <MenuItem onSelect={() => menuAction(selectItem)}>
            {selecting ? t(selected.has(contextMenu.item.id) ? "取消选择" : "选择") : t("多选")}
          </MenuItem>
          {contextMenu.item.kind === "snapshot" && <MenuItem onSelect={() => menuAction(copyItem)}>{t("复制")}</MenuItem>}
          <MenuSeparator />
          <MenuItem danger onSelect={() => menuAction(deleteItem)}>{t("删除")}</MenuItem>
        </Menu>
      )}

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
          body={t("文件会从本机一起删掉，没法恢复。")}
          confirmLabel={confirmDialog.item.label}
          busy={deleting || !deleteIds}
          leaving={confirmDialog.leaving}
          onCancel={() => !deleting && setDeleteIds(null)}
          onConfirm={() => deleteIds && void remove(deleteIds).then((removed) => removed && allDeleting && exitSelecting())}
        />
      )}
    </div>
  );
}
