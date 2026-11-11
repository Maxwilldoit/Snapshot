import React, { useEffect, useRef, useState } from "react";
import { saveShortcuts, setShortcutsPaused } from "../lib/backend";
import { normalizeKey } from "../lib/format";
import { Keys } from "../components/ui/Keys";
import { Switch } from "../components/ui/Switch";
import { errorText, useApp } from "../app/context";
import { Toolbar } from "../app/Shell";
import { useI18n } from "../lib/i18n";
import type { ShortcutAction, ShortcutBinding } from "../types";

const ACTION_LABELS: Record<ShortcutAction, { name: string }> = {
  snapshot: { name: "窗口截图" },
  fullscreen: { name: "全屏截图" },
  scrolling: { name: "长截图" },
  record: { name: "录屏" },
  polish: { name: "润色 Prompt" },
  prompts: { name: "打开 Prompt 库" },
  palette: { name: "呼出快捷菜单" },
};

/** 两组：截图录制一组，Prompt 一组。没列进来的动作（老设置里多出来的）放到第一组末尾 */
const GROUPS: Array<{ title: string; actions: ShortcutAction[] }> = [
  { title: "截图与录制", actions: ["snapshot", "fullscreen", "scrolling", "record"] },
  { title: "Prompt", actions: ["polish", "prompts", "palette"] },
];

const MODIFIERS = ["Control", "Shift", "Alt", "Meta"];

function pressedModifiers(event: React.KeyboardEvent): string[] {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  return parts;
}

/** 修饰键改变字符，但 event.code 仍是物理键位；用它避免 Shift+2 被记成 @。 */
function shortcutKey(event: React.KeyboardEvent): string {
  const code = event.code;
  if (code && code !== "Unidentified") {
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1];
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1];
    return code;
  }
  return normalizeKey(event.key);
}

/** 改动直接交后端校验、注册和落盘；失败恢复旧绑定。 */
function ShortcutsPanel() {
  const { settings, onSaved, notify, conflicts, setConflicts, caps } = useApp();
  const { t } = useI18n();
  const [shortcuts, setShortcuts] = useState(settings.shortcuts);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  const [rejected, setRejected] = useState<{ action: ShortcutAction; key: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const previousSavedShortcuts = useRef(settings.shortcuts);
  const shortcutsPaused = settings.shortcutsPaused ?? false;

  useEffect(() => {
    const previous = previousSavedShortcuts.current;
    previousSavedShortcuts.current = settings.shortcuts;
    // 暂停开关、托盘会返回整份设置；绑定没变时保留本页尚未保存的编辑。
    if (
      previous.length !== settings.shortcuts.length ||
      settings.shortcuts.some((item, index) =>
        item.action !== previous[index].action || item.accelerator !== previous[index].accelerator,
      )
    ) setShortcuts(settings.shortcuts);
  }, [settings.shortcuts]);

  function stopRecording() {
    setRecording(null);
    setHeld([]);
  }

  function onRowKeyDown(action: ShortcutAction, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (recording !== action) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setRecording(action);
        setRejected(null);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const modifiers = pressedModifiers(event);
    if (MODIFIERS.includes(event.key)) {
      setHeld(modifiers);
      return;
    }
    const key = shortcutKey(event);
    if (modifiers.length === 0) {
      // 原先这里是静默 return，用户按了没反应还以为坏了
      setRejected({ action, key });
      return;
    }
    const accelerator = [...modifiers, key].join("+");
    changeBinding(action, accelerator);
    setRejected(null);
    stopRecording();
  }

  function onRowKeyUp(action: ShortcutAction, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (recording === action) setHeld(pressedModifiers(event));
  }

  async function persist(next: ShortcutBinding[]) {
    if (savingRef.current) return;
    savingRef.current = true;
    const previous = shortcuts;
    setShortcuts(next);
    setSaving(true);
    try {
      const saved = await saveShortcuts(next);
      onSaved(saved);
      setConflicts([]);

    } catch (error) {
      setShortcuts(previous);
      notify(errorText(error), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function changeBinding(action: ShortcutAction, accelerator: string | null) {
    if (savingRef.current) return;
    const next = shortcuts.map((item) => (item.action === action ? { ...item, accelerator } : item));
    void persist(next);
  }

  async function togglePause(paused: boolean) {
    setTogglingPause(true);
    try {
      const next = await setShortcutsPaused(paused);
      onSaved(next);
      setConflicts([]);
      notify(next.shortcutsPaused ? t("全局快捷键已暂停，按键已释放") : t("全局快捷键已恢复"));
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setTogglingPause(false);
    }
  }

  const renderRow = (binding: ShortcutBinding) => {
    const label = ACTION_LABELS[binding.action] ?? { name: binding.action };
    const labelName = t(label.name);
    const isRecording = recording === binding.action;
    const saved = settings.shortcuts.find((item) => item.action === binding.action)?.accelerator ?? null;
    const conflicted = Boolean(binding.accelerator && binding.accelerator === saved && conflicts.includes(binding.accelerator));
    const unavailable = binding.action === "record" && caps && !caps.recording.available;
    const rejection = rejected?.action === binding.action ? rejected.key : null;
    const locked = saving || shortcutsPaused;
    return (
      <div key={binding.action} className={`row shortcut-row ${isRecording ? "is-recording" : ""}`}>
        <span className="shortcut-text">
          <span className="row-label">{labelName}</span>
          {conflicted && <span className="signal small">{t("没注册上，这组键已被其他程序占用")}</span>}
          {unavailable && !conflicted && <span className="quiet small">{t("不可用")}</span>}
          {rejection && (
            <span className="signal small">
              {t("只按了 {rejection}。至少要带上 Ctrl、Alt、Shift 中的一个", { rejection })}
            </span>
          )}
        </span>
        <span className={`key-field-wrap ${binding.accelerator && !isRecording ? "has-value" : ""}`}>
          <button
            type="button"
            className={`key-field ${isRecording ? "is-recording" : ""} ${binding.accelerator ? "" : "is-empty"}`}
            aria-label={t("快捷键：{name}，当前按键：{keys}", {
              name: labelName,
              keys: binding.accelerator || t("未设置"),
            })}
            aria-pressed={isRecording}
            disabled={locked}
            onClick={() => {
              // 点框开始录，再点一次（或 Esc、点别处）取消
              setRejected(null);
              if (isRecording) stopRecording();
              else setRecording(binding.action);
            }}
            onKeyDown={(event) => onRowKeyDown(binding.action, event)}
            onKeyUp={(event) => onRowKeyUp(binding.action, event)}
            onBlur={() => isRecording && stopRecording()}
          >
            {isRecording ? (
              held.length > 0 ? <Keys value={held.join("+")} /> : <span className="key-field-hint">{t("按下快捷键…")}</span>
            ) : binding.accelerator ? (
              <Keys value={binding.accelerator} struck={conflicted} />
            ) : (
              <span className="key-field-hint" aria-hidden="true">—</span>
            )}
          </button>
          {!isRecording && binding.accelerator && (
            <button
              type="button"
              className="key-field-clear"
              aria-label={t("清除「{name}」的快捷键", { name: labelName })}
              title={t("清除")}
              disabled={locked}
              onClick={() => changeBinding(binding.action, null)}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            </button>
          )}
        </span>
      </div>
    );
  };

  const listed = new Set(GROUPS.flatMap((group) => group.actions));
  const groups = GROUPS.map((group, index) => ({
    title: group.title,
    rows: [
      ...group.actions.flatMap((action) => shortcuts.filter((item) => item.action === action)),
      ...(index === 0 ? shortcuts.filter((item) => !listed.has(item.action)) : []),
    ],
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="shortcuts-panel">
      <section className="panel panel-shortcuts-toggle">
        <div className="rows">
          <div className="row">
            <label htmlFor="switch-shortcuts-enabled" className="row-label">{t("启用全局快捷键")}</label>
            <Switch
              id="switch-shortcuts-enabled"
              label={t("启用全局快捷键")}
              value={!shortcutsPaused}
              disabled={togglingPause || saving}
              onChange={(enabled) => void togglePause(!enabled)}
            />
          </div>
        </div>

      </section>
      {groups.map((group) => (
        <section key={group.title} className={`panel panel-shortcuts ${shortcutsPaused ? "is-off" : ""}`} aria-disabled={shortcutsPaused || undefined}>
          <h2 className="panel-title">{t(group.title)}</h2>
          <div className="rows">{group.rows.map(renderRow)}</div>
        </section>
      ))}
    </div>
  );
}

export function ShortcutsPage() {
  const { t } = useI18n();
  return (
    <div className="mw-page">
      <Toolbar title={t("快捷键")} />
      <div className="mw-scroll pane">
        <div className="form form-narrow">
          <ShortcutsPanel />
        </div>
      </div>
    </div>
  );
}

