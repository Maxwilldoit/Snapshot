import type { ReactNode } from "react";
import { formatClock } from "../lib/format";
import { shortLabel } from "../lib/activity";
import { usePresence } from "../lib/motion";
import { useApp } from "./context";
import { WindowTitleBar } from "../components/WindowTitleBar";
import type { NavPage } from "../types";
import { useI18n } from "../lib/i18n";

export function TitleBar({ children, right, tall = false }: { children?: ReactNode; right?: ReactNode; tall?: boolean }) {
  const { notify } = useApp();
  return (
    <WindowTitleBar right={right} tall={tall} onError={(message) => notify(message, "error")}>
      {children}
    </WindowTitleBar>
  );
}

type NavItem = { page: NavPage; label: string; trailing?: ReactNode };

function useNavItems(): { work: NavItem[]; settings: NavItem[] } {
  const { conflicts } = useApp();
  const { t } = useI18n();
  return {
    work: [
      {
        page: "shortcuts",
        label: t("快捷操作"),
        trailing: conflicts.length ? <span className="signal small" aria-label={t("{count} 个冲突", { count: conflicts.length })}>{conflicts.length}</span> : null,
      },
      { page: "history", label: t("历史记录") },
      { page: "pet", label: t("桌面伴侣") },
    ],
    settings: [
      { page: "prefs", label: t("偏好设置") },
      { page: "themes", label: t("主题库") },
    ],
  };
}

/** 当前页字下那道墨线。换页时它会从旧的一项滑到新的一项（view-transition-name: nav-mark） */
export const NavMark = () => <span className="nav-mark" aria-hidden="true" />;

/** 侧栏导航：只有字。当前页墨色加粗、字下一道线，其余灰字——不加底色 */
export function SideNav() {
  const { page, navigate } = useApp();
  const { t } = useI18n();
  const { work, settings } = useNavItems();
  const item = (entry: NavItem) => (
    <button
      key={entry.page}
      type="button"
      className={`nav-item ${page === entry.page ? "is-on" : ""}`}
      aria-current={page === entry.page ? "page" : undefined}
      onClick={() => navigate(entry.page)}
    >
      <span className="nav-label">
        {entry.label}
        {page === entry.page && <NavMark />}
      </span>
      {entry.trailing}
    </button>
  );
  return (
    <nav className="side-nav" aria-label={t("主导航")}>
      <div className="nav-group">{work.map(item)}</div>
      <div className="nav-group">{settings.map(item)}</div>
    </nav>
  );
}

/** 「不要侧栏」：入口放进标题栏 */
export function TopNav() {
  const { page, navigate } = useApp();
  const { t } = useI18n();
  const { work, settings } = useNavItems();
  return (
    <>
      <span className="titlebar-name strong" data-tauri-drag-region>{t("应用快照")}</span>
      <nav className="top-nav" aria-label={t("主导航")}>
        {work.map((entry) => (
          <button
            key={entry.page}
            type="button"
            className={`top-item ${page === entry.page ? "is-on" : ""}`}
            aria-current={page === entry.page ? "page" : undefined}
            onClick={() => navigate(entry.page)}
          >
            {entry.label}
            {entry.trailing}
            {page === entry.page && <NavMark />}
          </button>
        ))}
      </nav>
      <span className="titlebar-fill" data-tauri-drag-region />
      <nav className="top-nav top-nav-right" aria-label={t("设置导航")}>
        {settings.map((entry) => (
          <button
            key={entry.page}
            type="button"
            className={`top-item small ${page === entry.page ? "is-on" : ""}`}
            aria-current={page === entry.page ? "page" : undefined}
            onClick={() => navigate(entry.page)}
          >
            {entry.label}
            {page === entry.page && <NavMark />}
          </button>
        ))}
      </nav>
    </>
  );
}

/** 「今日流水」：侧栏下半截列出今天的每一步，点截图直接放大 */
export function LedgerList() {
  const { activity, navigate } = useApp();
  const { t } = useI18n();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const entries = activity.filter((entry) => entry.at >= today.getTime());
  return (
    <section className="ledger" aria-label={t("今天做过的事")}>
      <h2 className="ledger-title">{t("今天")}</h2>
      {entries.length === 0 ? (
        <p className="small quiet ledger-empty">{t("今天还没截过、录过、润色过。")}</p>
      ) : (
        <ol className="ledger-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`ledger-item ${entry.kind === "error" ? "is-error" : ""}`}
                onClick={() => {
                  if (entry.kind === "capture" && entry.snapshotId) navigate("history", { previewId: entry.snapshotId });
                  else if (entry.kind === "polish") navigate("history");
                else if (entry.kind === "error" && (entry.title.includes("快捷键") || entry.title.includes("Shortcut"))) navigate("shortcuts");
                }}
                title={entry.detail ?? entry.title}
              >
                <span className="mono quiet">{formatClock(entry.at)}</span>
                <span className="ledger-text">{shortLabel(entry)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** 没有猫的地方，一句话提示浮在左下角：普通的自己消失，出错的留着等你关 */
export function NoticeLine() {
  const { notice: live, dismissNotice } = useApp();
  const { t } = useI18n();
  // 到时间或点了关闭：往下沉一点淡出，而不是啪一下没了
  const { item: notice, leaving } = usePresence(live);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      className={`notice-line ${notice.kind === "error" ? "is-error" : ""} ${leaving ? "is-leaving" : ""}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <span>{notice.text}</span>
      {notice.kind === "error" && (
        <button type="button" aria-label={t("关闭提示")} onClick={dismissNotice}>
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M.5.5l7 7M7.5.5l-7 7" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      )}
    </div>
  );
}
