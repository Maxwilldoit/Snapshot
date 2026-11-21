import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const skipInitialStagger = useRef(cachedClipboard !== null).current;
  const [records, setRecords] = useState<ClipboardHistoryEntry[] | null>(() => cachedClipboard?.records ?? null);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hoverAnchor, setHoverAnchor] = useState<HoverPreviewAnchor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hoverAnchorRef = useRef<HoverPreviewAnchor | null>(null);
  hoverAnchorRef.current = hoverAnchor;
  const scrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  // 本页内点击「放回剪贴板」生成的新条目暂不在当前视图插入，等离开本页再回来时自然显示。
  const deferredIdsRef = useRef<Set<string>>(new Set());

  const dismissHover = useCallback(() => {
    if (hoverAnchorRef.current !== null) setHoverAnchor(null);
  }, []);

  const handleScroll = useCallback(() => {
    scrollingRef.current = true;
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      scrollIdleTimerRef.current = null;
    }, 140);
    dismissHover();
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
    setRecords(deferred.size === 0 ? list : list.filter((item) => !deferred.has(item.id)));
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
      <SearchField value={query} onChange={setQuery} label={t("搜索剪贴板历史")} placeholder={t("搜索内容或日期")} />
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
  } else if (records.length === 0) {
    body = (
      <div className="empty mw-empty">
        <h2 className="empty-title">{t("还没有剪贴板记录")}</h2>
        <p className="empty-body">{t("复制一段文字或一张图片，稍等片刻就会出现在这里。密码管理器标记的敏感内容不会被记录。")}</p>
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
                <ClipboardRow
                  key={item.id}
                  record={item}
                  index={skipInitialStagger ? 12 + order++ : order++}
                  onCopy={copyById}
                  onDelete={deleteById}
                  onHoverStart={handleHoverStart}
                  onHoverEnd={handleHoverEnd}
                />
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

const ClipboardRow = memo(function ClipboardRow({ record, index, onCopy, onDelete, onHoverStart, onHoverEnd }: {
  record: ClipboardHistoryEntry;
  index: number;
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
  return (
    <div className={`clip-entry${isStatic ? " is-static" : ""}`} style={isStatic ? undefined : stagger(index)}>
      <button
        type="button"
        className="clip-main"
        title={isImage ? undefined : t("放回剪贴板")}
        onClick={() => onCopy(record.id)}
        onPointerEnter={isImage ? (event) => onHoverStart(record, event.currentTarget, event.clientX) : undefined}
        onPointerLeave={isImage ? () => onHoverEnd(record.id) : undefined}
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
