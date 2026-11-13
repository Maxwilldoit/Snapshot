import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { CatShape } from "../components/ui/CatShape";
import { PetMedia } from "../components/PetMedia";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { deletePetAsset, showPetCatalog } from "../lib/backend";
import { petUrl } from "../lib/media";
import { commonPrefix, entryLabel } from "../lib/petNames";
import { stagger } from "../lib/motion";
import { errorText, useApp } from "../app/context";
import { Toolbar } from "../app/Shell";
import { usePetImport } from "../app/usePetImport";
import { Menu, MenuItem, MenuSeparator, useMenuAnchor } from "../components/Menu";
import { PetSettings } from "../components/PetSettings";
import { useI18n } from "../lib/i18n";
import { ensurePetAutoScale } from "../lib/petScale";

/**
 * 桌面伴侣：侧栏里点哪一只就看哪一只。左边是大舞台和桌面设置，右边是它的动作（点一下预览），两栏独立滚动。
 * 换桌面上那只、或把它收起来，都由侧栏名字左边的圆点负责；看一看不会动桌面。
 */
export function PetPage() {
  const { settings, onSaved, notify, navigate, viewedPetId } = useApp();
  const { t } = useI18n();
  const { importPaths } = usePetImport();
  const [activeEntry, setActiveEntry] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [armedRemove, setArmedRemove] = useState(false);
  const more = useMenuAnchor();
  const importRef = useRef(importPaths);
  importRef.current = importPaths;

  const selectedId = settings.selectedAppearanceId;
  const requested = viewedPetId ?? selectedId;
  const viewedId = requested === "app-icon" || settings.petAssets.some((item) => item.id === requested) ? requested : selectedId;
  const asset = settings.petAssets.find((item) => item.id === viewedId) ?? null;
  const prefix = useMemo(() => commonPrefix(asset?.animations ?? []), [asset?.animations]);

  useEffect(() => {
    let active = true;
    void (async () => {
      // 每次只解码一份待机素材；导入多只或升级旧素材时不同时启动大量视频。
      for (const item of settings.petAssets) {
        if (!active) break;
        await ensurePetAutoScale(item);
      }
    })();
    return () => { active = false; };
  }, [settings.petAssets]);

  useEffect(() => {
    setActiveEntry(asset?.entry || asset?.animations[0] || null);
    setArmedRemove(false);
  }, [viewedId, asset?.entry, asset?.animations]);

  // 直接把 ZIP / GIF / WebM 拖进窗口
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "over" || payload.type === "enter") setDropping(true);
          else if (payload.type === "leave") setDropping(false);
          else if (payload.type === "drop") {
            setDropping(false);
            void importRef.current(payload.paths);
          }
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // 浏览器预览与测试环境里没有拖放事件
    }
    return () => unlisten?.();
  }, []);

  async function remove() {
    if (!asset) return;
    more.close();
    try {
      const next = await deletePetAsset(asset.id);
      onSaved(next);
      navigate("pet", { petId: next.selectedAppearanceId });
      notify(t("移除了「{name}」", { name: asset.name }));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  function armRemove() {
    if (armedRemove) {
      void remove();
      return;
    }
    setArmedRemove(true);
    window.setTimeout(() => setArmedRemove(false), 2400);
  }

  function openCatalog() {
    more.close();
    void showPetCatalog().catch((error) => notify(t("打开素材库失败：{detail}", { detail: errorText(error) }), "error"));
  }

  const name = asset ? asset.name : t("前台应用图标");
  const stageSrc = asset && !asset.missing ? petUrl(asset.id, activeEntry) : null;

  return (
    <div className={`mw-page pet-page ${dropping ? "is-dropping" : ""}`}>
      <Toolbar title={name}>
        <button
          type="button"
          className="tb-btn"
          aria-label={t("更多")}
          aria-haspopup="menu"
          aria-expanded={more.open}
          onClick={(event) => more.toggle(event.currentTarget)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </Toolbar>
      {more.open && (
        <Menu anchor={more.anchor} onClose={more.close} label={t("更多")}>
          <MenuItem onSelect={openCatalog}>{t("浏览素材库…")}</MenuItem>
          {asset && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={armRemove}>{armedRemove ? t("再点一次就移除") : t("移除这只")}</MenuItem>
            </>
          )}
        </Menu>
      )}

      <div className="pet-page-body">
        <div className={`pet-grid ${asset?.animations.length ? "" : "is-single"}`}>
          <section className="pet-column pet-main-pane" aria-label={t("当前伴侣")} tabIndex={0}>
            <div className="pet-stage">
              {stageSrc ? (
                <PetMedia
                  key={stageSrc}
                  className="pet-stage-image"
                  src={stageSrc}
                  entry={activeEntry}
                  alt={name}
                  fallback={<CatShape height={150} outline />}
                />
              ) : asset ? (
                <CatShape height={150} outline />
              ) : (
                <span className="app-glyph app-glyph-large" aria-hidden="true"><span /></span>
              )}
              {dropping && <div className="shelf-drop">{t("松手导入")}</div>}
            </div>
            {asset?.missing && (
              <div className="group">
                <div className="row">
                  <span className="row-label signal">{t("原文件丢了")}</span>
                  <button type="button" className="link" onClick={() => void remove()}>{t("移除")}</button>
                </div>
              </div>
            )}
            <PetSettings assetId={asset?.id ?? "app-icon"} />
          </section>

          {asset && asset.animations.length > 0 && (
            <section className="pet-column pet-actions-pane" aria-labelledby="pet-actions-title" tabIndex={0}>
              <h2 id="pet-actions-title" className="group-title">{t("动作")}</h2>
              <div className="group pet-actions-grid" role="radiogroup" aria-label={t("预览动作")}>
                {asset.animations.map((entry, index) => (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={activeEntry === entry}
                    className={`pet-action ${activeEntry === entry ? "is-on" : ""}`}
                    style={stagger(index)}
                    onClick={() => setActiveEntry(entry)}
                  >
                    <span>{entryLabel(entry, prefix, t)}</span>
                    <svg className="pet-action-play" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5v7l6-3.5z" fill="currentColor" /></svg>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
