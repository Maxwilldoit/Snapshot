import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../app/context";
import { fetchPetCatalog, installCatalogPet, onPetCatalogChanged } from "../lib/backend";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { PetAsset, PetCatalogAsset, Settings } from "../types";
import { CatShape } from "./ui/CatShape";

type CatalogState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; assets: PetCatalogAsset[] };

type ImportResult = { status: "success" | "error"; message: string };

function CatalogItem({
  asset,
  installed,
  selected,
  importing,
  busy,
  result,
  onInstall,
}: {
  asset: PetCatalogAsset;
  installed: PetAsset | undefined;
  selected: boolean;
  importing: boolean;
  busy: boolean;
  result?: ImportResult;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const [previewFailed, setPreviewFailed] = useState(false);
  const label = importing
    ? t("下载并导入中…")
    : result?.status === "error"
      ? t("重试导入")
      : installed
        ? t("重新导入")
        : t("下载并导入");

  return (
    <article className="pet-catalog-item" aria-labelledby={headingId}>
      <div className="pet-catalog-preview">
        {previewFailed || !asset.previewUrl ? (
          <span className="pet-catalog-placeholder small quiet">
            <CatShape height={50} outline />
            {t("预览暂不可用")}
          </span>
        ) : (
          <img
            src={asset.previewUrl}
            alt={t("{name}预览", { name: asset.name })}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setPreviewFailed(true)}
          />
        )}
      </div>
      <div className="pet-catalog-name-line">
        <h3 id={headingId}>{asset.name}</h3>
        {installed && <span className="small quiet">{selected ? t("当前使用") : t("已导入")}</span>}
      </div>
      <p className="pet-catalog-description small ink-2">{asset.description}</p>
      {asset.tags.length > 0 && (
        <ul className="pet-catalog-tags small quiet" aria-label={t("标签")}>
          {asset.tags.map((tag, index) => <li key={`${tag}-${index}`}>{tag}</li>)}
        </ul>
      )}
      <dl className="pet-catalog-meta small">
        <div><dt>{t("大小")}</dt><dd className="mono">{formatBytes(asset.sizeBytes)}</dd></div>
        <div><dt>{t("版本")}</dt><dd className="mono">{asset.version}</dd></div>
        <div className="pet-catalog-license"><dt>{t("授权状态")}</dt><dd>{asset.licenseStatus || t("未说明")}</dd></div>
      </dl>
      <div className="pet-catalog-import">
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          aria-label={t("{action}「{name}」", { action: label, name: asset.name })}
          onClick={onInstall}
        >
          {label}
        </button>
        {importing && <span className="small quiet" role="status">{t("正在下载并导入「{name}」…", { name: asset.name })}</span>}
        {!importing && result && (
          <span className={`small ${result.status === "error" ? "signal" : "quiet"}`} role={result.status === "error" ? "alert" : "status"}>
            {result.message}
          </span>
        )}
      </div>
    </article>
  );
}

export function PetCatalog({ settings, onSaved }: { settings: Settings; onSaved: (settings: Settings) => void }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<CatalogState>({ status: "idle" });
  const [filter, setFilter] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const loading = useRef(false);
  const installing = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void loadCatalog();
    const pending = onPetCatalogChanged((assets) => {
      if (mounted.current && Array.isArray(assets)) setCatalog({ status: "ready", assets });
    });
    return () => {
      mounted.current = false;
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // 仅独立窗口挂载时加载；StrictMode 重挂载与重复打开都复用请求。
  async function loadCatalog(refresh = false) {
    if (loading.current || installing.current) return;
    loading.current = true;
    setCatalog({ status: "loading" });
    try {
      const assets = await fetchPetCatalog(refresh);
      if (mounted.current) setCatalog({ status: "ready", assets });
    } catch (error) {
      if (mounted.current) setCatalog({ status: "error", message: errorText(error) });
    } finally {
      loading.current = false;
    }
  }

  async function install(asset: PetCatalogAsset) {
    // 每次返回完整 Settings，串行导入以免较早的响应覆盖较新的选择。
    if (installing.current) return;
    installing.current = true;
    setInstallingId(asset.id);
    try {
      const next = await installCatalogPet(asset.id);
      // 后端也会广播 settings-changed，让主窗口和桌宠一起更新。
      onSaved(next);
      const name = next.petAssets.find((item) => item.id === next.selectedAppearanceId)?.name ?? asset.name;
      if (mounted.current) {
        setResults((previous) => ({
          ...previous,
          [asset.id]: { status: "success", message: t("已导入「{name}」", { name }) },
        }));
      }
    } catch (error) {
      const message = errorText(error);
      if (mounted.current) {
        setResults((previous) => ({
          ...previous,
          [asset.id]: { status: "error", message: t("导入失败：{detail}", { detail: message }) },
        }));
      }
    } finally {
      installing.current = false;
      if (mounted.current) setInstallingId(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const visible = catalog.status === "ready"
    ? catalog.assets.filter((asset) => !needle || [asset.name, asset.description, ...asset.tags].some((text) => text.toLowerCase().includes(needle)))
    : [];

  return (
    <section className="pet-catalog" aria-label={t("素材库")}>
      <div className="panel-head">
        <span className="panel-head-left">
          <h2 className="panel-title">{t("素材库")}</h2>
          {catalog.status === "ready" && <span className="mono small quiet">{catalog.assets.length}</span>}
        </span>
        <span className="panel-head-right">
          {catalog.status === "ready" && (
            <button type="button" className="text-btn small quiet" aria-label={t("刷新素材库")} disabled={installingId !== null} onClick={() => void loadCatalog(true)}>{t("刷新")}</button>
          )}
        </span>
      </div>
      <p className="pet-catalog-intro small quiet">
        {t("挑一只喜欢的，导入后自动换上。关闭窗口后下载仍会继续。")}
      </p>
      {catalog.status === "loading" && <p className="pet-catalog-state quiet" role="status">{t("正在加载素材库…")}</p>}
      {catalog.status === "error" && (
        <div className="pet-catalog-state" role="alert">
          <p>{t("素材库暂时打不开")}</p>
          <p className="small signal">{catalog.message}</p>
          <button type="button" className="link small" onClick={() => void loadCatalog()}>{t("重试加载")}</button>
        </div>
      )}
      {catalog.status === "ready" && (catalog.assets.length === 0 ? (
        <div className="pet-catalog-state">
          <p className="quiet" role="status">{t("素材库里暂时没有素材。")}</p>
          <button type="button" className="link small" onClick={() => void loadCatalog(true)}>{t("重新加载")}</button>
        </div>
      ) : (
        <>
          <label className="search pet-catalog-search">
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("名称、描述或标签")} aria-label={t("筛选素材库")} />
          </label>
          {visible.length === 0 && (
            <div className="pet-catalog-state">
              <p className="quiet" role="status">{t("没有匹配的素材。")}</p>
              <button type="button" className="link small" onClick={() => setFilter("")}>{t("清除筛选")}</button>
            </div>
          )}
          <div className="pet-catalog-grid">
            {visible.map((asset) => {
              const installed = settings.petAssets.find((item) => item.source === `https://github.com/Maxwilldoit/Pets#${asset.id}`);
              return (
                <CatalogItem
                  key={`${asset.id}-${asset.previewUrl}`}
                  asset={asset}
                  installed={installed}
                  selected={installed?.id === settings.selectedAppearanceId}
                  importing={installingId === asset.id}
                  busy={installingId !== null}
                  result={results[asset.id]}
                  onInstall={() => void install(asset)}
                />
              );
            })}
          </div>
        </>
      ))}
    </section>
  );
}
