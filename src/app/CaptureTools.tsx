import { useEffect, useState } from "react";
import { CircleDot, ScanLine, Square } from "lucide-react";
import { authorizeScreenCapture, runAction, savePreferences, toggleRecording } from "../lib/backend";
import {
  WINDOW_LIST_LOADING_DELAY_MS,
  cachedWindows,
  confirmWindow,
  ensureFreshWindows,
  isScreenCapturePermissionError,
  prefetchWindows,
  refreshWindows,
  subscribeWindows,
} from "../lib/windowList";
import { formatDuration } from "../lib/format";
import { iconUrl } from "../lib/media";
import { localizeMessage, useI18n } from "../lib/i18n";
import { useNow } from "../hooks/useLive";
import { Menu, MenuHeading, MenuItem, MenuSeparator, useMenuAnchor } from "../components/Menu";
import { MediaImage } from "../components/MediaImage";
import { Keys } from "../components/ui/Keys";
import { windowPickerLabels } from "../windows/QuickMenuWindow";
import { acceleratorOf } from "../pages/ShortcutsPage";
import { errorText, useApp } from "./context";
import type { CapturableWindow } from "../types";

/** pending：还没有任何列表可给、正在读第一份；只有这种情况才（延迟）显示「正在读取窗口」。 */
type Picker = { permission: boolean; pending: boolean };

/**
 * 工具栏右边的「截取」「录制」：和快捷菜单走同一套后端命令（列窗口、截窗口、全屏、开始/停止录制），
 * 只是换成主窗口里的下拉菜单。录制中时「录制」变成红色的停止按钮，带时长。
 */
export function CaptureTools() {
  const { settings, caps, recording, onSaved, notify } = useApp();
  const { t } = useI18n();
  const captureMenu = useMenuAnchor();
  const recordMenu = useMenuAnchor();
  const [windows, setWindows] = useState<CapturableWindow[] | null>(cachedWindows);
  const [picker, setPicker] = useState<Picker>({ permission: false, pending: false });
  const [slowLoading, setSlowLoading] = useState(false);
  const now = useNow(recording.active);
  const recordingAvailable = !caps || caps.recording.available;

  // 列表一更新（包括快捷操作之外的任何一次重读）就换上新的；挂上时和主窗口每次获得焦点时提前读一次。
  useEffect(() => subscribeWindows(() => setWindows(cachedWindows())), []);
  useEffect(() => {
    prefetchWindows();
    const onFocus = () => prefetchWindows();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (!picker.pending) {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), WINDOW_LIST_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [picker.pending]);

  /** 有上一次的列表就先给它，后台重读；`force` 是用户点了「重新读取」或刚授权完。 */
  async function loadWindows(force = false) {
    const hadList = cachedWindows() !== null;
    setPicker({ permission: false, pending: !hadList });
    try {
      await (force ? refreshWindows() : ensureFreshWindows());
      setPicker({ permission: false, pending: false });
    } catch (error) {
      const permission = isScreenCapturePermissionError(error);
      setPicker({ permission, pending: false });
      // 后台重读失败时旧列表还在，选中时会再确认，不必弹错
      if (!permission && !hadList) notify(t(errorText(error)), "error");
    }
  }

  /** 选中的是旧列表里的项时，确认窗口还在再动手；不在了就提示并刷新列表。 */
  async function confirmed(item: CapturableWindow) {
    const target = await confirmWindow(item);
    if (!target) {
      notify(t("这个窗口已经关闭，请重新选择"), "error");
      prefetchWindows();
    }
    return target;
  }

  async function authorize() {
    try {
      if (await authorizeScreenCapture()) await loadWindows(true);
    } catch (error) {
      notify(t(errorText(error)), "error");
    }
  }

  function openMenu(menu: ReturnType<typeof useMenuAnchor>, other: ReturnType<typeof useMenuAnchor>, element: HTMLElement) {
    other.close();
    if (!menu.open) void loadWindows();
    menu.toggle(element);
  }

  async function capture(choice: CapturableWindow | "fullscreen") {
    captureMenu.close();
    const target = choice === "fullscreen" ? choice : await confirmed(choice);
    if (!target) return;
    const pending = target === "fullscreen" ? runAction("fullscreen") : runAction("capture", target.id);
    void pending.catch((error) => notify(t(errorText(error)), "error"));
  }

  async function record(choice: CapturableWindow) {
    recordMenu.close();
    const target = await confirmed(choice);
    if (!target) return;
    try {
      const next = await toggleRecording(target.id);
      const message = next.message?.trim();
      notify(message ? localizeMessage(message) : t("开始录制 {target}", { target: next.target ?? target.appName }));
    } catch (error) {
      notify(t(errorText(error)), "error");
    }
  }

  async function stop() {
    try {
      const next = await toggleRecording();
      notify(next.active ? t("录制还在继续") : t("录制已保存"));
    } catch (error) {
      notify(t(errorText(error)), "error");
    }
  }

  async function toggleAudio(key: "recordSystemAudio" | "recordMicrophone") {
    try {
      onSaved(await savePreferences({ [key]: !settings[key] }));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  const windowItems = (onPick: (item: CapturableWindow) => void) => (
    <>
      {picker.pending && slowLoading && <div className="mw-menu-note">{t("正在读取窗口…")}</div>}
      {picker.permission && (
        <>
          <div className="mw-menu-note" role="alert">{t("需要「屏幕录制」权限才能读取和截取窗口")}</div>
          <MenuItem onSelect={() => void authorize()}>{t("打开系统设置")}</MenuItem>
          <MenuItem onSelect={() => void loadWindows(true)}>{t("重新读取")}</MenuItem>
        </>
      )}
      {!picker.pending && !picker.permission && (windows ?? []).length === 0 && (
        <div className="mw-menu-note">{t("没有找到可用的窗口")}</div>
      )}
      {!picker.permission && windows?.map((item) => {
        const labels = windowPickerLabels(item);
        return (
          <MenuItem
            key={item.id}
            onSelect={() => onPick(item)}
            trailing={item.minimized ? t("已最小化") : undefined}
          >
            <span className="mw-window-item">
              <span className="mw-window-icon"><MediaImage src={iconUrl(item.pid, 16)} fallback={<span className="mw-window-blank" />} /></span>
              <span className="mw-window-name">{labels.name}</span>
              {labels.title && <span className="mw-window-title">{labels.title}</span>}
            </span>
          </MenuItem>
        );
      })}
    </>
  );

  const fullscreenKeys = acceleratorOf(settings, "fullscreen");
  // 指针移上去、按下、键盘聚焦时就开始读，点开时多半已经是新的了
  const prefetchHandlers = {
    onPointerEnter: () => prefetchWindows(),
    onPointerDown: () => prefetchWindows(),
    onFocus: () => prefetchWindows(),
  };

  return (
    <span className="mw-tools mw-capture-tools">
      <span className="mw-vsep" aria-hidden="true" />
      <button
        type="button"
        className="tb-btn"
        aria-haspopup="menu"
        aria-expanded={captureMenu.open}
        {...prefetchHandlers}
        onClick={(event) => openMenu(captureMenu, recordMenu, event.currentTarget)}
      >
        <ScanLine aria-hidden="true" />
        {t("截取")}
      </button>
      {recording.active ? (
        <button type="button" className="tb-btn is-recording" onClick={() => void stop()} aria-label={t("停止录制 · {target}", { target: recording.target ?? t("窗口") })}>
          <Square aria-hidden="true" />
          <span className="mono">{formatDuration(now - (recording.startedAt ?? now))}</span>
        </button>
      ) : (
        <button
          type="button"
          className="tb-btn"
          aria-haspopup="menu"
          aria-expanded={recordMenu.open}
          disabled={!recordingAvailable}
          title={recordingAvailable ? undefined : t("不可用")}
          {...prefetchHandlers}
          onClick={(event) => openMenu(recordMenu, captureMenu, event.currentTarget)}
        >
          <CircleDot aria-hidden="true" />
          {t("录屏")}
        </button>
      )}

      {captureMenu.open && (
        <Menu anchor={captureMenu.anchor} onClose={captureMenu.close} label={t("选择要截取的窗口")}>
          <MenuHeading>{t("选择要截取的窗口")}</MenuHeading>
          {windowItems((item) => void capture(item))}
          <MenuSeparator />
          <MenuItem onSelect={() => void capture("fullscreen")} trailing={fullscreenKeys ? <Keys value={fullscreenKeys} quiet /> : undefined}>
            {t("全屏截图")}
          </MenuItem>
        </Menu>
      )}
      {recordMenu.open && (
        <Menu anchor={recordMenu.anchor} onClose={recordMenu.close} label={t("选择要录制的窗口")}>
          <MenuHeading>{t("选择要录制的窗口")}</MenuHeading>
          {windowItems((item) => void record(item))}
          <MenuSeparator />
          <MenuItem
            checked={settings.recordSystemAudio}
            disabled={Boolean(caps && !caps.recordingSystemAudio.available && !settings.recordSystemAudio)}
            onSelect={() => void toggleAudio("recordSystemAudio")}
          >
            {t("同时录系统声音")}
          </MenuItem>
          <MenuItem
            checked={settings.recordMicrophone}
            disabled={Boolean(caps && !caps.recordingMicrophone.available && !settings.recordMicrophone)}
            onSelect={() => void toggleAudio("recordMicrophone")}
          >
            {t("同时录麦克风")}
          </MenuItem>
        </Menu>
      )}
    </span>
  );
}
