import { useState } from "react";
import { CircleDot, ScanLine, Square } from "lucide-react";
import { authorizeScreenCapture, listWindows, runAction, savePreferences, toggleRecording } from "../lib/backend";
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

type Picker = { windows: CapturableWindow[] | null; permission: boolean; loading: boolean };

const needsPermission = (error: unknown) =>
  typeof error === "object" && error !== null && "kind" in error && (error as { kind?: unknown }).kind === "screenCapturePermission";

/**
 * 工具栏右边的「截取」「录制」：和快捷菜单走同一套后端命令（列窗口、截窗口、全屏、开始/停止录制），
 * 只是换成主窗口里的下拉菜单。录制中时「录制」变成红色的停止按钮，带时长。
 */
export function CaptureTools() {
  const { settings, caps, recording, onSaved, notify } = useApp();
  const { t } = useI18n();
  const captureMenu = useMenuAnchor();
  const recordMenu = useMenuAnchor();
  const [picker, setPicker] = useState<Picker>({ windows: null, permission: false, loading: false });
  const now = useNow(recording.active);
  const recordingAvailable = !caps || caps.recording.available;

  async function loadWindows() {
    setPicker({ windows: null, permission: false, loading: true });
    try {
      const list = await listWindows();
      setPicker({ windows: Array.isArray(list) ? list : [], permission: false, loading: false });
    } catch (error) {
      const permission = needsPermission(error);
      setPicker({ windows: [], permission, loading: false });
      if (!permission) notify(t(errorText(error)), "error");
    }
  }

  async function authorize() {
    try {
      if (await authorizeScreenCapture()) await loadWindows();
    } catch (error) {
      notify(t(errorText(error)), "error");
    }
  }

  function openMenu(menu: ReturnType<typeof useMenuAnchor>, other: ReturnType<typeof useMenuAnchor>, element: HTMLElement) {
    other.close();
    if (!menu.open) void loadWindows();
    menu.toggle(element);
  }

  function capture(target: CapturableWindow | "fullscreen") {
    captureMenu.close();
    const pending = target === "fullscreen" ? runAction("fullscreen") : runAction("capture", target.id);
    void pending.catch((error) => notify(t(errorText(error)), "error"));
  }

  async function record(target: CapturableWindow) {
    recordMenu.close();
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
      {picker.loading && <div className="mw-menu-note">{t("正在读取窗口…")}</div>}
      {picker.permission && (
        <>
          <div className="mw-menu-note" role="alert">{t("需要「屏幕录制」权限才能读取和截取窗口")}</div>
          <MenuItem onSelect={() => void authorize()}>{t("打开系统设置")}</MenuItem>
          <MenuItem onSelect={() => void loadWindows()}>{t("重新读取")}</MenuItem>
        </>
      )}
      {!picker.loading && !picker.permission && picker.windows?.length === 0 && (
        <div className="mw-menu-note">{t("没有找到可用的窗口")}</div>
      )}
      {picker.windows?.map((item) => {
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

  return (
    <span className="mw-tools mw-capture-tools">
      <span className="mw-vsep" aria-hidden="true" />
      <button
        type="button"
        className="tb-btn"
        aria-haspopup="menu"
        aria-expanded={captureMenu.open}
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
          onClick={(event) => openMenu(recordMenu, captureMenu, event.currentTarget)}
        >
          <CircleDot aria-hidden="true" />
          {t("录屏")}
        </button>
      )}

      {captureMenu.open && (
        <Menu anchor={captureMenu.anchor} onClose={captureMenu.close} label={t("选择要截取的窗口")}>
          <MenuHeading>{t("选择要截取的窗口")}</MenuHeading>
          {windowItems(capture)}
          <MenuSeparator />
          <MenuItem onSelect={() => capture("fullscreen")} trailing={fullscreenKeys ? <Keys value={fullscreenKeys} quiet /> : undefined}>
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
