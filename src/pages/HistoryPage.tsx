import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  JustifiedGrid,
  OFFSCREEN_VERTICAL_RANGE,
  computeJustifiedGridLayout,
  getLastMeasuredGridWidth,
  setLastMeasuredGridWidth,
} from "../components/JustifiedGrid";
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
const SCROLL_BAND_STEP = 360;
const SCROLL_OVERSCAN = 800;
const VIRTUALIZE_THRESHOLD = 60;

function sameSnapshots(a: SnapshotRecord[] | null, b: SnapshotRecord[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id
      || x.createdAt !== y.createdAt
      || x.sizeBytes !== y.sizeBytes
      || x.width !== y.width
      || x.height !== y.height
      || x.fileName !== y.fileName
      || x.appName !== y.appName
      || x.appId !== y.appId
    ) {
      return false;
    }
  }
  return true;
}

function sameRecordings(a: RecordingRecord[], b: RecordingRecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id
      || x.createdAt !== y.createdAt
      || x.sizeBytes !== y.sizeBytes
      || x.fileName !== y.fileName
      || x.appName !== y.appName
      || x.appId !== y.appId
    ) {
      return false;
    }
  }
  return true;
}

/** 历史：日期自然随列表滚动 + 同行等高拼图 + 右侧极简时间尺；悬停左右浮出无损原图与元信息预览，点击快照直达标注。 */
export function HistoryPage({ active = true }: { active?: boolean } = {}) {
  const { settings, notify, conflicts, pendingPreviewId, consumePreviewId, navigate, pageCache } = useApp();
  const { t, language } = useI18n();
  const activeRef = useRef(active);
  activeRef.current = active;
  const cachedHistory = pageCache?.history ?? null;
  const cachedMeta = pageCache?.recordingMeta ?? {};
  const [staggerDone, setStaggerDone] = useState(() => cachedHistory !== null);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[] | null>(() => cachedHistory?.snapshots ?? null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>(() => cachedHistory?.recordings ?? []);
  const snapshotsRef = useRef<SnapshotRecord[] | null>(snapshots);
  snapshotsRef.current = snapshots;
  const recordingsRef = useRef<RecordingRecord[]>(recordings);
  recordingsRef.current = recordings;
  const [recordingMeta, setRecordingMeta] = useState<Record<string, RecordingMeta>>(() => cachedMeta);
  const metaRef = useRef<Record<string, RecordingMeta>>(cachedMeta);
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
  const [scrollBand, setScrollBand] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 760,
  );
  const [dayMetrics, setDayMetrics] = useState({ firstGridTop: 40, dayStepOverhead: 52 });
  const [gridWidth, setGridWidth] = useState(() => {
    const cached = getLastMeasuredGridWidth();
    if (cached > 0) return cached;
    if (typeof document !== "undefined" && document.documentElement.clientWidth > 220) {
      const clientW = document.documentElement.clientWidth;
      const sideW = Math.min(200, Math.max(176, clientW * 0.185));
      return Math.max(0, Math.floor(clientW - sideW - 44));
    }
    return 0;
  });
  const known = useRef<Set<string> | null>(
    cachedHistory
      ? new Set(mergeTimeline(cachedHistory.snapshots, cachedHistory.recordings, cachedMeta).map((item) => item.id))
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

  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setScrollBand(0);
    if (scrollRef.current && scrollRef.current.scrollTop !== 0) {
      scrollRef.current.scrollTop = 0;
    }
  }, []);

  const handleScroll = useCallback(() => {
    scrollingRef.current = true;
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      scrollIdleTimerRef.current = null;
    }, 140);
    dismissHoverCold();
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / SCROLL_BAND_STEP));
      if (nextBand > 0) setStaggerDone(true);
      setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
    }
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
      if (
        snapshotsRef.current !== null
        && sameSnapshots(snapshotsRef.current, snaps)
        && sameRecordings(recordingsRef.current, recs)
      ) {
        return;
      }
      const next = mergeTimeline(snaps, recs, metaRef.current);
      if (known.current && activeRef.current) {
        const added = next.filter((item) => !known.current!.has(item.id)).map((item) => item.id);
        if (added.length) setFresh(new Set(added));
      }
      known.current = new Set(next.map((item) => item.id));
      if (snapshotsRef.current !== null && activeRef.current) flip.capture();
      setSnapshots(snaps);
      setRecordings(recs);
    } catch (error) {
      setSnapshots([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pageCache) {
      pageCache.recordingMeta = recordingMeta;
      if (snapshots !== null) {
        pageCache.history = { snapshots, recordings };
      }
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

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active) {
      setStaggerDone(true);
      dismissHoverCold();
      setContextMenu(null);
      setPreviewId(null);
      return;
    }
    if (!wasActive) {
      void refresh();
    }
  }, [active, dismissHoverCold, refresh]);

  useEffect(() => {
    if (!pendingPreviewId) {
      pendingHandled.current = null;
      return;
    }
    if (!active || snapshots === null || pendingHandled.current === pendingPreviewId) return;
    pendingHandled.current = pendingPreviewId;
    const items = mergeTimeline(snapshots, recordings, metaRef.current);
    const item = items.find((item) => item.id === pendingPreviewId);
    if (item) {
      if (item.kind === "snapshot") annotateItem(item);
      else setPreviewId(item.id);
    }
    consumePreviewId();
  }, [active, pendingPreviewId, snapshots, recordings, consumePreviewId, annotateItem]);

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

  const hasGroups = items !== null && groups.length > 0;
  useEffect(() => {
    if (staggerDone || !hasGroups) return;
    const timer = window.setTimeout(() => setStaggerDone(true), 650);
    return () => window.clearTimeout(timer);
  }, [staggerDone, hasGroups]);

  useLayoutEffect(() => {
    if (!hasGroups) return;
    const node = listRef.current;
    const scrollEl = scrollRef.current;
    if (!node) return;
    const measure = () => {
      const firstGrid = node.querySelector<HTMLElement>(".jgrid");
      const nextWidth = firstGrid
        ? Math.floor(firstGrid.clientWidth)
        : Math.max(0, Math.floor(node.clientWidth - 44));
      if (nextWidth > 0) {
        setLastMeasuredGridWidth(nextWidth);
        setGridWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      }
      if (scrollEl) {
        const nextViewH = Math.ceil(scrollEl.clientHeight);
        if (nextViewH > 0) {
          setViewportHeight((prev) => (prev === nextViewH ? prev : nextViewH));
          const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / SCROLL_BAND_STEP));
          setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
        }
        if (firstGrid && nextWidth > 0 && nextViewH > 0) {
          const scrollRect = scrollEl.getBoundingClientRect();
          const firstRect = firstGrid.getBoundingClientRect();
          const measuredFirst = Math.round(firstRect.top - scrollRect.top + scrollEl.scrollTop);
          const grids = node.querySelectorAll<HTMLElement>(".jgrid");
          const measuredStep =
            grids.length >= 2
              ? Math.round(grids[1].getBoundingClientRect().top - firstRect.bottom)
              : 52;
          if (measuredFirst > 0 && measuredStep > 0) {
            setDayMetrics((prev) =>
              prev.firstGridTop === measuredFirst && prev.dayStepOverhead === measuredStep
                ? prev
                : { firstGridTop: measuredFirst, dayStepOverhead: measuredStep },
            );
          }
        }
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (scrollEl) observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [hasGroups, groups.length, active]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / SCROLL_BAND_STEP));
    setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
  }, [filtered.length, query, viewportHeight]);

  const groupLayouts = useMemo(() => {
    let startOrder = 0;
    let y = dayMetrics.firstGridTop;
    return groups.map((group) => {
      const layout = computeJustifiedGridLayout(group.items, mediaItemSize, gridWidth);
      const gridTop = y;
      const totalHeight = layout?.totalHeight ?? 0;
      y += totalHeight + dayMetrics.dayStepOverhead;
      const entry = {
        group,
        layout,
        gridTop,
        startIndex: startOrder,
      };
      startOrder += group.items.length;
      return entry;
    });
  }, [groups, gridWidth, dayMetrics]);

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
    if (!active || (!selecting && !hoverAnchor) || previewId || confirming || contextMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hoverAnchor) dismissHoverCold();
      else if (selecting) exitSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selecting, hoverAnchor, previewId, confirming, contextMenu, exitSelecting, dismissHoverCold]);

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
    if (!activeRef.current || selectingRef.current || scrollingRef.current || !node.isConnected) return;
    hoveredTargetRef.current = { id: item.id, node, pointerX };
    const rect = node.getBoundingClientRect();
    const meta = item.kind === "recording" ? metaRef.current[item.id] : undefined;
    const latest = meta ? { ...item, width: meta.width, height: meta.height, durationMs: meta.durationMs } : item;
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
      const idSet = new Set(ids);
      const snapIds: string[] = [];
      const recIds: string[] = [];
      for (const item of all) {
        if (!idSet.has(item.id)) continue;
        if (item.kind === "snapshot") snapIds.push(item.id);
        else recIds.push(item.id);
      }
      const [nextSnaps, nextRecs] = await Promise.all([
        snapIds.length ? deleteSnapshots(snapIds) : Promise.resolve(snapshots ?? []),
        recIds.length ? deleteRecordings(recIds) : Promise.resolve(recordings),
      ]);
      const next = mergeTimeline(nextSnaps, nextRecs, metaRef.current);
      known.current = new Set(next.map((item) => item.id));
      flip.capture();
      setSnapshots(nextSnaps);
      setRecordings(nextRecs);
      if (pageCache) pageCache.trash = null;
      setLeaving(new Set());
      setSelected((current) => new Set([...current].filter((id) => !idSet.has(id))));
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
  const allVisibleSelected = visibleIds.length > 0 && selected.size >= visibleIds.length && visibleIds.every((id) => selected.has(id));
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

  const renderTile = useCallback(
    (item: MediaItem, box: { width: number; height: number }, slot: number) => {
      const isStatic = staggerDone || slot >= 12;
      return (
        <figure
          key={item.id}
          data-flip-key={item.id}
          style={
            isStatic
              ? { width: box.width, height: box.height }
              : { ...stagger(slot), width: box.width, height: box.height }
          }
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
    },
    [
      staggerDone,
      leaving,
      fresh,
      selecting,
      selected,
      open,
      openContextMenu,
      handleHoverStart,
      handleHoverMove,
      handleHoverEnd,
      reportMeta,
    ],
  );

  const body = useMemo(() => {
    if (total === 0) {
      const shortcut = acceleratorOf(settings, "snapshot");
      const bound = shortcut && !settings.shortcutsPaused && !conflicts.includes(shortcut);
      return (
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
    }
    if (filtered.length === 0) {
      return (
        <p className="empty-line mw-empty-line">
          {t("没有含「{query}」的历史记录。", { query: query.trim() })}
          <button type="button" className="link" onClick={() => updateQuery("")}>{t("清除筛选")}</button>
        </p>
      );
    }
    const virtualized = filtered.length > VIRTUALIZE_THRESHOLD && gridWidth > 0;
    const winTop = scrollBand * SCROLL_BAND_STEP - SCROLL_OVERSCAN;
    const winBottom = (scrollBand + 1) * SCROLL_BAND_STEP + viewportHeight + SCROLL_OVERSCAN;
    return (
      <div className={`history-groups gallery ${selecting ? "is-selecting" : ""}`} ref={listRef}>
        {groupLayouts.map(({ group, layout, gridTop, startIndex }) => {
          let visibleRange;
          if (virtualized && layout) {
            const relTop = winTop - gridTop;
            const relBottom = winBottom - gridTop;
            if (relBottom < 0 || relTop > layout.totalHeight) {
              visibleRange = OFFSCREEN_VERTICAL_RANGE;
            } else {
              visibleRange = { top: Math.max(0, relTop), bottom: relBottom };
            }
          }
          return (
            <section className="day" key={group.key} aria-label={group.label}>
              <div className="day-label">
                <h2 className="day-title">{group.label}</h2>
              </div>
              <JustifiedGrid
                items={group.items}
                size={mediaItemSize}
                startIndex={startIndex}
                layout={gridWidth > 0 ? layout : undefined}
                visibleRange={visibleRange}
                render={renderTile}
              />
            </section>
          );
        })}
      </div>
    );
  }, [
    total,
    settings,
    conflicts,
    t,
    navigate,
    filtered.length,
    query,
    updateQuery,
    gridWidth,
    scrollBand,
    viewportHeight,
    selecting,
    groupLayouts,
    renderTile,
  ]);

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
          if (allVisibleSelected) {
            const vis = new Set(visibleIds);
            setSelected(new Set([...selected].filter((id) => !vis.has(id))));
          } else {
            setSelected(new Set([...selected, ...visibleIds]));
          }
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
      <SearchField active={active} value={query} onChange={updateQuery} label={t("搜索截图")} placeholder={t("搜索应用名或日期")} />
      <button type="button" className="tb-btn" aria-label={t("打开快照文件夹")} title={t("打开快照文件夹")} onClick={() => void revealFolder()}>
        <FolderOpen aria-hidden="true" />
      </button>
    </Toolbar>
  );

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

      {active && hoverAnchor && !selecting && !contextMenu && !confirming && !previewId && (
        <HoverPreview anchor={hoverAnchor} onMeta={reportMeta} />
      )}

      {active && contextMenu && (
        <Menu className="history-actions-menu" anchor={contextMenu.anchor} point={contextMenu.point} onClose={closeMenu} label={t("历史操作")}>
          <MenuItem onSelect={() => menuAction(selectItem)}>
            {selecting ? t(selected.has(contextMenu.item.id) ? "取消选择" : "选择") : t("多选")}
          </MenuItem>
          {contextMenu.item.kind === "snapshot" && <MenuItem onSelect={() => menuAction(copyItem)}>{t("复制")}</MenuItem>}
          {contextMenu.item.kind === "snapshot" && <MenuItem onSelect={() => menuAction(annotateItem)}>{t("标注")}</MenuItem>}
          <MenuItem danger onSelect={() => menuAction(deleteItem)}>{t("删除")}</MenuItem>
        </Menu>
      )}

      {active && previewId && (
        <PhotoViewer
          records={previewRecords}
          startId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
      {active && confirmDialog.item && (
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
