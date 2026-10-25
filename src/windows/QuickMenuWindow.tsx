import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  copyText,
  getRecordingStatus,
  getShortcutConflicts,
  hideQuickMenu,
  listWindows,
  loadSettings,
  onPaletteOpened,
  onSettingsChanged,
  polishText,
  readClipboardText,
  resizeQuickMenu,
  runAction,
  showPromptLibrary,
  toggleRecording,
} from "../lib/backend";
import { iconUrl } from "../lib/media";
import { formatDuration } from "../lib/format";
import { localizeMessage, useI18n, useWindowTitle } from "../lib/i18n";
import { readAutoCopy } from "../lib/prefs";
import { MediaImage } from "../components/MediaImage";
import { Keys } from "../components/ui/Keys";
import type { CapturableWindow, RecordingStatus, Settings, ShortcutAction } from "../types";

type View = "menu" | "windows" | "polish";
type Status = { kind: "busy" | "ok" | "error"; text: string };
type Item = { id: string; label: ReactNode; hint?: ReactNode; run: () => void };

/** 成功类提示停留多久后自动收起 */
const OK_HIDE_DELAY_MS = 900;
/** 面板上方的透明边，与 .palette-root 的 padding-top 一致 */
const TOP_EDGE = 24;
/** 面板左右和下方的透明边 */
const EDGE = 40;
/** 菜单和窗口列表同宽；高度按各自内容包裹，切换时只更新一次原生窗口尺寸 */
const PANEL_WIDTH: Record<View, number> = { menu: 360, windows: 360, polish: 480 };

export function windowPickerLabels(item: Pick<CapturableWindow, "appName" | "title">) {
  const appName = item.appName.trim();
  const title = item.title.trim();
  // Microsoft Store 的 ChatGPT 可执行文件名仍是 Codex。优先显示用户认识的应用名。
  const name = appName.toLocaleLowerCase() === "codex" && title.toLocaleLowerCase() === "chatgpt"
    ? title
    : appName || title;
  return {
    name,
    title: title && title.toLocaleLowerCase() !== name.toLocaleLowerCase() ? title : "",
  };
}

const errorText = (error: unknown) => localizeMessage(error instanceof Error ? error.message : String(error));

/**
 * 快捷菜单：右键桌宠或按「呼出快捷菜单」快捷键出来。
 * 能做的事列成几行。
 * 键盘就能走完：↑ ↓ 选、↵ 执行、Esc 返回或关掉；润色时 Tab 换规则、Ctrl R 再来一次、Ctrl ← 看原文。
 */
export function QuickMenuWindow() {
  const { t } = useI18n();
  useWindowTitle(t("快速操作"));
  const [settings, setSettings] = useState<Settings | null>(null);
  const [view, setView] = useState<View>("menu");
  const [cursor, setCursor] = useState(0);
  const [pickerMode, setPickerMode] = useState<"capture" | "record">("capture");
  const [windows, setWindows] = useState<CapturableWindow[] | null>(null);
  const [recording, setRecording] = useState<RecordingStatus>({ active: false, target: null, startedAt: null });
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [opening, setOpening] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // 润色
  const [source, setSource] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [peek, setPeek] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const runToken = useRef(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const windowListRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const pickerToken = useRef(0);
  const lastQuickMenuSize = useRef<{ width: number; height: number } | null>(null);

  const refresh = useCallback(() => {
    loadSettings().then(setSettings).catch(() => {});
    getRecordingStatus().then((value) => value && setRecording(value)).catch(() => {});
    getShortcutConflicts()
      .then((list) => setConflicts(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  const reset = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    runToken.current += 1;
    setView("menu");
    setCursor(0);
    setStatus(null);
    setWindows(null);
    setResult(null);
    setPolishError(null);
    setRunning(false);
    setPeek(false);
    lastQuickMenuSize.current = null;
    setOpening((value) => value + 1);
    pickerToken.current += 1;
    window.setTimeout(() => rootRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    refresh();
    const opened = onPaletteOpened(() => {
      reset();
      refresh();
    });
    const settingsListener = onSettingsChanged(setSettings);
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) void hideQuickMenu();
    });
    return () => {
      void opened.then((unlisten) => unlisten()).catch(() => {});
      void settingsListener.then((unlisten) => unlisten()).catch(() => {});
      void focus.then((unlisten) => unlisten()).catch(() => {});
      // 自动收起那次 hideQuickMenu 还挂在计时器上。不撤掉的话，窗口已经关了它才触发，
      // 对着已经卸掉的 WebView 发调用（测试里表现为卸载后的 unhandled rejection）。
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [refresh, reset]);

  useEffect(() => {
    if (!recording.active && !running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording.active, running]);

  // 窗口大小跟着面板走：换视图时变宽变窄，进润色、展开窗口列表时变高。
  // 每次打开都会重新挂一个面板（key={opening}），要改量新的那个；旧面板移出页面时量到的是 0，不能拿来缩窗口。
  // 用 offsetWidth / offsetHeight：getBoundingClientRect 会把入场动画的 scale(0.97) 算进去，量小一圈。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const apply = () => {
      if (!panel.isConnected || panel.offsetHeight === 0) return;
      const width = panel.offsetWidth + EDGE * 2;
      const height = panel.offsetHeight + TOP_EDGE + EDGE;
      const previous = lastQuickMenuSize.current;
      if (previous?.width === width && previous.height === height) return;
      lastQuickMenuSize.current = { width, height };
      void resizeQuickMenu(width, height).catch(() => {
        if (lastQuickMenuSize.current?.width === width && lastQuickMenuSize.current.height === height) {
          lastQuickMenuSize.current = null;
        }
      });
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(panel);
    return () => observer.disconnect();
    // view 变了宽度就变（PANEL_WIDTH），当场重量一次，不等 ResizeObserver
  }, [opening, view]);

  function showStatus(next: Status | null, hideAfter = false) {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setStatus(next);
    if (hideAfter) hideTimer.current = window.setTimeout(() => void hideQuickMenu(), OK_HIDE_DELAY_MS);
  }

  const accelerator = (action: ShortcutAction) =>
    settings?.shortcuts.find((item) => item.action === action)?.accelerator ?? null;
  const shortcutHint = (action: ShortcutAction) => {
    const value = accelerator(action);
    if (!value) return null;
    if (conflicts.includes(value)) return <span className="signal small">{t("快捷键被占用")}</span>;
    return <Keys value={value} quiet />;
  };

  async function openPicker(mode: "capture" | "record") {
    const token = ++pickerToken.current;
    setPickerMode(mode);
    setCursor(0);
    showStatus(null);
    try {
      const list = await listWindows();
      if (token !== pickerToken.current) return;
      // 等列表到手再切页：避免「读取中」矮面板和完整列表之间再改一次高度。
      setWindows(list);
      setView("windows");
    } catch (error) {
      if (token !== pickerToken.current) return;
      setWindows([]);
      setView("windows");
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
    rootRef.current?.focus();
  }

  async function openPromptLibrary() {
    try {
      await showPromptLibrary();
    } catch (error) {
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
  }

  async function pickWindow(item: CapturableWindow) {
    if (pickerMode === "capture") {
      // 后端先把快捷菜单藏起来再截，免得截进画面；失败会记进活动，主窗口的猫会说
      void runAction("capture", item.id).catch(() => {});
      return;
    }
    showStatus({ kind: "busy", text: t("正在开始录 {app}…", { app: item.appName }) });
    try {
      const next = await toggleRecording(item.id);
      setRecording(next);
      setView("menu");
      const message = next.message?.trim();
      showStatus({
        kind: "ok",
        text: message ? localizeMessage(message) : t("开始录制 {target}", { target: next.target ?? item.appName }),
      }, true);
    } catch (error) {
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
  }

  async function stopRecording() {
    showStatus({ kind: "busy", text: t("正在停止并保存录像…") });
    try {
      const next = await toggleRecording();
      setRecording(next);
      showStatus({ kind: "ok", text: next.active ? t("录制还在继续") : t("录制已保存") }, !next.active);
    } catch (error) {
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
  }

  const run = useCallback(
    async (text: string, template: string | null) => {
      const token = ++runToken.current;
      setRunning(true);
      setPolishError(null);
      setResult(null);
      setPeek(false);
      setStartedAt(Date.now());
      try {
        const polished = await polishText(text, template);
        if (token !== runToken.current) return;
        setResult(polished);
        if (readAutoCopy()) {
          void copyText(polished).catch((error) => {
            if (token === runToken.current) {
              setPolishError(t("自动复制失败：{detail}", { detail: errorText(error) }));
            }
          });
        }
      } catch (error) {
        if (token !== runToken.current) return;
        setPolishError(t(errorText(error)));
      } finally {
        if (token === runToken.current) setRunning(false);
      }
    },
    [t],
  );

  function enterPolish(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const template = settings?.activeTemplateId ?? null;
    setSource(trimmed);
    setResult(null);
    setTemplateId(template);
    setView("polish");
    showStatus(null);
    if (!settings?.baseUrl || !settings?.model) {
      setPolishError(t("还没填模型接口，润色用不了。请在主窗口的「偏好设置」里填写。"));
      return;
    }
    void run(trimmed, template);
  }

  async function polishClipboardText() {
    try {
      enterPolish(await readClipboardText());
    } catch (error) {
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
  }

  function cycleRule(step: number) {
    const templates = settings?.templates ?? [];
    if (templates.length < 2) return;
    const index = Math.max(0, templates.findIndex((item) => item.id === templateId));
    const next = templates[(index + step + templates.length) % templates.length];
    setTemplateId(next.id);
    if (settings?.baseUrl && settings.model) void run(source, next.id);
  }

  async function copyAndClose() {
    if (!result) return;
    try {
      await copyText(result);
      void hideQuickMenu();
    } catch (error) {
      showStatus({ kind: "error", text: t(errorText(error)) });
    }
  }

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      {
        id: "capture",
        label: t("快照"),
        hint: shortcutHint("snapshot"),
        run: () => void openPicker("capture"),
      },
      {
        id: "fullscreen",
        label: t("全屏截图"),
        hint: shortcutHint("fullscreen"),
        run: () => void runAction("fullscreen").catch(() => {}),
      },
      recording.active
        ? {
            id: "record",
            label: t("停止录制 · {target}", { target: recording.target ?? t("窗口") }),
            // 时长放在右边：窗口名太长时左边会被截掉，时长不能跟着没了
            hint: (
              <>
                <span className="mono signal">{formatDuration(now - (recording.startedAt ?? now))}</span>
                {shortcutHint("record")}
              </>
            ),
            run: () => void stopRecording(),
          }
        : {
            id: "record",
            label: t("录制"),
            hint: shortcutHint("record"),
            run: () => void openPicker("record"),
          },
      {
        id: "prompts",
        label: t("Prompt 库"),
        hint: shortcutHint("prompts"),
        run: () => void openPromptLibrary(),
      },
      {
        id: "polish",
        label: t("润色 Prompt"),
        hint: shortcutHint("polish"),
        run: () => void polishClipboardText(),
      },
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, recording, conflicts, now, t]);

  const visibleWindows = windows ?? [];

  // 进润色后键盘焦点落在结果区，Tab / ↵ / Esc 才接得住
  useEffect(() => {
    if (view === "polish") resultRef.current?.focus();
    else rootRef.current?.focus();
  }, [opening, view]);

  const rowCount = view === "menu" ? items.length : view === "windows" ? visibleWindows.length : 0;
  useEffect(() => setCursor(0), [view]);

  // 键盘越过第 5 个窗口时，让当前选中项始终留在 5 行的可视区域内。
  useEffect(() => {
    if (view !== "windows") return;
    windowListRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, view, windows]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (view === "polish") {
      if (event.key === "Escape") {
        event.preventDefault();
        runToken.current += 1;
        setRunning(false);
        setView("menu");
        window.setTimeout(() => rootRef.current?.focus(), 0);
      } else if (event.key === "Tab") {
        event.preventDefault();
        cycleRule(event.shiftKey ? -1 : 1);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!running) void copyAndClose();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (!running) void run(source, templateId);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "ArrowLeft") {
        event.preventDefault();
        setPeek((value) => !value);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (rowCount ? (value + 1) % rowCount : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (rowCount ? (value - 1 + rowCount) % rowCount : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (view === "menu") items[cursor]?.run();
      else if (visibleWindows[cursor]) void pickWindow(visibleWindows[cursor]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (view === "windows") {
        setView("menu");
      } else void hideQuickMenu();
    }
  }

  const templates = settings?.templates ?? [];
  const templateName = t(templates.find((item) => item.id === templateId)?.name ?? "默认规则");

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="palette-root"
      onMouseDown={(event) => {
        // 点在面板外面（透明区域）就收起
        if (event.target === event.currentTarget) void hideQuickMenu();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="palette-wrap" key={opening} style={{ width: PANEL_WIDTH[view] }}>
        <div className="palette" ref={panelRef} role="dialog" aria-label={t("应用快照快捷菜单")}>
          {view === "polish" ? (
            <div className="palette-polish">
              <div className="palette-source small">
                <span className="quiet">{t("原文")}</span>
                <span className="palette-source-text">{source}</span>
                {result && (
                  <span className="mono quiet">
                    {t("{sourceCount} → {resultCount} 字", { sourceCount: source.length, resultCount: result.length })}
                  </span>
                )}
              </div>
              <div className="palette-result" tabIndex={-1} ref={resultRef} aria-live="polite">
                {running ? (
                  <p className="palette-busy">
                    <span className="busy-line" aria-hidden="true" />
                    <span>
                      {t("正在按「{template}」润色 · {seconds} 秒", {
                        template: templateName,
                        seconds: Math.floor((now - startedAt) / 1000),
                      })}
                    </span>
                  </p>
                ) : polishError ? (
                  <p className="signal">
                    {polishError}　{settings?.baseUrl && settings.model && (
                      <button type="button" className="link" onClick={() => void run(source, templateId)}>{t("重试")}</button>
                    )}
                  </p>
                ) : (
                  <p className="palette-result-text">{peek ? source : result}</p>
                )}
              </div>
              <div className="palette-foot small">
                <button type="button" className="text-btn palette-rule" onClick={() => cycleRule(1)} disabled={templates.length < 2}>
                  <span className="strong">{templateName}</span>
                </button>
                <span className="spacer" />
                <button type="button" className="text-btn ink-2" onClick={() => setPeek((value) => !value)} disabled={!result}>
                  {peek ? t("看结果") : t("看原文")}<span className="mono quiet">Ctrl ←</span>
                </button>
                <button type="button" className="text-btn ink-2" onClick={() => void run(source, templateId)} disabled={running}>
                  {t("再来一次")}<span className="mono quiet">Ctrl R</span>
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void copyAndClose()} disabled={!result || running}>
                  {t("复制并关闭")}<span className="mono">↵</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {view === "windows" && (
                <div className="palette-window-head">
                  <button type="button" className="palette-back" aria-label={t("返回")} onClick={() => setView("menu")}>
                    <svg width="7" height="12" viewBox="0 0 7 12" aria-hidden="true"><path d="M6 1L1 6l5 5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                  </button>
                  <span className="palette-window-heading">
                    {t(pickerMode === "capture" ? "选择要截取的窗口" : "选择要录制的窗口")}
                  </span>
                  <span className="mono small quiet">Esc</span>
                </div>
              )}

              {view === "menu" ? (
                <div className="palette-list palette-menu" role="listbox" aria-label={t("动作")}>
                  {items.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === cursor}
                      className={`palette-item ${index === cursor ? "is-on" : ""}`}
                      onMouseMove={() => setCursor(index)}
                      onClick={item.run}
                    >
                      <span className="palette-label">{item.label}</span>
                      {item.hint && <span className="palette-hint">{item.hint}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div ref={windowListRef} className="palette-list palette-windows" role="listbox" aria-label={t(pickerMode === "capture" ? "选择要截取的窗口" : "选择要录制的窗口")}>
                  {windows === null && <p className="palette-empty small quiet">{t("正在读取窗口…")}</p>}
                  {windows !== null && visibleWindows.length === 0 && (
                    <p className="palette-empty small quiet">{t("没有找到可用的窗口")}</p>
                  )}
                  {visibleWindows.map((item, index) => {
                    const labels = windowPickerLabels(item);
                    return <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === cursor}
                      className={`palette-item ${index === cursor ? "is-on" : ""}`}
                      onMouseMove={() => setCursor(index)}
                      onClick={() => void pickWindow(item)}
                    >
                      <span className="palette-window">
                        <span className="palette-icon">
                          <MediaImage src={iconUrl(item.pid, 20)} fallback={<span className="palette-icon-blank" />} />
                        </span>
                        <span className="palette-window-name">{labels.name}</span>
                        {labels.title && <span className="palette-window-title small quiet">{labels.title}</span>}
                        {item.minimized && (
                          <span className="palette-window-state small quiet">{t("已最小化")}</span>
                        )}
                      </span>
                    </button>;
                  })}
                </div>
              )}
            </>
          )}
          {status && (
            <div className={`palette-status small is-${status.kind}`} role="status">
              {status.kind === "busy" && <span className="busy-dot" aria-hidden="true" />}
              {status.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
