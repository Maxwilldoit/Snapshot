import { useEffect, useRef, useState } from "react";
import { CatShape } from "./ui/CatShape";
import { PetMedia, PetThumb } from "./PetMedia";
import { clearClipboardNow, keepClipboard, toggleRecording } from "../lib/backend";
import { petUrl } from "../lib/media";
import { formatDuration } from "../lib/format";
import { narrate } from "../lib/activity";
import { motionReduced, usePresence } from "../lib/motion";
import { errorText, useApp } from "../app/context";
import { useNow, usePetAnimation, useWindowVisible } from "../hooks/useLive";
import { useI18n } from "../lib/i18n";
import { clickableAnimations } from "../lib/petActions";

/** 播报只说最近发生的事，太久以前的不提 */
const FRESH_MS = 15 * 60_000;
const NOTICE_MS = 8_000;
/** Match the desktop pet: a clicked action stays for a few seconds before the live pose returns. */
const COMPANION_ACTION_MS = 3000;

/**
 * 住在侧栏底部的猫，和它说的一句话。
 * 取代了右下角的弹出提示：刚发生了什么、剪贴板多久后清、正在录什么，都由它来说。
 * 在「桌面伴侣」页它会离开侧栏——那一页的大舞台上已经有它了。
 */
export function Companion({ away = false, compact = false }: { away?: boolean; compact?: boolean }) {
  const { settings, notice, activity, clipboard, recording, conflicts, navigate, notify, dismissNotice } = useApp();
  const { t } = useI18n();
  // 窗口在屏幕上就一直动（失焦也动），这样和桌面上的桌宠始终是同一个动作
  const windowVisible = useWindowVisible();
  const petAnimation = usePetAnimation();
  const [hop, setHop] = useState(false);
  const [localEntry, setLocalEntry] = useState<string | null>(null);
  const lastSeen = useRef(activity[0]?.id);
  const actionTimer = useRef<number | undefined>(undefined);

  const asset = settings.petAssets.find((item) => item.id === settings.selectedAppearanceId && !item.missing);
  const clickable = clickableAnimations(asset);
  const liveEntry = asset && clickable.includes(asset.entry) ? asset.entry : clickable[0] ?? null;
  const sharedEntry = petAnimation && petAnimation.assetId === asset?.id && clickable.includes(petAnimation.entry ?? "")
    ? petAnimation.entry
    : liveEntry;
  const entry = localEntry && clickable.includes(localEntry) ? localEntry : sharedEntry;

  useEffect(() => () => window.clearTimeout(actionTimer.current), []);

  useEffect(() => {
    window.clearTimeout(actionTimer.current);
    setLocalEntry(null);
  }, [asset?.id]);

  function switchCompanionAction() {
    if (!asset || clickable.length < 2) return;
    const start = Math.max(0, clickable.indexOf(entry ?? liveEntry ?? ""));
    const next = clickable[(start + 1) % clickable.length];
    setLocalEntry(next);
    window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setLocalEntry(null), COMPANION_ACTION_MS);
  }

  // 有新活动时跳一下——全应用只有猫能弹
  useEffect(() => {
    const newest = activity[0]?.id;
    if (!newest || newest === lastSeen.current) return;
    lastSeen.current = newest;
    if (motionReduced()) return;
    setHop(true);
    const timer = window.setTimeout(() => setHop(false), 420);
    return () => window.clearTimeout(timer);
  }, [activity]);

  const ticking = recording.active || Boolean(clipboard?.clearAt) || Boolean(notice);
  const now = useNow(ticking);

  const say = (() => {
    if (notice && now - notice.at < NOTICE_MS) {
      return { key: `n${notice.id}`, tone: notice.kind, body: <>{notice.text}</>, action: null };
    }
    if (recording.active) {
      return {
        key: "rec",
        tone: "rec" as const,
        body: (
          <>
            {t("正在录 {target}", { target: recording.target ?? t("窗口") })}
            <span className="mono"> {formatDuration(now - (recording.startedAt ?? now))}</span>
          </>
        ),
        action: (
          <button
            type="button"
            className="link"
            onClick={() => toggleRecording().catch((error) => notify(errorText(error), "error"))}
          >
            {t("停止录制")}
          </button>
        ),
      };
    }
    if (clipboard?.clearAt) {
      const left = Math.max(0, Math.ceil((clipboard.clearAt - now) / 1000));
      const total = Math.max(1, clipboard.clearAt - clipboard.armedAt);
      const ratio = Math.max(0, Math.min(1, (clipboard.clearAt - now) / total));
      return {
        key: `clip${clipboard.armedAt}`,
        tone: "info" as const,
        body: (
          <>
            {t("{label}在剪贴板里，{seconds} 秒后清空。", { label: clipboard.label, seconds: left })}
            <span className="drain" aria-hidden="true"><span style={{ width: `${ratio * 100}%` }} /></span>
          </>
        ),
        action: (
          <span className="companion-actions">
            <button type="button" className="link" onClick={() => void clearClipboardNow()}>{t("现在清空")}</button>
            <button type="button" className="link" onClick={() => void keepClipboard()}>{t("这次别清")}</button>
          </span>
        ),
      };
    }
    const latest = activity[0];
    if (latest && now - latest.at < FRESH_MS) {
      return {
        key: latest.id,
        tone: latest.kind === "error" ? ("error" as const) : ("info" as const),
        body: <>{narrate(latest)}</>,
        action: null,
      };
    }
    if (conflicts.length > 0) {
      return {
        key: "conflicts",
        tone: "error" as const,
        body: <>{t(conflicts.length === 1
          ? "有 1 组快捷键没注册上，按了不会有反应。"
          : "有 {count} 组快捷键没注册上，按了不会有反应。", { count: conflicts.length })}</>,
        action: (
          <button type="button" className="link" onClick={() => navigate("shortcuts")}>{t("去看看")}</button>
        ),
      };
    }
    return null;
  })();

  // 说完的话往下沉一点淡掉，不是啪一下没了
  const { item: shown, leaving } = usePresence(say);

  const animate = windowVisible && !motionReduced();
  // 默认跟着桌宠；点击这里只在应用内切动作，不广播，也不改变桌面上的宠物。
  const animatePet = Boolean(asset && (animate || localEntry));

  return (
    <div className={`companion ${away ? "is-away" : ""} ${compact ? "is-compact" : ""}`}>
      {shown && (
        <div key={shown.key} className={`companion-say tone-${shown.tone} ${leaving ? "is-leaving" : ""}`} role="status" aria-live="polite">
          <span>{shown.body}</span>
          {shown.action}
          {notice && shown.key === `n${notice.id}` && notice.kind === "error" && (
            <button type="button" className="companion-dismiss" aria-label={t("知道了")} onClick={dismissNotice}>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M.5.5l7 7M7.5.5l-7 7" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={`companion-cat ${hop ? "is-hop" : ""}`}
        aria-label={asset ? t("{name}，切换动作", { name: asset.name }) : t("还没有伴侣，去导入一只")}
        onClick={() => asset ? switchCompanionAction() : navigate("pet")}
      >
        {asset ? (
          animatePet ? (
            <PetMedia key={`${asset.id}/${entry}`} src={petUrl(asset.id, entry)} entry={entry} playing={animatePet} />
          ) : (
            <PetThumb assetId={asset.id} entry={asset.entry} fallback={<CatShape height={64} outline />} />
          )
        ) : (
          <span className="companion-empty">
            <CatShape height={64} outline />
            <span>{t("还没有伴侣")}</span>
          </span>
        )}
      </button>
      {/* 地面线只留给时间线布局的紧凑版；伴侣侧栏里不画 */}
      {compact && <div className="companion-floor" aria-hidden="true" />}
    </div>
  );
}
