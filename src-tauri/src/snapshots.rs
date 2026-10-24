use super::*;
use image::buffer::ConvertBuffer;
use serde::Deserialize;

const SNAPSHOT_LIMIT: usize = 200;
/// 缩略图的目标高度（像素）。列表里显示 76px 高，高分屏两倍再留点余量
const THUMB_HEIGHT: u32 = 180;
/// 超宽截图（带鱼屏、横向长图）缩略图的宽度上限
const THUMB_MAX_WIDTH: u32 = 640;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotRecord {
    pub(crate) id: String,
    pub(crate) file_name: String,
    pub(crate) app_name: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) size_bytes: u64,
    pub(crate) created_at: u64,
}

/// 默认把快照放到用户能在资源管理器里直接看到的「图片/Snapshot」。
/// 系统没有图片目录时退回应用数据目录。
pub(crate) fn default_history_dir(app_data_snapshots: &Path) -> PathBuf {
    dirs::picture_dir()
        .map(|pictures| pictures.join("Snapshot"))
        .unwrap_or_else(|| app_data_snapshots.to_path_buf())
}

/// 早期版本把快照放在 AppData。复制到新目录，重复运行不会生成重复记录。
pub(crate) fn migrate_legacy_history(
    legacy: &Path,
    destination: &Path,
    marker: &Path,
) -> Result<(), String> {
    if marker.exists() || legacy == destination {
        return Ok(());
    }
    if !legacy.is_dir() {
        if let Some(parent) = marker.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(marker, b"1");
        return Ok(());
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(legacy)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let source = entry.path();
        let target = destination.join(entry.file_name());
        if source.is_file() && !target.exists() {
            fs::copy(source, target).map_err(|error| error.to_string())?;
        }
    }

    let legacy_index = legacy.join("index.json");
    let target_index = destination.join("index.json");
    let mut records = read_snapshot_index(&target_index);
    for record in read_snapshot_index(&legacy_index) {
        if !records.iter().any(|existing| existing.id == record.id) {
            records.push(record);
        }
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    records.truncate(SNAPSHOT_LIMIT);
    write_snapshot_index(&target_index, &records)?;
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(marker, b"1").map_err(|error| error.to_string())
}

/// 历史落盘目录：优先用户配置的 save_dir，否则用默认的用户图片目录。
pub(crate) fn history_dir(state: &AppState) -> PathBuf {
    let configured = state.settings.lock().save_dir.trim().to_string();
    if !configured.is_empty() {
        PathBuf::from(expand_user_path(&configured))
    } else {
        state.snapshots_dir.clone()
    }
}

pub(crate) fn snapshot_index_path(state: &AppState) -> PathBuf {
    history_dir(state).join("index.json")
}

pub(crate) fn clipboard_clear_delay(setting: &str) -> Option<Duration> {
    match setting {
        "30s" => Some(Duration::from_secs(30)),
        "5m" => Some(Duration::from_secs(300)),
        "never" => None,
        // "60s" 与未知值一律按 60 秒
        _ => Some(Duration::from_secs(60)),
    }
}

pub(crate) fn snapshot_format_parts(setting: &str) -> (ImageFormat, &'static str) {
    match setting {
        "jpeg" | "jpg" => (ImageFormat::Jpeg, "jpg"),
        "webp" => (ImageFormat::WebP, "webp"),
        _ => (ImageFormat::Png, "png"),
    }
}

pub(crate) fn mime_for_snapshot_file(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

pub(crate) fn format_clear_label(setting: &str) -> String {
    if interface_is_english() {
        return match setting {
            "30s" => "The clipboard will clear in 30 seconds".into(),
            "5m" => "The clipboard will clear in 5 minutes".into(),
            "never" => "The clipboard will not be cleared automatically".into(),
            _ => "The clipboard will clear in 60 seconds".into(),
        };
    }
    match setting {
        "30s" => "30 秒后自动清空剪贴板".into(),
        "5m" => "5 分钟后自动清空剪贴板".into(),
        "never" => "不会自动清空剪贴板".into(),
        _ => "60 秒后自动清空剪贴板".into(),
    }
}

pub(crate) fn read_snapshot_index(path: &PathBuf) -> Vec<SnapshotRecord> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn write_snapshot_index(
    path: &PathBuf,
    records: &[SnapshotRecord],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(records).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

/// 把截图落盘并登记进历史索引。
/// 这里失败不该影响"已复制到剪贴板"这件事，所以调用方只记录不中断。
pub(crate) fn store_snapshot(
    state: &AppState,
    image: &RgbaImage,
    app_name: &str,
) -> Result<SnapshotRecord, String> {
    let dir = history_dir(state);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let format_setting = state.settings.lock().snapshot_format.clone();
    let (format, ext) = snapshot_format_parts(&format_setting);
    let created_at = now_millis();
    let id = format!("snap-{created_at}");
    let file_name = format!("{id}.{ext}");
    let path = dir.join(&file_name);
    write_image(image, &path, format).map_err(|error| format!("保存快照失败：{error}"))?;
    let size_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let record = SnapshotRecord {
        id,
        file_name,
        app_name: app_name.to_string(),
        width: image.width(),
        height: image.height(),
        size_bytes,
        created_at,
    };
    // 缩略图失败不影响快照本身：列表里取不到时会按原图现做一张
    let _ = write_thumbnail(state, &record.id, image);
    let index_path = snapshot_index_path(state);
    let mut records = read_snapshot_index(&index_path);
    records.insert(0, record.clone());
    for stale in records.split_off(records.len().min(SNAPSHOT_LIMIT)) {
        remove_snapshot_files(state, &dir, &stale);
    }
    write_snapshot_index(&index_path, &records)?;
    Ok(record)
}

fn thumbnail_path(state: &AppState, id: &str) -> PathBuf {
    state.thumbs_dir.join(format!("{id}.jpg"))
}

/// 按原比例缩到固定高度（超宽的再按宽度封顶），存成 JPEG。
/// 历史页一屏几十张，原图动辄几 MB，直接当缩略图用会让滚动发卡。
fn write_thumbnail(state: &AppState, id: &str, image: &RgbaImage) -> Result<(), String> {
    let (width, height) = thumbnail_size(image.width(), image.height());
    let small = image::imageops::thumbnail(image, width, height);
    let rgb: image::RgbImage = small.convert();
    fs::create_dir_all(&state.thumbs_dir).map_err(|error| error.to_string())?;
    rgb.save_with_format(thumbnail_path(state, id), ImageFormat::Jpeg)
        .map_err(|error| error.to_string())
}

fn thumbnail_size(width: u32, height: u32) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    if height <= THUMB_HEIGHT && width <= THUMB_MAX_WIDTH {
        return (width, height);
    }
    let by_height = THUMB_HEIGHT as f64 / height as f64;
    let by_width = THUMB_MAX_WIDTH as f64 / width as f64;
    let scale = by_height.min(by_width);
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

fn remove_snapshot_files(state: &AppState, dir: &Path, record: &SnapshotRecord) {
    let _ = fs::remove_file(dir.join(&record.file_name));
    let _ = fs::remove_file(thumbnail_path(state, &record.id));
}

/// 按格式写盘。JPEG 不支持 alpha，要先转成 RGB；PNG / WebP 直接写 RGBA。
pub(crate) fn write_image(
    image: &RgbaImage,
    path: &Path,
    format: ImageFormat,
) -> image::ImageResult<()> {
    if format == ImageFormat::Jpeg {
        let rgb: image::RgbImage = image.convert();
        rgb.save_with_format(path, format)
    } else {
        image.save_with_format(path, format)
    }
}

/// 展开 `~/…`；其它路径原样返回。
pub(crate) fn expand_user_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    trimmed.to_string()
}

#[tauri::command]
pub(crate) fn open_snapshots_dir(state: State<'_, AppState>) -> Result<String, String> {
    let path = history_dir(&state);
    fs::create_dir_all(&path).map_err(|error| format!("无法创建快照目录：{error}"))?;

    os::open_folder(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn get_snapshot_dir(state: State<'_, AppState>) -> String {
    history_dir(&state).to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) fn list_snapshots(state: State<'_, AppState>) -> Vec<SnapshotRecord> {
    let index_path = snapshot_index_path(&state);
    let records = read_snapshot_index(&index_path);
    // 文件被手动删掉的条目顺手从索引里剔除，避免历史库里全是打不开的记录
    let (alive, dropped): (Vec<_>, Vec<_>) = records
        .into_iter()
        .partition(|item| history_dir(&state).join(&item.file_name).is_file());
    if !dropped.is_empty() {
        let _ = write_snapshot_index(&index_path, &alive);
    }
    alive
}

fn find_record(state: &AppState, id: &str) -> Result<SnapshotRecord, String> {
    read_snapshot_index(&snapshot_index_path(state))
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "找不到这条快照".to_string())
}

/// 按 id 读出一张快照的文件字节与类型（媒体协议用）。
pub(crate) fn read_snapshot(state: &AppState, id: &str) -> Result<(&'static str, Vec<u8>), String> {
    let record = find_record(state, id)?;
    let bytes = fs::read(history_dir(state).join(&record.file_name))
        .map_err(|_| "快照文件已被移动或删除".to_string())?;
    Ok((mime_for_snapshot_file(&record.file_name), bytes))
}

/// 读缩略图；老快照没有缩略图时按原图现做一张存下来。
pub(crate) fn read_thumbnail(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let path = thumbnail_path(state, id);
    if let Ok(bytes) = fs::read(&path) {
        return Ok(bytes);
    }
    let record = find_record(state, id)?;
    let image = image::open(history_dir(state).join(&record.file_name))
        .map_err(|_| "快照文件已被移动或删除".to_string())?
        .to_rgba8();
    write_thumbnail(state, id, &image)?;
    fs::read(&path).map_err(|error| error.to_string())
}

/// 删掉选中的若干张（「全选」再删就是清空）。返回删完后的列表。
#[tauri::command]
pub(crate) fn delete_snapshots(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<SnapshotRecord>, String> {
    let dir = history_dir(&state);
    let index_path = snapshot_index_path(&state);
    let (removed, kept): (Vec<_>, Vec<_>) = read_snapshot_index(&index_path)
        .into_iter()
        .partition(|item| ids.contains(&item.id));
    for record in &removed {
        remove_snapshot_files(&state, &dir, record);
    }
    write_snapshot_index(&index_path, &kept)?;
    let _ = app.emit("snapshots-changed", ());
    Ok(kept)
}

/// 从历史原图打开现有标注窗口，不修改原始快照。
#[tauri::command]
pub(crate) async fn annotate_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let record = find_record(&state, &id)?;
        let (_, bytes) = read_snapshot(&state, &id)?;
        let image = image::load_from_memory(&bytes)
            .map_err(|error| format!("无法读取快照图片：{error}"))?
            .to_rgba8();
        capture::open_annotate_window(&app, &state, &image, &record.app_name)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 把历史里的一张重新放回剪贴板（同样按偏好自动清空）
#[tauri::command]
pub(crate) fn copy_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let record = find_record(&state, &id)?;
    let image = image::open(history_dir(&state).join(&record.file_name))
        .map_err(|_| "快照文件已被移动或删除".to_string())?
        .to_rgba8();
    let title = if interface_is_english() {
        format!("{} screenshot", record.app_name)
    } else {
        format!("{} 截图", record.app_name)
    };
    clipboard::copy_image(&app, &state, image, &title, Some(record.id.clone()))?;
    let clear_label = format_clear_label(&state.settings.lock().clipboard_auto_clear);
    if interface_is_english() {
        Ok(format!("Copied {} · {clear_label}", record.app_name))
    } else {
        Ok(format!("已复制 {}，{clear_label}", record.app_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_user_path_keeps_absolute_and_expands_tilde() {
        assert_eq!(expand_user_path("/tmp/out"), "/tmp/out");
        assert_eq!(expand_user_path("  /tmp/out  "), "/tmp/out");
        if let Some(home) = dirs::home_dir() {
            let expected = home.join("Videos").to_string_lossy().into_owned();
            assert_eq!(expand_user_path("~/Videos"), expected);
        }
    }

    #[test]
    fn clipboard_clear_delay_honors_preference_tokens() {
        assert_eq!(clipboard_clear_delay("30s"), Some(Duration::from_secs(30)));
        assert_eq!(clipboard_clear_delay("60s"), Some(Duration::from_secs(60)));
        assert_eq!(clipboard_clear_delay("5m"), Some(Duration::from_secs(300)));
        assert_eq!(clipboard_clear_delay("never"), None);
        assert_eq!(
            clipboard_clear_delay("weird"),
            Some(Duration::from_secs(60))
        );
    }

    #[test]
    fn snapshot_format_parts_map_ui_tokens() {
        assert_eq!(snapshot_format_parts("png"), (ImageFormat::Png, "png"));
        assert_eq!(snapshot_format_parts("jpeg"), (ImageFormat::Jpeg, "jpg"));
        assert_eq!(snapshot_format_parts("webp"), (ImageFormat::WebP, "webp"));
        assert_eq!(mime_for_snapshot_file("a.JPG"), "image/jpeg");
        assert_eq!(mime_for_snapshot_file("a.webp"), "image/webp");
        assert_eq!(mime_for_snapshot_file("a.png"), "image/png");
    }

    #[test]
    fn thumbnails_keep_the_aspect_ratio() {
        assert_eq!(thumbnail_size(1920, 1080), (320, 180));
        // 滚动长截图又窄又长：高度封顶，宽度跟着比例走
        assert_eq!(thumbnail_size(1280, 6400), (36, 180));
        // 超宽屏按宽度封顶
        assert_eq!(thumbnail_size(10000, 1000), (640, 64));
        // 本来就小的不放大
        assert_eq!(thumbnail_size(120, 90), (120, 90));
    }

    #[test]
    fn write_image_round_trips_every_supported_format() {
        let image = RgbaImage::from_pixel(3, 2, image::Rgba([200, 100, 50, 128]));
        for (format, ext) in [
            (ImageFormat::Png, "png"),
            (ImageFormat::Jpeg, "jpg"),
            (ImageFormat::WebP, "webp"),
        ] {
            let path = std::env::temp_dir().join(format!("snapshot-write-image-test.{ext}"));
            write_image(&image, &path, format).expect("写盘失败");
            let decoded = image::open(&path).expect("写出的文件应能读回");
            assert_eq!((decoded.width(), decoded.height()), (3, 2), "{ext}");
            let _ = fs::remove_file(&path);
        }
    }

    #[test]
    fn legacy_history_copies_to_the_visible_default_only_once() {
        let root = std::env::temp_dir().join(format!(
            "snapshot-history-migration-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let legacy = root.join("legacy");
        let destination = root.join("pictures/Snapshot");
        let marker = root.join("app-data/migration-complete");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("snap-1.png"), b"image").unwrap();
        let record = SnapshotRecord {
            id: "snap-1".into(),
            file_name: "snap-1.png".into(),
            app_name: "Codex".into(),
            width: 10,
            height: 10,
            size_bytes: 5,
            created_at: 1,
        };
        write_snapshot_index(&legacy.join("index.json"), &[record]).unwrap();

        migrate_legacy_history(&legacy, &destination, &marker).unwrap();
        fs::remove_file(destination.join("snap-1.png")).unwrap();
        migrate_legacy_history(&legacy, &destination, &marker).unwrap();

        assert!(!destination.join("snap-1.png").exists());
        let restored = read_snapshot_index(&destination.join("index.json"));
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].app_name, "Codex");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_history_uses_pictures_when_available() {
        let fallback = std::env::temp_dir().join("snapshot-app-data");
        let resolved = default_history_dir(&fallback);
        if let Some(pictures) = dirs::picture_dir() {
            assert_eq!(resolved, pictures.join("Snapshot"));
        } else {
            assert_eq!(resolved, fallback);
        }
    }
}
