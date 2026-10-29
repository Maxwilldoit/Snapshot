import { useEffect, useMemo, useRef, useState } from "react";
import { CatShape } from "../components/ui/CatShape";
import { PetMedia, PetThumb } from "../components/PetMedia";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { addPetAssets, deletePetAsset, renamePetAsset, selectPetAppearance, showPetCatalog } from "../lib/backend";
import { petUrl } from "../lib/media";
import { fileNameOf, formatBytes } from "../lib/format";
import { commonPrefix, entryLabel } from "../lib/petNames";
import { flyImage, stagger, useFlip, useSlidingMark } from "../lib/motion";
import { errorText, useApp } from "../app/context";
import { useI18n } from "../lib/i18n";
import type { PetAsset } from "../types";

const ACCEPTED = /\.(zip|gif|webm)$/i;
/** 舞台上的伴侣最高多少像素（和 .pet-stage-image 的 max-height 一致） */
const STAGE_MAX_HEIGHT = 232;

/** 形象架上的一格：静态第一帧站在一条线上，名字在线下 */
function ShelfItem({
  asset,
  selected,
  onChoose,
  onRemove,
  index,
}: {
  asset: PetAsset | null;
  selected: boolean;
  onChoose: () => void;
  onRemove?: () => void;
  index: number;
}) {
  const { t } = useI18n();
  const broken = Boolean(asset?.missing);
  const name = asset ? asset.name : t("前台应用图标");
  return (
    <div
      className={`shelf-item ${selected ? "is-selected" : ""} ${broken ? "is-broken" : ""}`}
      data-flip-key={asset?.id ?? "app-icon"}
      style={stagger(index)}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={broken || undefined}
        className="shelf-button"
        title={asset?.source ? `${name}\n${asset.source}` : name}
        onClick={() => !broken && onChoose()}
      >
        <span className="shelf-figure">
          {!asset ? (
            <span className="app-glyph" aria-hidden="true"><span /></span>
          ) : broken ? (
            <CatShape height={46} outline />
          ) : (
            <PetThumb assetId={asset.id} entry={asset.entry} fallback={<CatShape height={46} outline />} />
          )}
        </span>
        <span className="shelf-name">{name}</span>
      </button>
      {broken && (
        <span className="shelf-broken small">
          {t("原文件丢了")}{" "}
          {onRemove && <button type="button" className="link" onClick={onRemove}>{t("移除")}</button>}
        </span>
      )}
    </div>
  );
}

export function PetPage() {
  const { settings, onSaved, notify } = useApp();
  const { t } = useI18n();
  const [activeEntry, setActiveEntry] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<Array<{ path: string; reason: string }>>([]);
  const [dropping, setDropping] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armedRemove, setArmedRemove] = useState(false);
  const importRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  const shelfRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const flip = useFlip(shelfRef);
  // 换伴侣时替身在飞：flying 真图藏着，landed 真图直接露出来（不再自己淡入，免得和替身一起半透明）
  const [landing, setLanding] = useState<"idle" | "flying" | "landed">("idle");

  const selectedId = settings.selectedAppearanceId;
  const selected = settings.petAssets.find((item) => item.id === selectedId) ?? null;
  const prefix = useMemo(() => commonPrefix(selected?.animations ?? []), [selected?.animations]);
  const actionsRef = useSlidingMark<HTMLDivElement>(`${selectedId}-${activeEntry}`);

  useEffect(() => {
    setActiveEntry(selected?.entry || selected?.animations[0] || null);
    setRenaming(null);
    setArmedRemove(false);
  }, [selectedId, selected?.entry, selected?.animations]);

  // 最近用过的在前；从没用过的按导入先后
  const shelf = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...settings.petAssets]
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (b.importedAt ?? 0) - (a.importedAt ?? 0))
      .filter((item) => !needle || item.name.toLowerCase().includes(needle));
  }, [settings.petAssets, filter]);

  async function choose(id: string) {
    if (id === selectedId) return;
    // 换上的那只从架子上飞到舞台；架子按最近使用重排，其余的滑到新位置
    const figure = shelfRef.current?.querySelector<HTMLImageElement>(`[data-flip-key="${id}"] img`);
    const stage = stageRef.current;
    if (figure && stage && figure.complete && figure.naturalHeight) {
      // 落点按舞台上真图会有的大小算（高不超过 232、不放大、底边贴地、水平居中），落地时两张正好重合
      const box = stage.getBoundingClientRect();
      const height = Math.min(figure.naturalHeight, STAGE_MAX_HEIGHT);
      const width = Math.min((figure.naturalWidth * height) / figure.naturalHeight, box.width);
      const finalHeight = (width * figure.naturalHeight) / figure.naturalWidth;
      const to = new DOMRect(box.left + (box.width - width) / 2, box.bottom - finalHeight, width, finalHeight);
      setLanding("flying");
      void flyImage(figure.src, figure.getBoundingClientRect(), to, { onLand: () => setLanding("landed") });
    }
    flip.capture();
    try {
      onSaved(await selectPetAppearance(id));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  async function importPaths(paths: string[]) {
    const accepted = paths.filter((path) => ACCEPTED.test(path));
    const skipped = paths.filter((path) => !ACCEPTED.test(path));
    if (!accepted.length) {
      if (skipped.length) notify(t("只认 ZIP、GIF 或 WebM"), "error");
      return;
    }
    setImporting(true);
    try {
      const result = await addPetAssets(accepted);
      onSaved(result.settings);
      setFailures([...result.failed, ...skipped.map((path) => ({ path, reason: t("不是 ZIP、GIF 或 WebM") }))]);
      if (result.imported > 0) {
        notify(result.imported === 1
          ? t("导入了 1 只，已经换上")
          : t("导入了 {count} 只", { count: result.imported }));
      }
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setImporting(false);
    }
  }
  importRef.current = importPaths;

  async function pickFiles() {
    try {
      const picked = await open({ multiple: true, directory: false, filters: [{ name: t("伴侣素材"), extensions: ["zip", "gif", "webm"] }] });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (paths.length) await importPaths(paths);
    } catch {
      notify(t("当前环境不支持选择文件"), "error");
    }
  }

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

  async function commitRename(id: string, value: string) {
    setRenaming(null);
    const current = settings.petAssets.find((item) => item.id === id);
    if (!current || !value.trim() || value.trim() === current.name) return;
    try {
      onSaved(await renamePetAsset(id, value));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  async function remove(id: string) {
    const name = settings.petAssets.find((item) => item.id === id)?.name ?? "";
    try {
      onSaved(await deletePetAsset(id));
      notify(t("移除了「{name}」", { name }));
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  const stageSrc = selected && !selected.missing ? petUrl(selected.id, activeEntry) : null;

  return (
    <div className={`pet-page ${dropping ? "is-dropping" : ""}`}>
      <section className="pet-current" aria-label={t("当前伴侣")}>
        <div className="pet-stage" ref={stageRef}>
          {stageSrc ? (
            <PetMedia
              key={stageSrc}
              className={`pet-stage-image ${landing === "flying" ? "is-landing" : landing === "landed" ? "is-landed" : ""}`}
              src={stageSrc}
              entry={activeEntry}
              alt={selected?.name ?? ""}
              fallback={<CatShape height={150} outline />}
            />
          ) : selected ? (
            <CatShape height={150} outline />
          ) : (
            <span className="app-glyph app-glyph-large" aria-hidden="true"><span /></span>
          )}
        </div>
        <div className="pet-floor" aria-hidden="true" />

        {selected ? (
          <>
            <div className="pet-name-line">
              {renaming === selected.id ? (
                <input
                  className="input pet-rename"
                  autoFocus
                  defaultValue={selected.name}
                  aria-label={t("新名字")}
                  maxLength={40}
                  onBlur={(event) => void commitRename(selected.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename(selected.id, event.currentTarget.value);
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <>
                  <h2 className="pet-name">{selected.name}</h2>
                  <button type="button" className="link small quiet" onClick={() => setRenaming(selected.id)}>{t("改名")}</button>
                </>
              )}
            </div>
            <span className="mono small quiet">
              {selected.animations.length === 1
                ? t("1 个动作")
                : t("{count} 个动作", { count: selected.animations.length })}
              {selected.sizeBytes ? ` · ${formatBytes(selected.sizeBytes)}` : ""}
            </span>
            {selected.animations.length > 1 && (
              <div className="choices choices-wrap pet-actions has-mark" role="radiogroup" aria-label={t("预览动作")} ref={actionsRef}>
                {selected.animations.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={activeEntry === entry}
                    className={`choice ${activeEntry === entry ? "is-on" : ""}`}
                    title={entry}
                    onClick={() => {
                      setLanding("idle");
                      setActiveEntry(entry);
                    }}
                  >
                    {entryLabel(entry, prefix, t)}
                  </button>
                ))}
              </div>
            )}
            <span className="spacer-v" />
            <button
              type="button"
              className="link small signal pet-remove"
              onClick={() => {
                if (armedRemove) void remove(selected.id);
                else {
                  setArmedRemove(true);
                  window.setTimeout(() => setArmedRemove(false), 2400);
                }
              }}
            >
              {armedRemove ? t("再点一次就移除") : t("移除这只")}
            </button>
          </>
        ) : (
          <>
            <h2 className="pet-name">{t("前台应用图标")}</h2>
          </>
        )}
      </section>

      <div className="pet-collection">
        <section className="pet-shelf-area" aria-label={t("全部形象")}>
          <div className="panel-head">
            <span className="panel-head-left">
              <h2 className="panel-title">{t("全部形象")}</h2>
              <span className="mono small quiet">{settings.petAssets.length}</span>
            </span>
            <span className="panel-head-right">
              {settings.petAssets.length > 5 && (
                <label className="search search-small">
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 8l3.5 3.5" stroke="currentColor" strokeWidth="1.2" /></svg>
                  <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("按名称筛选")} aria-label={t("按名称筛选形象")} />
                </label>
              )}
              <button type="button" className="btn btn-small" onClick={() => void pickFiles()} disabled={importing}>
                {importing ? t("导入中…") : t("导入…")}
              </button>
              <button type="button" className="btn btn-small" title={t("在独立窗口中浏览")} onClick={() => void showPetCatalog().catch((error) => notify(t("打开素材库失败：{detail}", { detail: errorText(error) }), "error"))}>
                {t("浏览素材库 ↗")}
              </button>
            </span>
          </div>

          {failures.length > 0 && (
            <div className="import-failures" role="alert">
              <span className="small">
                <span className="signal">
                  {failures.length === 1
                    ? t("这 1 个没导进来：")
                    : t("这 {count} 个没导进来：", { count: failures.length })}
                </span>
                {failures.map((item) => t("{file}（{reason}）", {
                  file: fileNameOf(item.path),
                  reason: item.reason,
                })).join(t("、"))}
              </span>
              <button type="button" className="link small" onClick={() => setFailures([])}>{t("知道了")}</button>
            </div>
          )}

          <div className="shelf" role="radiogroup" aria-label={t("选择伴侣")} ref={shelfRef}>
            {!filter && <ShelfItem asset={null} index={0} selected={selectedId === "app-icon"} onChoose={() => void choose("app-icon")} />}
            {shelf.map((asset, index) => (
              <ShelfItem
                key={asset.id}
                index={index + 1}
                asset={asset}
                selected={asset.id === selectedId}
                onChoose={() => void choose(asset.id)}
                onRemove={() => void remove(asset.id)}
              />
            ))}
            {dropping && <div className="shelf-drop small">{t("松手导入")}</div>}
          </div>
          {filter && shelf.length === 0 && (
            <p className="empty-line">
              {t("没有名字含「{filter}」的形象。", { filter: filter.trim() })}
              <button type="button" className="link" onClick={() => setFilter("")}>{t("清除筛选")}</button>
            </p>
          )}

        </section>
      </div>
    </div>
  );
}
