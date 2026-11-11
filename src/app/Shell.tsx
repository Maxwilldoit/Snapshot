import { useMemo, type ReactNode } from "react";
import { Check, Images, Keyboard, MessageSquareText, Plus, Settings2, SlidersHorizontal } from "lucide-react";
import { usePresence } from "../lib/motion";
import { useApp } from "./context";
import { WindowControls } from "../components/WindowTitleBar";
import { PetThumb } from "../components/PetMedia";
import { CatShape } from "../components/ui/CatShape";
import { CaptureTools } from "./CaptureTools";
import { usePetImport } from "./usePetImport";
import type { NavPage, PetAsset, PlatformCapabilities } from "../types";
import { useI18n } from "../lib/i18n";

/** 没有系统标题栏：macOS 上画成侧栏左上角的红黄绿，其余平台是工具栏最右边的三个按钮 */
function isMacWindow(caps: PlatformCapabilities | null) {
  if (caps?.os) return caps.os === "macos";
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
}

/** 窗口按钮放在哪儿由平台决定：调用方只说「我是侧栏顶上」还是「我是工具栏末尾」 */
export function WindowChrome({ placement }: { placement: "sidebar" | "toolbar" }) {
  const { caps, notify } = useApp();
  const { t } = useI18n();
  const mac = isMacWindow(caps);
  if (placement === "sidebar") {
    return (
      <div className="mw-side-top" data-tauri-drag-region>
        {mac ? <WindowControls variant="mac" onError={(message) => notify(message, "error")} /> : (
          <span className="mw-app-name" data-tauri-drag-region>{t("应用快照")}</span>
        )}
      </div>
    );
  }
  return mac ? null : <WindowControls onError={(message) => notify(message, "error")} />;
}

/**
 * 每页顶上那一条：标题和本页操作；截图、录屏固定在侧栏。
 * 整条可以拖动窗口；按钮本身不拖。
 */
export function Toolbar({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mw-toolbar" data-tauri-drag-region>
      {lead}
      <h1 className="mw-title" data-tauri-drag-region>{title}</h1>
      <span className="mw-fill" data-tauri-drag-region />
      {children && <span className="mw-tools">{children}</span>}
      <WindowChrome placement="toolbar" />
    </header>
  );
}

type NavItem = { page: NavPage; label: string; icon: ReactNode; trailing?: ReactNode };

export function CaptureActions() {
  return <div className="mw-global-actions"><CaptureTools /></div>;
}

/** 侧栏里伴侣的顺序：后导入的在前；导入时间一样就照原顺序。前台应用图标总在最后 */
function sortedPets(assets: PetAsset[]) {
  return [...assets].sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0));
}

export function SideNav() {
  const { page, navigate, conflicts, settings, viewedPetId } = useApp();
  const { t } = useI18n();
  const { importing, pickFiles } = usePetImport();
  const pets = useMemo(() => sortedPets(settings.petAssets), [settings.petAssets]);
  const viewing = viewedPetId ?? settings.selectedAppearanceId;

  const library: NavItem[] = [
    { page: "history", label: t("截图记录"), icon: <Images aria-hidden="true" /> },
    { page: "prompts", label: t("Prompt 记录"), icon: <MessageSquareText aria-hidden="true" /> },
  ];
  const prefs: NavItem[] = [
    { page: "capture", label: t("截图与录制"), icon: <SlidersHorizontal aria-hidden="true" /> },
    {
      page: "shortcuts",
      label: t("快捷键"),
      icon: <Keyboard aria-hidden="true" />,
      trailing: conflicts.length ? <span className="mw-nav-badge" aria-label={t("{count} 个冲突", { count: conflicts.length })}>{conflicts.length}</span> : null,
    },
    { page: "general", label: t("通用"), icon: <Settings2 aria-hidden="true" /> },
  ];

  const item = (entry: NavItem) => (
    <button
      key={entry.page}
      type="button"
      className={`nav-item ${page === entry.page ? "is-on" : ""}`}
      aria-current={page === entry.page ? "page" : undefined}
      onClick={() => navigate(entry.page)}
    >
      {entry.icon}
      <span className="nav-label">{entry.label}</span>
      {entry.trailing}
    </button>
  );

  const petRow = (asset: PetAsset | null) => {
    const id = asset?.id ?? "app-icon";
    const name = asset ? asset.name : t("前台应用图标");
    const current = page === "pet" && viewing === id;
    const onDesk = settings.selectedAppearanceId === id;
    return (
      <button
        key={id}
        type="button"
        data-pet-id={id}
        className={`nav-item nav-pet ${current ? "is-on" : ""} ${asset?.missing ? "is-broken" : ""}`}
        aria-current={current ? "page" : undefined}
        title={name}
        onClick={() => navigate("pet", { petId: id })}
      >
        <span className="nav-avatar" aria-hidden="true">
          {!asset ? <span className="app-glyph"><span /></span>
            : asset.missing ? <CatShape height={16} outline />
            : <PetThumb assetId={asset.id} entry={asset.entry} fallback={<CatShape height={16} outline />} />}
        </span>
        <span className="nav-label">{name}</span>
        {onDesk && <Check className="nav-check" aria-label={t("在桌面上")} />}
      </button>
    );
  };

  return (
    <nav className="side-nav" aria-label={t("主导航")}>
      <div className="nav-group">
        <h2 className="nav-heading">{t("资料库")}</h2>
        {library.map(item)}
      </div>
      <div className="nav-group">
        <h2 className="nav-heading">{t("设置")}</h2>
        {prefs.map(item)}
      </div>
      <div className="nav-group" role="group" aria-label={t("桌面伴侣")}>
        <h2 className="nav-heading">
          {t("桌面伴侣")}
          <button type="button" className="nav-add" aria-label={t("导入伴侣素材…")} title={t("导入伴侣素材…")} disabled={importing} onClick={() => void pickFiles()}>
            <Plus aria-hidden="true" />
          </button>
        </h2>
        {petRow(null)}
        {pets.map(petRow)}
      </div>
    </nav>
  );
}

/** 一句话提示浮在窗口底部正中：普通的自己消失，出错的留着等你关 */
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
