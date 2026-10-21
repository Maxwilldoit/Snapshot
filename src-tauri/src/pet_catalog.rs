//! 公开素材目录只提供数据。下载按目录中的大小和 SHA-256 校验后，复用本地 ZIP 导入。
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;

const CATALOG_URL: &str = "https://raw.githubusercontent.com/Maxworkinghard/Pets/main/catalog.json";
const RELEASE_PREFIX: &str = "https://github.com/Maxworkinghard/Pets/releases/download/";
const PREVIEW_PREFIX: &str =
    "https://raw.githubusercontent.com/Maxworkinghard/Pets/main/catalog/previews/";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 100 * 1024 * 1024;

/// 延迟创建独立窗口；重复打开复用它，关闭隐藏以保留下载和筛选状态。
#[tauri::command]
pub(crate) async fn show_pet_catalog(app: AppHandle) -> Result<(), String> {
    // async command 在工作线程创建 WebView，避免 Windows 主线程死锁。
    // 创建期间串行化，防止快速点击产生两个相同 label 的窗口。
    static OPEN_LOCK: Mutex<()> = Mutex::new(());
    let _guard = OPEN_LOCK.lock();
    let window = match app.get_webview_window("pet-catalog") {
        Some(window) => window,
        None => tauri::WebviewWindowBuilder::new(
            &app,
            "pet-catalog",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("桌宠素材库 · Snapshot")
        .inner_size(920.0, 720.0)
        .min_inner_size(560.0, 440.0)
        .resizable(true)
        .center()
        .visible(false)
        .build()
        .map_err(|error| format!("无法创建素材库窗口：{error}"))?,
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetCatalogAsset {
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    version: String,
    file: String,
    size_bytes: u64,
    sha256: String,
    download_url: String,
    preview_url: String,
    license_status: String,
}

#[derive(Serialize, Deserialize)]
struct PetCatalog {
    version: u32,
    assets: Vec<PetCatalogAsset>,
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn parse_catalog(bytes: &[u8]) -> Result<PetCatalog, String> {
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("素材库目录文件过大".into());
    }
    let catalog: PetCatalog =
        serde_json::from_slice(bytes).map_err(|_| "素材库目录格式不正确".to_string())?;
    if catalog.version != 1 {
        return Err("当前应用不支持这个素材库版本".into());
    }
    let mut ids = HashSet::new();
    for asset in &catalog.assets {
        let release = asset
            .download_url
            .strip_prefix(RELEASE_PREFIX)
            .and_then(|tail| tail.split_once('/'));
        let valid_url = release.is_some_and(|(tag, file)| {
            safe_component(tag)
                && file == asset.file
                && safe_component(file)
                && file.ends_with(".zip")
        });
        if asset.id.is_empty()
            || asset.id.len() > 64
            || !asset
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !ids.insert(&asset.id)
            || asset.name.trim().is_empty()
            || asset.name.chars().count() > 40
            || !safe_component(&asset.version)
            || asset.size_bytes == 0
            || asset.size_bytes > MAX_ASSET_BYTES
            || asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !valid_url
            || asset.preview_url != format!("{PREVIEW_PREFIX}{}.png", asset.id)
        {
            return Err("素材库目录中有不合法的条目".into());
        }
    }
    Ok(catalog)
}

fn github_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "raw.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("Snapshot/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 || !github_url(attempt.url()) {
                attempt.error("素材下载地址重定向无效")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("无法连接素材库：{error}"))
}

async fn download(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("无法连接素材库，请稍后重试：{error}"))?
        .error_for_status()
        .map_err(|error| format!("素材库暂时不可用：{error}"))?;
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("素材下载大小超出限制".into());
    }
    let mut bytes = Vec::new();
    // 不依赖 Content-Length；分块检查实际大小，避免超大或无长度的响应占满内存。
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("素材下载中断，请重试：{error}"))?
    {
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err("素材下载大小超出限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_catalog() -> Result<PetCatalog, String> {
    parse_catalog(&download(CATALOG_URL, MAX_CATALOG_BYTES).await?)
}

fn verify_archive(asset: &PetCatalogAsset, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != asset.size_bytes {
        return Err("素材大小与目录不一致，请刷新素材库后重试".into());
    }
    if !format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(&asset.sha256) {
        return Err("素材校验失败，请刷新素材库后重试".into());
    }
    Ok(())
}

struct DownloadFile(PathBuf);

impl Drop for DownloadFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub(crate) async fn fetch_pet_catalog() -> Result<Vec<PetCatalogAsset>, String> {
    Ok(read_catalog().await?.assets)
}

#[tauri::command]
pub(crate) async fn install_catalog_pet(
    app: AppHandle,
    id: String,
) -> Result<settings::Settings, String> {
    // 只接受 id；URL、文件名和哈希都重新从固定目录读取，调用者无法替换下载源。
    let asset = read_catalog()
        .await?
        .assets
        .into_iter()
        .find(|asset| asset.id == id)
        .ok_or_else(|| "素材库中找不到这只伴侣，请刷新后重试".to_string())?;
    let bytes = download(&asset.download_url, asset.size_bytes).await?;
    verify_archive(&asset, &bytes)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir = state.pets_dir.join("downloads");
        fs::create_dir_all(&dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = dir.join(format!(
            "{}-{}-{}.zip",
            asset.id,
            now_millis(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("无法保存素材：{error}"))?;
        let temporary = DownloadFile(path);
        let written = file.write_all(&bytes);
        drop(file);
        written.map_err(|error| format!("无法保存素材：{error}"))?;
        pet::import_catalog_asset(
            &app,
            &state,
            &temporary.0.to_string_lossy(),
            &asset.id,
            &asset.name,
        )
    })
    .await
    .map_err(|error| format!("素材导入未完成：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({"version": 1, "assets": [{
            "id": "test-pet", "name": "测试宠物", "description": "测试", "tags": ["像素"],
            "version": "1.0.0", "file": "test-pet-1.0.0.zip", "sizeBytes": 3,
            "sha256": format!("{:x}", Sha256::digest(b"abc")),
            "downloadUrl": format!("{RELEASE_PREFIX}snapshot-assets-v1/test-pet-1.0.0.zip"),
            "previewUrl": format!("{PREVIEW_PREFIX}test-pet.png"),
            "licenseStatus": "未单独声明素材许可"
        }]})
    }

    fn parse(value: &Value) -> Result<PetCatalog, String> {
        parse_catalog(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn accepts_public_catalog_and_checks_download_integrity() {
        let catalog = parse(&sample()).unwrap();
        let pet = &catalog.assets[0];
        assert!(verify_archive(pet, b"abc").is_ok());
        assert!(verify_archive(pet, b"abd").is_err());
        assert!(verify_archive(pet, b"ab").is_err());
    }

    #[test]
    fn rejects_external_urls_traversal_and_invalid_metadata() {
        for (field, value) in [
            ("id", "../test-pet"),
            ("file", "../test-pet.zip"),
            ("sha256", "abcd"),
            (
                "downloadUrl",
                "https://github.com/elsewhere/Pets/releases/download/v1/test-pet-1.0.0.zip",
            ),
            (
                "downloadUrl",
                "https://github.com/Maxworkinghard/Pets/releases/download/../test-pet-1.0.0.zip",
            ),
            ("previewUrl", "https://example.com/image.png"),
        ] {
            let mut catalog = sample();
            catalog["assets"][0][field] = value.into();
            assert!(parse(&catalog).is_err(), "{field}: {value}");
        }
        let mut catalog = sample();
        catalog["version"] = 2.into();
        assert!(parse(&catalog).is_err());
        let mut catalog = sample();
        catalog["assets"][0]["sizeBytes"] = (MAX_ASSET_BYTES + 1).into();
        assert!(parse(&catalog).is_err());
        let mut catalog = sample();
        let duplicate = catalog["assets"][0].clone();
        catalog["assets"].as_array_mut().unwrap().push(duplicate);
        assert!(parse(&catalog).is_err());
    }

    #[test]
    fn redirects_stay_on_github_https_hosts() {
        for url in [
            "https://release-assets.githubusercontent.com/file?token=abc",
            "https://github.com/file",
        ] {
            assert!(github_url(&url.parse().unwrap()));
        }
        for url in [
            "http://github.com/file",
            "https://github.com.evil.test/file",
            "https://user@github.com/file",
            "https://github.com:1234/file",
        ] {
            assert!(!github_url(&url.parse().unwrap()));
        }
    }

    #[test]
    #[ignore = "requires SNAPSHOT_PET_LIBRARY pointing at a prepared Pets repository"]
    fn published_library_archives_pass_snapshot_import_validation() {
        let root = PathBuf::from(
            std::env::var_os("SNAPSHOT_PET_LIBRARY").expect("set SNAPSHOT_PET_LIBRARY"),
        );
        let catalog = parse_catalog(&fs::read(root.join("catalog.json")).unwrap()).unwrap();
        assert!(!catalog.assets.is_empty());
        for asset in catalog.assets {
            let path = root.join("dist/snapshot-assets-v1").join(&asset.file);
            verify_archive(&asset, &fs::read(&path).unwrap()).unwrap();
            let animations = pet::find_pet_animation_entries(&path).unwrap();
            assert!(!animations.is_empty(), "{}", asset.id);
            let manifest = pet_layout::read_pet_layout(&path, &animations)
                .unwrap()
                .unwrap();
            assert_eq!(
                manifest.layout.frames.len(),
                animations.len(),
                "{}",
                asset.id
            );
            assert!(!manifest.event_actions.is_empty(), "{}", asset.id);
        }
    }
}
