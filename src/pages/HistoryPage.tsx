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
} from "../lib/backend";
import { formatBytes, groupByDay } from "../lib/format";
import { appIdSearchName, matchesSearchEntry } from "../lib/dateSearch";
import { useFlip, wait, DURATION, stagger, usePresence } from "../lib/motion";
import { MediaTile } from "../components/MediaTile";
import { JustifiedGrid } from "../components/JustifiedGrid";
import { HoverPreview, type HoverPreviewAnchor } from "../components/HoverPreview";
import { PhotoViewer } from "../components/PhotoViewer";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { Menu, MenuItem } from "../components/Menu";
import { Keys } from "../components/ui/Keys";
import { Toolbar } from "../app/Shell";
import { acceleratorOf } from "../lib/shortcuts";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import { mergeTimeline, type MediaItem, type RecordingMeta } from "../lib/mediaTimeline";
import type { RecordingRecord, SnapshotRecord } from "../types";

type HistoryMenu = { item: MediaItem; anchor: HTMLElement; point: { x: number; y: number } };

const mediaItemSize = (item: MediaItem) => item;

/** 历史：日期自然随列表滚动 + 同行等高拼图 + 右侧极简时间尺；悬停左右浮出无损原图与元信息预览，点击快照直达标注。 */
export function HistoryPage() {
  const { settings, notify, conflicts, pendingPreviewId, consumePreviewId, navigate, pageCache } = useApp();
  const { t, language } = useI18n();
  const cachedHistory = pageCache?.history ?? null;
  const skipInitialStagger = useRef(cachedHistory !== null).current;
  const [snapshots, setSnapshots] = useState<SnapshotRecord[] | null>(() => cachedHistory?.snapshots ?? null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>(() => cachedHistory?.recordings ?? []);
  const [recordingMeta, setRecordingMeta] = useState<Record<string, RecordingMeta>>(() => cachedHistory?.recordingMeta ?? {});
  const metaRef = useRef<Record<string, RecordingMeta>>(cachedHistory?.recordingMeta ?? {});
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<HoverPreviewAnchor | null>(null);
  const [contextMenu, setContextMenu] = useState<HistoryMenu | null>(null);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const confirming = deleteIds !== null;
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(
    cachedHistory
      ? new Set(mergeTimeline(cachedHistory.snapshots, cachedHistory.recordings, cachedHistory.recordingMeta).map((item) => item.id))
      : null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const flip = useFlip(listRef);
  const pendingHandled = useRef<string | null>(null);
  const hoveredTargetRef = useRef<{ id: string; node: HTMLElement; pointerX?: number } | null>(null);
  const hoverAnchorRef = useRef<HoverPreviewAnchor | null>(null);
  hoverAnchorRef.current = hoverAnchor;
  const scrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);

  const dismissHoverCold = useCallback(() => {
    const hadHover = hoveredTargetRef.current !== null || hoverAnchorRef.current !== null;
    hoveredTargetRef.current = null;
    if (hadHover) setHoverAnchor(null);
  }, []);

  const handleScroll = useCallback(() => {
    scrollingRef.current = true;
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      scrollIdleTimerRef.current = null;
    }, 140);
    dismissHoverCold();
  }, [dismissHoverCold]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
  }, []);

  const annotateItem = useCallback((item: MediaItem) => {
    void annotateSnapshot(item.id).catch((error) => notify(errorText(error), "error"));
  }, [notify]);

  const reportMeta = useCallback((id: string, meta: RecordingMeta) => {
    if (metaRef.current[id]?.durationMs === meta.durationMs && metaRef.current[id]?.width === meta.width) return;
    metaRef.current = { ...metaRef.current, [id]: meta };
    setRecordingMeta(metaRef.current);
    setHoverAnchor((current) => (
      current && current.item.id === id
        ? { ...current, item: { ...current.item, width: meta.width, height: meta.height, durationMs: meta.durationMs } }
        : current
    ));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const snapList = await listSnapshots();
      const snaps = Array.isArray(snapList) ? snapList : [];
      const recList = await listRecordings().catch(() => [] as RecordingRecord[]);
      const recs = Array.isArray(recList) ? recList : [];
      const next = mergeTimeline(snaps, recs, metaRef.current);
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
    if (pageCache && snapshots !== null) {
      pageCache.history = { snapshots, recordings, recordingMeta };
    }
  }, [pageCache, snapshots, recordings, recordingMeta]);

  useEffect(() => {
    void refresh();
    const pendingSnapshots = onSnapshotsChanged(() => void refresh());
    const pendingRecordings = onRecordingsChanged(() => void refresh());
    return () => {
      void pendingSnapshots.then((unlisten) => unlisten()).catch(() => {});
      void pendingRecordings.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    if (!pendingPreviewId) {
      pendingHandled.current = null;
      return;
    }
    if (snapshots === null || pendingHandled.current === pendingPreviewId) return;
    pendingHandled.current = pendingPreviewId;
    const items = mergeTimeline(snapshots, recordings, metaRef.current);
    const item = items.find((item) => item.id === pendingPreviewId);
    if (item) {
      if (item.kind === "snapshot") annotateItem(item);
      else setPreviewId(item.id);
    }
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
    const all = items ?? [];
    if (!query.trim()) return all;
    return all.filter((item) => matchesSearchEntry(item.createdAt, [item.appName, appIdSearchName(item.appId)], query));
  }, [items, query]);
  const groups = useMemo(() => {
    void language;
    return groupByDay(filtered, (item) => item.createdAt);
  }, [filtered, language]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  useEffect(() => {
    if (selecting || previewId || confirming || contextMenu) {
      dismissHoverCold();
    }
  }, [selecting, previewId, confirming, contextMenu, dismissHoverCold]);

  useEffect(() => {
    if ((!selecting && !hoverAnchor) || previewId || confirming || contextMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hoverAnchor) dismissHoverCold();
      else if (selecting) exitSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, hoverAnchor, previewId, confirming, contextMenu, exitSelecting, dismissHoverCold]);

  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;

  const toggle = useCallback((id: string, range: boolean) => {
    const currentAnchor = anchorRef.current;
    const list = filteredRef.current;
    let usedRange = false;
    setSelected((current) => {
      const next = new Set(current);
      if (range && currentAnchor) {
        const from = list.findIndex((item) => item.id === currentAnchor);
        const to = list.findIndex((item) => item.id === id);
        if (from >= 0 && to >= 0) {
          usedRange = true;
          const [start, end] = from < to ? [from, to] : [to, from];
          list.slice(start, end + 1).forEach((item) => next.add(item.id));
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!usedRange) setAnchor(id);
  }, []);

  const handleHoverStart = useCallback((item: MediaItem, node: HTMLElement, pointerX?: number) => {
    if (selectingRef.current || scrollingRef.current || !node.isConnected) return;
    hoveredTargetRef.current = { id: item.id, node, pointerX };
    const rect = node.getBoundingClientRect();
    const latest = filteredRef.current.find((entry) => entry.id === item.id) ?? item;
    setHoverAnchor({
      item: latest,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      pointerX,
    });
  }, []);

  const handleHoverMove = useCallback((pointerX: number) => {
    if (hoveredTargetRef.current) {
      hoveredTargetRef.current.pointerX = pointerX;
    }
  }, []);

  const handleHoverEnd = useCallback((item: MediaItem) => {
    if (hoveredTargetRef.current?.id === item.id) {
      hoveredTargetRef.current = null;
    }
    setHoverAnchor((current) => (current?.item.id === item.id ? null : current));
  }, []);

  const open = useCallback((item: MediaItem, event: React.MouseEvent) => {
    dismissHoverCold();
    if (selectingRef.current) {
      toggle(item.id, event.shiftKey);
    } else if (event.shiftKey) {
      setSelecting(true);
      toggle(item.id, false);
    } else if (item.kind === "snapshot") {
      annotateItem(item);
    } else {
      setPreviewId(item.id);
    }
  }, [toggle, annotateItem, dismissHoverCold]);

  const openContextMenu = useCallback((item: MediaItem, menuAnchor: HTMLElement, point: { x: number; y: number }) => {
    dismissHoverCold();
    setContextMenu({ item, anchor: menuAnchor, point });
  }, [dismissHoverCold]);

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
      notify(t(ids.length === 1 ? "已将 1 项移入回收站" : "已将 {count} 项移入回收站", { count: ids.length }));
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

  function deleteItem(item: MediaItem) {
    setDeleteIds(selecting && selected.has(item.id) ? [...selected] : [item.id]);
  }

  const selectedBytes = useMemo(
    () => (items ?? []).filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.sizeBytes, 0),
    [items, selected],
  );

  const total = items?.length ?? 0;
  const visibleIds = useMemo(() => filtered.map((item) => item.id), [filtered]);
  const previewRecords = filtered.length ? filtered : (items ?? []);
  const allDeleting = total > 0 && deleteIds?.length === total;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
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
      <SearchField value={query} onChange={setQuery} label={t("搜索截图")} placeholder={t("搜索应用名或日期")} />
      <button type="button" className="tb-btn" aria-label={t("打开快照文件夹")} title={t("打开快照文件夹")} onClick={() => void revealFolder()}>
        <FolderOpen aria-hidden="true" />
      </button>
    </Toolbar>
  );

  let body;
  if (total === 0) {
    const shortcut = acceleratorOf(settings, "snapshot");
    const bound = shortcut && !settings.shortcutsPaused && !conflicts.includes(shortcut);
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有截图或录屏")}</h2>
        {bound ? (
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
    let order = 0;
    body = (
      <div className={`history-groups gallery ${selecting ? "is-selecting" : ""}`} ref={listRef}>
        {groups.map((group) => (
          <section className="day" key={group.key} aria-label={group.label}>
            <div className="day-label">
              <h2 className="day-title">{group.label}</h2>
            </div>
            <JustifiedGrid
              items={group.items}
              size={mediaItemSize}
              render={(item, box) => {
                const slot = order++;
                const isStatic = skipInitialStagger || slot >= 12;
                return (
                <figure
                  key={item.id}
                  data-flip-key={item.id}
                  style={isStatic ? { width: box.width } : { ...stagger(slot), width: box.width }}
                  className={`shot ${isStatic ? "is-static" : ""} ${leaving.has(item.id) ? "is-leaving" : ""} ${fresh.has(item.id) ? "is-fresh" : ""}`}
                >
                  <MediaTile
                    item={item}
                    boxWidth={box.width}
                    boxHeight={box.height}
                    selecting={selecting}
                    selected={selected.has(item.id)}
                    onOpen={open}
                    onMenu={openContextMenu}
                    onHoverStart={handleHoverStart}
                    onHoverMove={handleHoverMove}
                    onHoverEnd={handleHoverEnd}
                    onMeta={reportMeta}
                  />
                </figure>
                );
              }}
            />
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="mw-page history-page">
      {toolbar}
      <div className="history-body">
        <div
          className="mw-scroll history-scroll"
          ref={scrollRef}
          role="region"
          aria-label={t("历史")}
          tabIndex={0}
          onScroll={handleScroll}
        >
          {body}
        </div>
      </div>

      {hoverAnchor && !selecting && !contextMenu && !confirming && !previewId && (
        <HoverPreview anchor={hoverAnchor} onMeta={reportMeta} />
      )}

      {contextMenu && (
        <Menu className="history-actions-menu" anchor={contextMenu.anchor} point={contextMenu.point} onClose={closeMenu} label={t("历史操作")}>
          <MenuItem onSelect={() => menuAction(selectItem)}>
            {selecting ? t(selected.has(contextMenu.item.id) ? "取消选择" : "选择") : t("多选")}
          </MenuItem>
          {contextMenu.item.kind === "snapshot" && <MenuItem onSelect={() => menuAction(copyItem)}>{t("复制")}</MenuItem>}
          {contextMenu.item.kind === "snapshot" && <MenuItem onSelect={() => menuAction(annotateItem)}>{t("标注")}</MenuItem>}
          <MenuItem danger onSelect={() => menuAction(deleteItem)}>{t("删除")}</MenuItem>
        </Menu>
      )}

      {previewId && (
        <PhotoViewer
          records={previewRecords}
          startId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
      {confirmDialog.item && (
        <ConfirmDialog
          title={confirmDialog.item.title}
          body={t("可在资料库的回收站中恢复这些文件。")}
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
