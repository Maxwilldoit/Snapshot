import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyText,
  deleteSavedPrompt,
  hidePromptLibrary,
  listSavedPrompts,
  onPromptLibraryOpened,
  saveSavedPrompt,
} from "../lib/backend";
import { localizeMessage, useI18n, useWindowTitle } from "../lib/i18n";
import type { SavedPrompt } from "../types";
import "./PromptLibraryWindow.css";

type EditingPrompt = {
  key: number;
  id: string | null;
  title: string;
  content: string;
};

type Status = {
  kind: "ok" | "error";
  text: string;
};

const errorText = (error: unknown) =>
  localizeMessage(error instanceof Error ? error.message : String(error));

/**
 * 独立的 Prompt 库。这里保存的是用户反复使用、复制的原文，
 * 与润色规则和润色历史互不相干。
 */
export function PromptLibraryWindow() {
  const { t } = useI18n();
  useWindowTitle(t("Prompt 库"));

  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditingPrompt | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const loadVersion = useRef(0);
  const editorVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listSavedPrompts();
      if (version === loadVersion.current) {
        setPrompts(Array.isArray(next) ? next : []);
      }
    } catch (error) {
      if (version === loadVersion.current) {
        setLoadError(errorText(error));
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void load();
    void onPromptLibraryOpened(() => {
      if (!active) return;
      setStatus(null);
      setDeleteArmed(false);
      void load();
      // 保留未保存的编辑草稿；搜索框只在当前确实显示列表时存在。
      window.setTimeout(() => searchRef.current?.focus(), 0);
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {
        // 初次读取仍可用；事件订阅失败时不要让整个窗口空着。
      });

    return () => {
      active = false;
      loadVersion.current += 1;
      unlisten?.();
    };
  }, [load]);

  useEffect(() => {
    if (!editing) return;
    const target = editing.id ? contentRef.current : titleRef.current;
    target?.focus();
  }, [editing?.key, editing?.id]);

  useEffect(() => {
    if (loading || editing) return;
    searchRef.current?.focus();
  }, [editing, loading]);

  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  const openNew = useCallback(() => {
    if (saving || deleting) return;
    setEditing({
      key: ++editorVersion.current,
      id: null,
      title: "",
      content: "",
    });
    setDeleteArmed(false);
    setStatus(null);
  }, [deleting, saving]);

  const closeEditor = useCallback(() => {
    if (saving || deleting) return;
    setEditing(null);
    setDeleteArmed(false);
    setStatus(null);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [deleting, saving]);

  const saveDraft = useCallback(async () => {
    if (!editing || saving || deleting || !editing.content.trim()) return;
    // 保存返回的列表比任何在途读取都新；让它落地后不再被旧请求覆盖。
    loadVersion.current += 1;
    setSaving(true);
    setLoading(false);
    setLoadError(null);
    setDeleteArmed(false);
    setStatus(null);
    try {
      const next = await saveSavedPrompt({
        id: editing.id,
        title: editing.title,
        content: editing.content,
      });
      setPrompts(Array.isArray(next) ? next : []);
      setQuery("");
      setEditing(null);
      setDeleteArmed(false);
      setStatus({ kind: "ok", text: t("Prompt 已保存") });
      window.setTimeout(() => searchRef.current?.focus(), 0);
    } catch (error) {
      setStatus({
        kind: "error",
        text: t("{action}失败：{detail}", { action: t("保存"), detail: errorText(error) }),
      });
    } finally {
      setSaving(false);
    }
  }, [deleting, editing, saving, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (commandKey && key === "n") {
        event.preventDefault();
        if (editing) {
          setStatus({ kind: "error", text: t("请先保存或取消当前编辑") });
          return;
        }
        openNew();
        return;
      }
      if (commandKey && key === "s" && editing) {
        event.preventDefault();
        void saveDraft();
        return;
      }
      if (commandKey && key === "f" && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key !== "Escape") return;

      event.preventDefault();
      if (editing) closeEditor();
      else {
        void hidePromptLibrary().catch((error) => {
          setStatus({
            kind: "error",
            text: t("{action}失败：{detail}", { action: t("关闭"), detail: errorText(error) }),
          });
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeEditor, editing, openNew, saveDraft, t]);

  async function copy(prompt: SavedPrompt) {
    if (copyingId) return;
    setCopyingId(prompt.id);
    setStatus(null);
    try {
      await copyText(prompt.content);
      setStatus({ kind: "ok", text: t("Prompt 已复制") });
    } catch (error) {
      setStatus({
        kind: "error",
        text: t("{action}失败：{detail}", { action: t("复制"), detail: errorText(error) }),
      });
    } finally {
      setCopyingId(null);
    }
  }

  function beginEdit(prompt: SavedPrompt) {
    if (saving || deleting) return;
    setEditing({
      key: ++editorVersion.current,
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
    });
    setDeleteArmed(false);
    setStatus(null);
  }

  function editDraft(update: Partial<Pick<EditingPrompt, "title" | "content">>) {
    setEditing((current) => (current ? { ...current, ...update } : current));
    setDeleteArmed(false);
    setStatus(null);
  }

  async function remove() {
    if (!editing?.id || deleting) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setStatus(null);
      return;
    }

    const removed = editing;
    loadVersion.current += 1;
    setDeleting(true);
    setLoading(false);
    setLoadError(null);
    setStatus(null);
    try {
      const next = await deleteSavedPrompt(removed.id!);
      setPrompts(Array.isArray(next) ? next : []);
      setEditing(null);
      setDeleteArmed(false);
      setStatus({ kind: "ok", text: t("Prompt 已删除") });
      window.setTimeout(() => searchRef.current?.focus(), 0);
    } catch (error) {
      setStatus({
        kind: "error",
        text: t("{action}失败：{detail}", { action: t("删除"), detail: errorText(error) }),
      });
    } finally {
      setDeleting(false);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const visiblePrompts = needle
    ? prompts.filter((prompt) =>
        prompt.title.toLocaleLowerCase().includes(needle) ||
        prompt.content.toLocaleLowerCase().includes(needle),
      )
    : prompts;

  return (
    <div className="prompt-library-root">
      <header className="prompt-library-header">
        <div className="prompt-library-heading">
          <p className="prompt-library-kicker">{t("PROMPT LIBRARY")}</p>
          <h1>{editing ? t(editing.id ? "编辑" : "新建") : t("Prompt 库")}</h1>
        </div>
        {!editing && (
          <button type="button" className="btn btn-primary prompt-library-new" onClick={openNew}>
            {t("新建")}
            <span className="prompt-library-shortcut mono" aria-hidden="true">Ctrl N</span>
          </button>
        )}
      </header>

      {editing ? (
        <form
          className="prompt-library-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <button type="button" className="text-btn prompt-library-back" onClick={closeEditor}>
            <span aria-hidden="true">←</span>
            {t("返回")}
          </button>

          <label className="prompt-library-field">
            <span className="prompt-library-label">
              {t("名称")}
              <span className="quiet">{t("可选")}</span>
            </span>
            <input
              ref={titleRef}
              className="input prompt-library-title-input"
              value={editing.title}
              onChange={(event) => editDraft({ title: event.target.value })}
              aria-label={t("名称")}
              maxLength={80}
              spellCheck={false}
            />
          </label>

          <label className="prompt-library-field prompt-library-content-field">
            <span className="prompt-library-label">
              {t("正文")}
              <span className="mono quiet">{t("{count} 字", { count: editing.content.length })}</span>
            </span>
            <textarea
              ref={contentRef}
              className="input prompt-library-content"
              value={editing.content}
              onChange={(event) => editDraft({ content: event.target.value })}
              aria-label={t("正文")}
              placeholder={t("粘贴或输入要长期保存的 Prompt")}
              maxLength={200_000}
              spellCheck={false}
            />
          </label>

          <div className="prompt-library-editor-foot">
            <span>
              {editing.id && (
                <button
                  type="button"
                  className={`text-btn ${deleteArmed ? "signal" : "ink-2"}`}
                  onClick={() => void remove()}
                  disabled={saving || deleting}
                >
                  {deleteArmed ? t("再点一次删除") : t("删除")}
                </button>
              )}
            </span>
            <span className="prompt-library-editor-actions">
              <button type="button" className="btn" onClick={closeEditor} disabled={saving || deleting}>
                {t("取消")}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!editing.content.trim() || saving || deleting}
              >
                {saving ? t("保存中…") : t("保存")}
                {!saving && <span className="prompt-library-shortcut mono" aria-hidden="true">Ctrl S</span>}
              </button>
            </span>
          </div>

          {status && (
            <p
              className={`prompt-library-status prompt-library-editor-status is-${status.kind}`}
              role={status.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {status.text}
            </p>
          )}
        </form>
      ) : (
        <main className="prompt-library-main">
          <div className="prompt-library-toolbar">
            <label className="prompt-library-search">
              <span className="prompt-library-search-icon" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t("搜索")}
                placeholder={t("搜索名称或正文")}
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  className="prompt-library-search-clear"
                  aria-label={t("清除")}
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              )}
            </label>
            {!loading && !loadError && (
              <span className="prompt-library-count quiet">
                {t("{count} 项", { count: visiblePrompts.length })}
              </span>
            )}
          </div>

          <div className="prompt-library-content-area">
            {loading ? (
              <div className="prompt-library-loading" role="status">
                <span className="busy-line" aria-hidden="true" />
                <span>{t("加载中")}</span>
              </div>
            ) : loadError ? (
              <div className="prompt-library-empty" role="alert">
                <h2>{t("失败")}</h2>
                <p>{loadError}</p>
                <button type="button" className="text-btn link" onClick={() => void load()}>
                  {t("重试")}
                </button>
              </div>
            ) : prompts.length === 0 ? (
              <div className="prompt-library-empty" role="status">
                <p className="prompt-library-empty-mark mono" aria-hidden="true">01</p>
                <h2>{t("这里还空着")}</h2>
                <button type="button" className="text-btn link" onClick={openNew}>{t("新建")}</button>
              </div>
            ) : visiblePrompts.length === 0 ? (
              <div className="prompt-library-empty" role="status">
                <p className="prompt-library-empty-mark mono" aria-hidden="true">00</p>
                <h2>{t("没有匹配的 Prompt")}</h2>
                <button
                  type="button"
                  className="text-btn link"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  {t("清除筛选")}
                </button>
              </div>
            ) : (
              <div className="prompt-library-list" aria-label={t("Prompt 库")}>
                {visiblePrompts.map((prompt) => (
                  <article
                    className="prompt-library-row"
                    key={prompt.id}
                    aria-label={prompt.title || t("未命名")}
                  >
                    <div className="prompt-library-row-copy">
                      <h2>{prompt.title || t("未命名")}</h2>
                      <p>{prompt.content}</p>
                    </div>
                    <div className="prompt-library-row-actions">
                      <button
                        type="button"
                        className="text-btn ink-2"
                        onClick={() => void copy(prompt)}
                        disabled={copyingId !== null}
                      >
                        {copyingId === prompt.id ? t("正在复制…") : t("复制")}
                      </button>
                      <button
                        type="button"
                        className="text-btn ink-2"
                        onClick={() => beginEdit(prompt)}
                        disabled={copyingId !== null}
                      >
                        {t("编辑")}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          {status && (
            <p
              className={`prompt-library-status is-${status.kind}`}
              role={status.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {status.text}
            </p>
          )}
        </main>
      )}
    </div>
  );
}
