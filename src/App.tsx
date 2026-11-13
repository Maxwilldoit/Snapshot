import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getShortcutConflicts,
  loadSettings,
  onCaptureShot,
  onPromptLibraryOpened,
  onSettingsChanged,
  platformCapabilities,
} from "./lib/backend";
import { prepareHintSound, previewHintSound, primeHintSound } from "./lib/sound";
import { shortcutKeys } from "./lib/format";
import { canViewTransition, viewTransition, type TransitionDirection } from "./lib/motion";
import { AppContext, errorText, type AppContextValue, type Notice, type NoticeKind } from "./app/context";
import { NoticeLine, SideNav, WindowChrome } from "./app/Shell";
import { LoadingState } from "./components/LoadingState";
import { useActivityLog, useClipboardState, useRecordingStatus } from "./hooks/useLive";
import { ShortcutsPage } from "./pages/ShortcutsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { PromptsPage } from "./pages/PromptsPage";
import { PromptLibraryPage } from "./pages/PromptLibraryPage";
import { PetPage } from "./pages/PetPage";
import { CapturePage } from "./pages/CapturePage";
import { GeneralPage } from "./pages/GeneralPage";
import type { NavPage, PlatformCapabilities, Settings } from "./types";
import { useI18n, useWindowTitle } from "./lib/i18n";

/** 侧栏的先后顺序决定换页时上下滑入的方向 */
const NAV_ORDER: NavPage[] = ["history", "prompts", "prompt-library", "capture", "shortcuts", "general", "pet"];

function directionFor(from: NavPage, to: NavPage): TransitionDirection {
  return NAV_ORDER.indexOf(to) >= NAV_ORDER.indexOf(from) ? "down" : "up";
}

/** 普通提示自己消失，出错的多留一会儿 */
const NOTICE_MS: Record<NoticeKind, number> = { info: 3200, error: 9000 };

function PageView({ page }: { page: NavPage }) {
  switch (page) {
    case "prompts":
      return <PromptsPage />;
    case "pet":
      return <PetPage />;
    case "capture":
      return <CapturePage />;
    case "shortcuts":
      return <ShortcutsPage />;
    case "general":
      return <GeneralPage />;
    default:
      return <HistoryPage />;
  }
}

export function App() {
  const { t } = useI18n();
  useWindowTitle(t("应用快照"));
  // 默认值只在后端有一份；拿到之前显示加载态，不在前端再抄一份默认设置
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<NavPage>("history");
  const [viewedPetId, setViewedPetId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const recentCaptureShots = useRef<string[]>([]);
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const activity = useActivityLog();
  const clipboard = useClipboardState();
  const recording = useRecordingStatus();

  const notify = useCallback((text: string, kind: NoticeKind = "info") => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ id: Date.now(), text, kind, at: Date.now() });
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS[kind]);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .catch((error) => notify(t("读取设置失败：{detail}", { detail: errorText(error) }), "error"));
    platformCapabilities()
      .then((value) => setCaps(value ?? null))
      .catch(() => setCaps(null));
    const pending = onSettingsChanged(setSettings);
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [notify]);

  // 正在看的是桌面上那只时，桌面换了（素材库导入、托盘切换）就跟着换；看的是别的就不打扰
  const deskPet = settings?.selectedAppearanceId ?? null;
  const previousDeskPet = useRef(deskPet);
  useEffect(() => {
    const previous = previousDeskPet.current;
    previousDeskPet.current = deskPet;
    if (previous !== deskPet) setViewedPetId((viewed) => (viewed === previous ? null : viewed));
  }, [deskPet]);

  // 托盘暂停也会推送设置，清掉已经释放的快捷键上残留的冲突标记。
  useEffect(() => {
    if (settings?.shortcutsPaused) setConflicts([]);
  }, [settings?.shortcutsPaused]);

  // 自定义快门音提前读进内存，截图那一下直接播
  const customShutter = settings?.shutterSound === "custom" ? settings.customSoundPath : null;
  const settingsLoaded = settings !== null;
  useEffect(() => {
    if (settingsLoaded) prepareHintSound(customShutter);
  }, [customShutter, settingsLoaded]);

  // 快捷键由后端在启动时注册；那一刻网页还没加载，注册不上的键等到这里再提示
  useEffect(() => {
    getShortcutConflicts()
      .then((failed) => {
        if (!Array.isArray(failed) || failed.length === 0) return;
        setConflicts(failed);
        notify(t("{keys} 没能注册，可能被别的程序占用了", {
          keys: failed.map((key) => shortcutKeys(key).join(" ")).join(" / "),
        }), "error");
      })
      // 只是一条提示，取不到不影响使用
      .catch(() => {});
  }, [notify]);

  useEffect(() => {
    const pending = onCaptureShot((payload) => {
      // Tauri 正常只投递一次；事件重放或 StrictMode 下重复挂载也不能响两声。
      if (recentCaptureShots.current.includes(payload.shotId)) return;
      recentCaptureShots.current = [...recentCaptureShots.current.slice(-15), payload.shotId];
      const receivedEpoch = Date.now();
      const receivedAt = performance.now();
      if (payload.flash) {
        setFlash(true);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(false), 220);
      }
      if (payload.shutterSound !== "none") {
        previewHintSound(
          payload.shutterSound === "soft" ? "soft" : "crisp",
          payload.shutterSound === "custom" ? payload.customSoundPath : null,
          80,
        );
      }
      if (payload.trace) {
        console.debug(
          `[snapshot] capture feedback shot=${payload.shotId} end_to_end_ms=${receivedEpoch - payload.startedAtMs} bridge_ms=${receivedEpoch - payload.sentAtMs} sound_schedule_ms=${(performance.now() - receivedAt).toFixed(2)}`,
        );
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    };
  }, []);

  useEffect(() => {
    // 提前创建共享的 Web Audio 上下文；真正恢复/播放仍发生在用户操作或截图事件里。
    primeHintSound();
    const unlock = () => primeHintSound();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // 走 View Transitions 的换页不再单独淡入，避免过渡结束后重复播放
  const pageEnters = useRef(true);
  const pageRef = useRef(page);
  pageRef.current = page;

  // 换页：旧页往反方向退半步淡掉，新页从导航的方向滑进来；导航下的墨线跟着滑过去
  const navigate = useCallback<AppContextValue["navigate"]>((next, options) => {
    if (options?.previewId) setPendingPreviewId(options.previewId);
    if (options?.petId !== undefined) setViewedPetId(options.petId);
    const from = pageRef.current;
    if (next === from) return;
    pageEnters.current = !canViewTransition();
    viewTransition(
      "page",
      () => {
        setPage(next);
        mainRef.current?.querySelector(".mw-scroll")?.scrollTo?.({ top: 0 });
      },
      { direction: directionFor(from, next) },
    );
  }, []);

  useEffect(() => {
    const pending = onPromptLibraryOpened(() => navigate("prompt-library"));
    return () => { void pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, [navigate]);

  const value = useMemo<AppContextValue | null>(
    () =>
      settings && {
        settings,
        onSaved: setSettings,
        notify,
        notice,
        dismissNotice,
        conflicts,
        setConflicts,
        caps,
        activity,
        clipboard,
        recording,
        page,
        navigate,
        viewedPetId,
        pendingPreviewId,
        consumePreviewId: () => setPendingPreviewId(null),
      },
    [
      settings, notify, notice, dismissNotice, conflicts, caps, activity, clipboard, recording,
      page, navigate, viewedPetId, pendingPreviewId,
    ],
  );

  if (!value) {
    return (
      <div className="window mw">
        <BareTitleBar />
        <LoadingState />
        {notice && <div className="notice-line is-error" role="alert">{notice.text}</div>}
      </div>
    );
  }

  const content = (
    <main className="main" ref={mainRef}>
      <div key={page} hidden={page === "prompt-library"} className={`page-view page-${page} ${pageEnters.current ? "is-entering" : ""}`}>
        {page !== "prompt-library" && <PageView page={page} />}
      </div>
      {/* 换页保留库的编辑草稿；隐藏时不接管搜索、保存或 Esc。 */}
      <div hidden={page !== "prompt-library"} className={`page-view page-prompt-library ${pageEnters.current ? "is-entering" : ""}`}>
        <PromptLibraryPage active={page === "prompt-library"} />
      </div>
    </main>
  );

  return (
    <AppContext.Provider value={value}>
      <div className={`window mw ${caps?.os === "macos" ? "is-mac" : ""}`}>
        <div className="shell">
          <aside className="sidebar">
            <WindowChrome placement="sidebar" />
            <SideNav />
          </aside>
          {content}
        </div>

        <NoticeLine />
        {flash && <div className="shutter-flash" aria-hidden="true" />}
      </div>
    </AppContext.Provider>
  );
}

/** 设置还没读到时也得能拖动、关闭窗口 */
function BareTitleBar() {
  const { t } = useI18n();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="titlebar-name">{t("应用快照")}</span>
    </header>
  );
}
