import { useCallback, useEffect, useRef, useState } from "react";
import { LibraryWindow } from "../components/LibraryWindow";
import { SearchField } from "../components/SearchField";
import { Keys } from "../components/ui/Keys";
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
        text: t("{action}失败：{detail}", {
          action: t("保存"),
          detail: errorText(error),
        }),
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
            text: t("{action}失败：{detail}", {
              action: t("关闭"),
              detail: errorText(error),
            }),
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
        text: t("{action}失败：{detail}", {
          action: t("复制"),
          detail: errorText(error),
        }),
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

  function editDraft(
    update: Partial<Pick<EditingPrompt, "title" | "content">>,
  ) {
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
        text: t("{action}失败：{detail}", {
          action: t("删除"),
          detail: errorText(error),
        }),
      });
    } finally {
      setDeleting(false);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const visiblePrompts = needle
    ? prompts.filter(
        (prompt) =>
          prompt.title.toLocaleLowerCase().includes(needle) ||
          prompt.content.toLocaleLowerCase().includes(needle),
      )
    : prompts;

  return (
    <LibraryWindow
      title={t("Prompt 库")}
      onError={(text) => setStatus({ kind: "error", text })}
    >
      <main className="mw-scroll">
        <div className="library-content">
          {editing ? (
            <form
              className="form library-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveDraft();
              }}
            >
              <div className="library-actions">
                <h2 className="panel-title">
                  {t(editing.id ? "编辑" : "新建")}
                </h2>
                <button type="button" className="link" onClick={closeEditor}>
                  {t("返回")}
                </button>
              </div>
              <label className="form-field">
                <span className="form-label">{t("名称")}</span>
                <input
                  ref={titleRef}
                  className="input"
                  value={editing.title}
                  onChange={(event) => editDraft({ title: event.target.value })}
                  aria-label={t("名称")}
                  maxLength={80}
                  spellCheck={false}
                />
              </label>
              <label className="form-field">
                <span className="form-label">{t("正文")}</span>
                <textarea
                  ref={contentRef}
                  className="input library-textarea"
                  value={editing.content}
                  onChange={(event) =>
                    editDraft({ content: event.target.value })
                  }
                  aria-label={t("正文")}
                  placeholder={t("粘贴或输入要长期保存的 Prompt")}
                  maxLength={200_000}
                  spellCheck={false}
                />
                {editing.content.length >= 180_000 && (
                  <span className="small quiet">
                    {t("{count} 字", { count: editing.content.length })} /
                    200,000
                  </span>
                )}
              </label>
              <div className="library-actions">
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
                <span className="dialog-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={closeEditor}
                    disabled={saving || deleting}
                  >
                    {t("取消")}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!editing.content.trim() || saving || deleting}
                  >
                    {saving ? t("保存中…") : t("保存")}
                    <span aria-hidden="true">
                      <Keys value="CommandOrControl+S" quiet />
                    </span>
                  </button>
                </span>
              </div>
            </form>
          ) : (
            <>
              <div className="library-toolbar">
                <SearchField
                  inputRef={searchRef}
                  value={query}
                  onChange={setQuery}
                  label={t("搜索")}
                  placeholder={t("搜索名称或正文")}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openNew}
                >
                  {t("新建")}
                  <span aria-hidden="true">
                    <Keys value="CommandOrControl+N" quiet />
                  </span>
                </button>
              </div>
              {loading ? (
                <div className="library-empty" role="status">
                  <span className="busy-line" aria-hidden="true" />
                  {t("加载中")}
                </div>
              ) : loadError ? (
                <div className="library-empty" role="alert">
                  <h2>{t("失败")}</h2>
                  <p>{loadError}</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void load()}
                  >
                    {t("重试")}
                  </button>
                </div>
              ) : prompts.length === 0 ? (
                <div className="library-empty" role="status">
                  <h2>{t("这里还空着")}</h2>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={openNew}
                  >
                    {t("新建")}
                  </button>
                </div>
              ) : visiblePrompts.length === 0 ? (
                <div className="library-empty" role="status">
                  <h2>{t("没有匹配的 Prompt")}</h2>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    {t("清除筛选")}
                  </button>
                </div>
              ) : (
                <div className="library-list" aria-label={t("Prompt 库")}>
                  {visiblePrompts.map((prompt) => (
                    <article
                      className="library-row"
                      key={prompt.id}
                      aria-label={prompt.title || t("未命名")}
                    >
                      <div className="library-row-content">
                        <h2>{prompt.title || t("未命名")}</h2>
                        <p>{prompt.content}</p>
                      </div>
                      <div className="library-row-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void copy(prompt)}
                          disabled={copyingId !== null}
                        >
                          {copyingId === prompt.id ? t("正在复制…") : t("复制")}
                        </button>
                        <button
                          type="button"
                          className="text-btn"
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
            </>
          )}
          {status && (
            <p
              className={`library-status ${status.kind === "error" ? "signal" : "ink-2"}`}
              role={status.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {status.text}
            </p>
          )}
        </div>
      </main>
    </LibraryWindow>
  );
}
