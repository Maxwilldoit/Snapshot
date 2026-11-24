import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { copyClipboardHistory, deleteClipboardHistory, listClipboardHistory, onClipboardHistoryChanged } from "../lib/backend";
import { clipboardThumbUrl } from "../lib/media";
import { formatClock, groupByDay } from "../lib/format";
import { matchesSearchEntry } from "../lib/dateSearch";
import { stagger } from "../lib/motion";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HoverPreview, type HoverPreviewAnchor } from "../components/HoverPreview";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { Toolbar } from "../app/Shell";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { ClipboardHistoryEntry } from "../types";

const MAX_PREVIEW_CHARS = 320;
const MAX_TITLE_CHARS = 600;
const THUMB_MAX_WIDTH = 200;
const THUMB_MAX_HEIGHT = 64;
const CLIP_SCROLL_BAND_STEP = 360;
const CLIP_SCROLL_OVERSCAN = 800;
const CLIP_VIRTUALIZE_THRESHOLD = 60;

function sameClipboardRecords(a: ClipboardHistoryEntry[] | null, b: ClipboardHistoryEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id
      || x.createdAt !== y.createdAt
      || x.kind !== y.kind
      || x.hash !== y.hash
      || x.width !== y.width
      || x.height !== y.height
      || x.text !== y.text
    ) {
      return false;
    }
  }
  return true;
}

function clipboardRowHeight(record: ClipboardHistoryEntry): number {
  if (record.kind === "image") {
    return thumbDimensions(record.width, record.height).height + 20;
  }
  return 40;
}

function previewText(text: string): string {
  const truncated = text.length > MAX_PREVIEW_CHARS;
  const slice = truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text;
  const collapsed = slice.replace(/\s+/g, " ").trim();
  return truncated ? `${collapsed}…` : collapsed;
}

function previewTitle(text: string): string {
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;
}

function thumbDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 96, height: THUMB_MAX_HEIGHT };
  const scale = Math.min(1, THUMB_MAX_WIDTH / width, THUMB_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 剪贴板历史（macOS / Linux）：始终记录复制的文字与图片，按天分组。
 * 点一条把它放回剪贴板；可单条删除或整个清空。密码管理器标记的敏感内容不会出现在这里。
 */
export function ClipboardPage() {
  const { notify, pageCache } = useApp();
  const { t } = useI18n();
  const cachedClipboard = pageCache?.clipboard ?? null;
  const [staggerDone, setStaggerDone] = useState(() => cachedClipboard !== null);
  const [records, setRecords] = useState<ClipboardHistoryEntry[] | null>(() => cachedClipboard?.records ?? null);
  const recordsRef = useRef<ClipboardHistoryEntry[] | null>(records);
  recordsRef.current = records;
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hoverAnchor, setHoverAnchor] = useState<HoverPreviewAnchor | null>(null);
  const [scrollBand, setScrollBand] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 760,
  );
  const [dayMetrics, setDayMetrics] = useState({ firstListTop: 34, dayStepOverhead: 52 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hoverAnchorRef = useRef<HoverPreviewAnchor | null>(null);
  hoverAnchorRef.current = hoverAnchor;
  const scrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  // 本页内点击「放回剪贴板」生成的新条目暂不在当前视图插入，等离开本页再回来时自然显示。
  const deferredIdsRef = useRef<Set<string>>(new Set());

  const dismissHover = useCallback(() => {
    if (hoverAnchorRef.current !== null) setHoverAnchor(null);
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
    dismissHover();
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / CLIP_SCROLL_BAND_STEP));
      if (nextBand > 0) setStaggerDone(true);
      setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
    }
  }, [dismissHover]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
  }, []);

  useEffect(() => {
    if (confirmClear) dismissHover();
  }, [confirmClear, dismissHover]);

  useEffect(() => {
    if (!hoverAnchor || confirmClear) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissHover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hoverAnchor, confirmClear, dismissHover]);

  const handleHoverStart = useCallback((record: ClipboardHistoryEntry, node: HTMLElement, pointerX?: number) => {
    if (record.kind !== "image" || scrollingRef.current || !node.isConnected) return;
    const anchorEl = node.querySelector<HTMLElement>(".clip-thumb") ?? node;
    const rect = anchorEl.getBoundingClientRect();
    setHoverAnchor({
      item: {
        id: record.id,
        kind: "clipboard-image",
        width: record.width,
        height: record.height,
        createdAt: record.createdAt,
      },
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

  const handleHoverEnd = useCallback((id: string) => {
    setHoverAnchor((current) => (current?.item.id === id ? null : current));
  }, []);

  const applyRecords = useCallback((list: ClipboardHistoryEntry[]) => {
    const deferred = deferredIdsRef.current;
    const next = deferred.size === 0 ? list : list.filter((item) => !deferred.has(item.id));
    if (recordsRef.current !== null && sameClipboardRecords(recordsRef.current, next)) {
      return;
    }
    setRecords(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await listClipboardHistory();
      applyRecords(Array.isArray(list) ? list : []);
    } catch (error) {
      setRecords([]);
      notify(errorText(error), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyRecords]);

  useEffect(() => {
    if (pageCache && records !== null) {
      pageCache.clipboard = { records };
    }
  }, [pageCache, records]);

  useEffect(() => {
    void refresh();
    const pending = onClipboardHistoryChanged(() => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const sorted = [...(records ?? [])].sort((a, b) => b.createdAt - a.createdAt);
    if (!query.trim()) return sorted;
    return sorted.filter((item) => matchesSearchEntry(item.createdAt, item.kind === "text" ? [item.text] : [], query));
  }, [records, query]);
  const groups = useMemo(() => groupByDay(filtered, (item) => item.createdAt), [filtered]);
  const hasGroups = records !== null && groups.length > 0;

  useEffect(() => {
    if (staggerDone || !hasGroups) return;
    const timer = window.setTimeout(() => setStaggerDone(true), 650);
    return () => window.clearTimeout(timer);
  }, [staggerDone, hasGroups]);

  useLayoutEffect(() => {
    if (!hasGroups) return;
    const scrollEl = scrollRef.current;
    const node = listRef.current;
    if (!scrollEl) return;
    const measure = () => {
      const nextViewH = Math.ceil(scrollEl.clientHeight);
      if (nextViewH > 0) {
        setViewportHeight((prev) => (prev === nextViewH ? prev : nextViewH));
      }
      const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / CLIP_SCROLL_BAND_STEP));
      setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
      if (node && nextViewH > 0) {
        const lists = node.querySelectorAll<HTMLElement>(".prompt-list");
        const firstList = lists[0];
        if (firstList) {
          const scrollRect = scrollEl.getBoundingClientRect();
          const firstRect = firstList.getBoundingClientRect();
          const measuredFirst = Math.round(firstRect.top - scrollRect.top + scrollEl.scrollTop);
          const measuredStep =
            lists.length >= 2
              ? Math.round(lists[1].getBoundingClientRect().top - firstRect.bottom)
              : 52;
          if (measuredFirst > 0 && measuredStep > 0) {
            setDayMetrics((prev) =>
              prev.firstListTop === measuredFirst && prev.dayStepOverhead === measuredStep
                ? prev
                : { firstListTop: measuredFirst, dayStepOverhead: measuredStep },
            );
          }
        }
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    if (node) observer.observe(node);
    return () => observer.disconnect();
  }, [hasGroups, groups.length]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const nextBand = Math.max(0, Math.floor(scrollEl.scrollTop / CLIP_SCROLL_BAND_STEP));
    setScrollBand((prev) => (prev === nextBand ? prev : nextBand));
  }, [filtered.length, query, viewportHeight]);

  const groupLayouts = useMemo(() => {
    let startOrder = 0;
    let y = dayMetrics.firstListTop;
    return groups.map((group) => {
      const rowTops: number[] = [];
      let top = 0;
      for (let i = 0; i < group.items.length; i++) {
        rowTops.push(top);
        top += clipboardRowHeight(group.items[i]);
      }
      const listTop = y;
      const totalHeight = top;
      y += totalHeight + dayMetrics.dayStepOverhead;
      const entry = { group, rowTops, totalHeight, listTop, startIndex: startOrder };
      startOrder += group.items.length;
      return entry;
    });
  }, [groups, dayMetrics]);

  const copyById = useCallback(async (id: string) => {
    dismissHover();
    try {
      const created = await copyClipboardHistory(id);
      if (created?.id) {
        deferredIdsRef.current.add(created.id);
        if (pageCache) pageCache.clipboard = null;
      }
      notify(t("已放回剪贴板"));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }, [dismissHover, notify, pageCache, t]);

  const remove = useCallback(async (ids: string[]) => {
    dismissHover();
    setBusy(true);
    try {
      const next = await deleteClipboardHistory(ids);
      for (const id of ids) deferredIdsRef.current.delete(id);
      applyRecords(next);
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }, [applyRecords, dismissHover, notify]);

  const deleteById = useCallback((id: string) => {
    void remove([id]);
  }, [remove]);

  const toolbar = (
    <Toolbar title={t("剪贴板")}>
      <SearchField value={query} onChange={updateQuery} label={t("搜索剪贴板历史")} placeholder={t("搜索内容或日期")} />
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

  const body = useMemo(() => {
    if (records === null) {
      return <LoadingState text={t("正在读取剪贴板历史…")} />;
    }
    if (records.length === 0) {
      return (
        <div className="empty mw-empty">
          <h2 className="empty-title">{t("还没有剪贴板记录")}</h2>
          <p className="empty-body">{t("复制一段文字或一张图片，稍等片刻就会出现在这里。密码管理器标记的敏感内容不会被记录。")}</p>
        </div>
      );
    }
    if (filtered.length === 0) {
      return (
        <p className="empty-line mw-empty-line">
          {t("没有含「{query}」的剪贴板记录。", { query: query.trim() })}
          <button type="button" className="link" onClick={() => updateQuery("")}>{t("清除筛选")}</button>
        </p>
      );
    }
    const virtualized =
      filtered.length > CLIP_VIRTUALIZE_THRESHOLD
      && typeof document !== "undefined"
      && document.documentElement.clientWidth > 0;
    const winTop = scrollBand * CLIP_SCROLL_BAND_STEP - CLIP_SCROLL_OVERSCAN;
    const winBottom = (scrollBand + 1) * CLIP_SCROLL_BAND_STEP + viewportHeight + CLIP_SCROLL_OVERSCAN;

    return (
      <div className="prompt-groups" ref={listRef}>
        {groupLayouts.map(({ group, rowTops, totalHeight, listTop, startIndex }) => {
          if (!virtualized) {
            return (
              <section className="day" key={group.key} aria-label={group.label}>
                <div className="day-label">
                  <h2 className="day-title">{group.label}</h2>
                </div>
                <div className="prompt-list">
                  {group.items.map((item, idx) => (
                    <ClipboardRow
                      key={item.id}
                      record={item}
                      index={staggerDone ? 12 + startIndex + idx : startIndex + idx}
                      onCopy={copyById}
                      onDelete={deleteById}
                      onHoverStart={handleHoverStart}
                      onHoverEnd={handleHoverEnd}
                    />
                  ))}
                </div>
              </section>
            );
          }

          const relTop = winTop - listTop;
          const relBottom = winBottom - listTop;
          if (relBottom < 0 || relTop > totalHeight) {
            return (
              <section className="day" key={group.key} aria-label={group.label}>
                <div className="day-label">
                  <h2 className="day-title">{group.label}</h2>
                </div>
                <div className="prompt-list" style={{ height: totalHeight }} />
              </section>
            );
          }

          let startRow = 0;
          while (
            startRow < group.items.length
            && rowTops[startRow] + clipboardRowHeight(group.items[startRow]) < relTop
          ) {
            startRow++;
          }
          let endRow = startRow;
          while (endRow < group.items.length && rowTops[endRow] <= relBottom) {
            endRow++;
          }
          const topPad = startRow < group.items.length ? rowTops[startRow] : 0;

          return (
            <section className="day" key={group.key} aria-label={group.label}>
              <div className="day-label">
                <h2 className="day-title">{group.label}</h2>
              </div>
              <div
                className="prompt-list"
                style={{ height: totalHeight, paddingTop: topPad, boxSizing: "border-box" }}
              >
                {group.items.slice(startRow, endRow).map((item, offset) => {
                  const idx = startRow + offset;
                  return (
                    <ClipboardRow
                      key={item.id}
                      record={item}
                      index={staggerDone ? 12 + startIndex + idx : startIndex + idx}
                      rowHeight={clipboardRowHeight(item)}
                      onCopy={copyById}
                      onDelete={deleteById}
                      onHoverStart={handleHoverStart}
                      onHoverEnd={handleHoverEnd}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    );
  }, [
    records,
    t,
    filtered.length,
    query,
    updateQuery,
    scrollBand,
    viewportHeight,
    groupLayouts,
    staggerDone,
    copyById,
    deleteById,
    handleHoverStart,
    handleHoverEnd,
  ]);

  return (
    <div className="mw-page clipboard-page">
      {toolbar}
      <div className="clipboard-body">
        <div className="mw-scroll clipboard-scroll" ref={scrollRef} onScroll={handleScroll}>
          {body}
        </div>
      </div>
      {hoverAnchor && !confirmClear && <HoverPreview anchor={hoverAnchor} />}
      {confirmClear && (
        <ConfirmDialog
          title={t("清空剪贴板历史？")}
          body={t("所有记录和图片会被删除，无法恢复。")}
          confirmLabel={t("清空")}
          busy={busy}
          onConfirm={() => {
            const allIds = [...(records ?? []).map((item) => item.id), ...deferredIdsRef.current];
            void remove(allIds);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

const ClipboardRow = memo(function ClipboardRow({ record, index, rowHeight, onCopy, onDelete, onHoverStart, onHoverEnd }: {
  record: ClipboardHistoryEntry;
  index: number;
  rowHeight?: number;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onHoverStart: (record: ClipboardHistoryEntry, node: HTMLElement, pointerX?: number) => void;
  onHoverEnd: (id: string) => void;
}) {
  const { t } = useI18n();
  const isImage = record.kind === "image";
  const isStatic = index >= 12;
  const summary = isImage
    ? t("图片 {width} × {height}", { width: record.width, height: record.height })
    : previewText(record.text);
  const box = isImage ? thumbDimensions(record.width, record.height) : null;
  const rowStyle = rowHeight !== undefined
    ? (isStatic ? { height: rowHeight, boxSizing: "border-box" as const, flexShrink: 0 } : { ...stagger(index), height: rowHeight, boxSizing: "border-box" as const, flexShrink: 0 })
    : (isStatic ? undefined : stagger(index));
  return (
    <div className={`clip-entry${isStatic ? " is-static" : ""}`} style={rowStyle}>
      <button
        type="button"
        className="clip-main"
        onClick={() => onCopy(record.id)}
        onFocus={isImage ? (event) => {
          if (event.currentTarget.matches(":focus-visible")) onHoverStart(record, event.currentTarget);
        } : undefined}
        onBlur={isImage ? () => onHoverEnd(record.id) : undefined}
      >
        <time className="mono small quiet">{formatClock(record.createdAt)}</time>
        {isImage && box ? (
          <img
            className="clip-thumb"
            src={clipboardThumbUrl(record.id)}
            alt={summary}
            width={box.width}
            height={box.height}
            loading="lazy"
            decoding="async"
            onPointerEnter={(event) => onHoverStart(record, event.currentTarget, event.clientX)}
            onPointerLeave={() => onHoverEnd(record.id)}
          />
        ) : (
          <span className="clip-text" title={previewTitle(record.text)}>{summary}</span>
        )}
      </button>
      <button
        type="button"
        className="clip-delete"
        aria-label={t("删除这条记录")}
        title={t("删除这条记录")}
        onClick={() => onDelete(record.id)}
      >
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
});
