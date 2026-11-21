import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { copyClipboardHistory, deleteClipboardHistory, listClipboardHistory, onClipboardHistoryChanged } from "../lib/backend";
import { clipboardThumbUrl } from "../lib/media";
import { formatClock, groupByDay } from "../lib/format";
import { stagger } from "../lib/motion";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { SearchField } from "../components/SearchField";
import { TimelineScrubber } from "../components/TimelineScrubber";
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
  const { notify } = useApp();
  const { t } = useI18n();
  const [records, setRecords] = useState<ClipboardHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const copyById = useCallback(async (id: string) => {
    try {
      await copyClipboardHistory(id);
      notify(t("已放回剪贴板"));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }, [notify, t]);

  const remove = useCallback(async (ids: string[]) => {
    setBusy(true);
    try {
      setRecords(await deleteClipboardHistory(ids));
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }, [notify]);

  const deleteById = useCallback((id: string) => {
    void remove([id]);
  }, [remove]);

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
          <section className="day" key={group.key} data-day-key={group.key} aria-label={group.label}>
            <div className="day-label">
              <h2 className="day-title">{group.label}</h2>
            </div>
            <div className="prompt-list">
              {group.items.map((item) => (
                <ClipboardRow key={item.id} record={item} index={order++} onCopy={copyById} onDelete={deleteById} />
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
        <div className="mw-scroll clipboard-scroll" ref={scrollRef}>
          {body}
        </div>
        {groups.length > 0 && <TimelineScrubber groups={groups} scrollRef={scrollRef} />}
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

const ClipboardRow = memo(function ClipboardRow({ record, index, onCopy, onDelete }: {
  record: ClipboardHistoryEntry;
  index: number;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
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
        title={t("放回剪贴板")}
        onClick={() => onCopy(record.id)}
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
