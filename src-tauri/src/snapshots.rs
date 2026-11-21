use super::*;
use crate::capture_timing::CaptureTrace;
use crate::trash::{self, TrashEntry, TrashMedia};
use image::buffer::ConvertBuffer;
use serde::Deserialize;

/// 缩略图的目标高度（像素）。历史照片墙卡片最高约 300px CSS，按 2× Retina 留足清晰度
const THUMB_HEIGHT: u32 = 600;
/// 超宽截图（带鱼屏、横向长图）缩略图的宽度上限
const THUMB_MAX_WIDTH: u32 = 1600;
/// 历史与回收站缩略图 JPEG 编码质量（高清晰度减少界面文字周围的压缩噪点）
const THUMB_JPEG_QUALITY: u8 = 90;
/// 升级缩略图规格后更换缓存后缀，让已有历史的旧 180px 缩略图自动重建高清版
const THUMB_SUFFIX: &str = ".v2.jpg";

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
    /// 来源应用的稳定标识（macOS bundle id / .app 路径，Windows、Linux 可执行文件路径）。
    /// 历史角标据此取图标，应用退出后仍有效。旧记录没有这一项，缺省 None，不显示角标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) app_id: Option<String>,
}

/// 默认把快照放到用户能在资源管理器里直接看到的「图片/Snapshot」；
/// 开发态隔离到各自的应用开发数据目录，不与正式版共用历史。
pub(crate) fn default_history_dir_for_mode(
    app_data_snapshots: &Path,
    dev_isolated: bool,
) -> PathBuf {
    if dev_isolated {
        return app_data_snapshots.to_path_buf();
    }
    default_history_dir(app_data_snapshots)
}

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

/// 最近一次读写过的索引。列表、缩略图、媒体协议每次都要查它，图多了反复解析 JSON 很浪费；
/// 文件的修改时间或大小一变（包括在别处被改）就作废重读。
struct IndexCache {
    path: PathBuf,
    stamp: (SystemTime, u64),
    records: Vec<SnapshotRecord>,
}

static INDEX_CACHE: Mutex<Option<IndexCache>> = Mutex::new(None);

fn index_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

pub(crate) fn read_snapshot_index(path: &Path) -> Vec<SnapshotRecord> {
    let stamp = index_stamp(path);
    if let (Some(stamp), Some(cache)) = (stamp, INDEX_CACHE.lock().as_ref()) {
        if cache.path == path && cache.stamp == stamp {
            return cache.records.clone();
        }
    }
    let records: Vec<SnapshotRecord> = read_json_with_backup(path).unwrap_or_default();
    *INDEX_CACHE.lock() = stamp.map(|stamp| IndexCache {
        path: path.to_path_buf(),
        stamp,
        records: records.clone(),
    });
    records
}

fn find_snapshot_record(path: &Path, id: &str) -> Option<SnapshotRecord> {
    let stamp = index_stamp(path);
    if let (Some(stamp), Some(cache)) = (stamp, INDEX_CACHE.lock().as_ref()) {
        if cache.path == path && cache.stamp == stamp {
            return cache.records.iter().find(|item| item.id == id).cloned();
        }
    }
    let records = read_snapshot_index(path);
    records.into_iter().find(|item| item.id == id)
}

pub(crate) fn write_snapshot_index(path: &Path, records: &[SnapshotRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let result = write_json_atomic(path, records);
    *INDEX_CACHE.lock() = match (&result, index_stamp(path)) {
        (Ok(()), Some(stamp)) => Some(IndexCache {
            path: path.to_path_buf(),
            stamp,
            records: records.to_vec(),
        }),
        _ => None,
    };
    result
}

/// 把截图落盘并登记进历史索引。
/// 这里失败不该影响"已复制到剪贴板"这件事，所以调用方只记录不中断。
pub(crate) fn store_snapshot_traced(
    state: &AppState,
    image: &RgbaImage,
    app_name: &str,
    app_id: Option<String>,
    trace: &CaptureTrace,
) -> Result<SnapshotRecord, String> {
    let dir = history_dir(state);
    let record = write_snapshot_file(state, &dir, image, app_name, app_id, Some(trace))?;
    let _ = write_thumbnail(state, &record.id, image, Some(trace));
    let index_path = dir.join("index.json");
    {
        let _guard = state.snapshot_index_lock.lock();
        let mut records = read_snapshot_index(&index_path);
        records.insert(0, record.clone());
        if let Err(error) = write_snapshot_index(&index_path, &records) {
            let _ = fs::remove_file(dir.join(&record.file_name));
            remove_thumbnail_files(state, &record.id);
            return Err(error);
        }
    }
    trace.mark("history_index");
    Ok(record)
}

fn write_snapshot_file(
    state: &AppState,
    dir: &Path,
    image: &RgbaImage,
    app_name: &str,
    app_id: Option<String>,
    trace: Option<&CaptureTrace>,
) -> Result<SnapshotRecord, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let format_setting = state.settings.lock().snapshot_format.clone();
    let (format, ext) = snapshot_format_parts(&format_setting);
    let created_at = now_millis();
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let id = format!(
        "snap-{created_at}-{}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let file_name = format!("{id}.{ext}");
    let path = dir.join(&file_name);
    let result = match trace.filter(|trace| trace.enabled()) {
        Some(trace) => write_image_timed(image, &path, format, trace),
        None => write_image(image, &path, format).map_err(|error| error.to_string()),
    };
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(format!("保存快照失败：{error}"));
    }
    let size_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(SnapshotRecord {
        id,
        file_name,
        app_name: app_name.to_string(),
        width: image.width(),
        height: image.height(),
        size_bytes,
        created_at,
        app_id,
    })
}

fn thumbnail_path(state: &AppState, id: &str) -> PathBuf {
    state.thumbs_dir.join(format!("{id}{THUMB_SUFFIX}"))
}

fn legacy_thumbnail_path(state: &AppState, id: &str) -> PathBuf {
    state.thumbs_dir.join(format!("{id}.jpg"))
}

fn remove_thumbnail_files(state: &AppState, id: &str) {
    let _ = fs::remove_file(thumbnail_path(state, id));
    let _ = fs::remove_file(legacy_thumbnail_path(state, id));
}

pub(crate) fn encode_thumbnail_jpeg(image: &image::RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, THUMB_JPEG_QUALITY);
    encoder
        .encode_image(image)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

/// 按原比例缩到适配高分屏的尺寸（超宽的再按宽度封顶），以高质量 JPEG 存盘。
/// 历史页一屏几十张，原图动辄几 MB，直接当缩略图用会让滚动发卡。
fn write_thumbnail(
    state: &AppState,
    id: &str,
    image: &RgbaImage,
    trace: Option<&CaptureTrace>,
) -> Result<Vec<u8>, String> {
    let rgb = make_thumbnail(image);
    let bytes = encode_thumbnail_jpeg(&rgb)?;
    write_cache_atomic(&thumbnail_path(state, id), &bytes)?;
    let _ = fs::remove_file(legacy_thumbnail_path(state, id));
    if let Some(trace) = trace {
        trace.mark("thumbnail");
    }
    Ok(bytes)
}

pub(crate) fn make_thumbnail(image: &RgbaImage) -> image::RgbImage {
    let (width, height) = thumbnail_size(image.width(), image.height());
    image::imageops::thumbnail(image, width, height).convert()
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

/// 截图历史路径专用：把编码和落盘拆开计时。仍使用 image crate 的原编码器，
/// 输出格式不变；增加的临时缓冲在写完后立即释放。
fn write_image_timed(
    image: &RgbaImage,
    path: &Path,
    format: ImageFormat,
    trace: &CaptureTrace,
) -> Result<(), String> {
    let bytes = encode_snapshot(image, format)?;
    trace.mark("snapshot_encode");
    fs::write(path, bytes).map_err(|error| error.to_string())?;
    trace.mark("snapshot_write");
    Ok(())
}

fn encode_snapshot(image: &RgbaImage, format: ImageFormat) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    if format == ImageFormat::Jpeg {
        let rgb: image::RgbImage = image.convert();
        rgb.write_to(&mut bytes, format)
            .map_err(|error| error.to_string())?;
    } else {
        image
            .write_to(&mut bytes, format)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes.into_inner())
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
pub(crate) async fn list_snapshots(app: AppHandle) -> Result<Vec<SnapshotRecord>, String> {
    on_worker(app, |_app, state| Ok(list_snapshots_now(state))).await
}

fn list_snapshots_now(state: &AppState) -> Vec<SnapshotRecord> {
    let dir = history_dir(state);
    let index_path = dir.join("index.json");
    let _guard = state.snapshot_index_lock.lock();
    let records = read_snapshot_index(&index_path);
    // 文件被手动删掉的条目顺手从索引里剔除并清理孤立缩略图；同时自动纠偏早期版本误写成上一个前台应用的 appId
    let (mut alive, dropped): (Vec<_>, Vec<_>) = records
        .into_iter()
        .partition(|item| dir.join(&item.file_name).is_file());
    for item in &dropped {
        remove_thumbnail_files(state, &item.id);
    }
    let mut repaired = false;
    for item in &mut alive {
        let reconciled = os::reconcile_app_id(&item.app_name, item.app_id.as_deref());
        if reconciled != item.app_id {
            item.app_id = reconciled;
            repaired = true;
        }
    }
    if !dropped.is_empty() || repaired {
        let _ = write_snapshot_index(&index_path, &alive);
    }
    alive
}

fn find_record(state: &AppState, id: &str) -> Result<SnapshotRecord, String> {
    let index_path = snapshot_index_path(state);
    let _guard = state.snapshot_index_lock.lock();
    find_snapshot_record(&index_path, id).ok_or_else(|| "找不到这条快照".to_string())
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
    // 先在索引里找到这条再拼路径：地址里的 id 是外来的，不能拿它去碰任意文件
    let record = find_record(state, id)?;
    let path = thumbnail_path(state, &record.id);
    if let Ok(bytes) = fs::read(&path) {
        return Ok(bytes);
    }
    let image = image::open(history_dir(state).join(&record.file_name))
        .map_err(|_| "快照文件已被移动或删除".to_string())?
        .to_rgba8();
    write_thumbnail(state, id, &image, None)
}

#[tauri::command]
pub(crate) async fn delete_snapshots(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<SnapshotRecord>, String> {
    on_worker(app, move |app, state| delete_snapshots_now(app, state, ids)).await
}

fn delete_snapshots_now(
    app: &AppHandle,
    state: &AppState,
    ids: Vec<String>,
) -> Result<Vec<SnapshotRecord>, String> {
    let dir = history_dir(state);
    let index_path = dir.join("index.json");
    let _trash_guard = state.trash_lock.lock();
    let _guard = state.snapshot_index_lock.lock();
    let (removed, kept): (Vec<_>, Vec<_>) = read_snapshot_index(&index_path)
        .into_iter()
        .partition(|item| ids.contains(&item.id));
    update_snapshot_history(&state.trash_dir, &dir, &removed, &kept)?;
    for record in removed {
        remove_thumbnail_files(state, &record.id);
    }
    let _ = app.emit("snapshots-changed", ());
    Ok(kept)
}

fn update_snapshot_history(
    trash_dir: &Path,
    directory: &Path,
    removed: &[SnapshotRecord],
    kept: &[SnapshotRecord],
) -> Result<(), String> {
    let mut archived = Vec::new();
    let result = (|| {
        for record in removed {
            let source = trash::checked_file(directory, &record.file_name)?;
            let entry = trash::archive(trash_dir, &source, TrashMedia::Snapshot(record.clone()))?;
            archived.push((source, entry));
        }
        write_snapshot_index(&directory.join("index.json"), kept)
    })();
    result.map_err(|error| rollback_archive(trash_dir, archived, error))
}

fn rollback_archive(root: &Path, archived: Vec<(PathBuf, TrashEntry)>, error: String) -> String {
    let mut recovery = None;
    for (destination, entry) in archived {
        if let Err(error) =
            trash::copy_out(root, &entry, &destination).and_then(|()| trash::discard(root, &entry))
        {
            recovery = Some(error);
        }
    }
    match recovery {
        Some(recovery) => format!("原图仍可从回收站恢复：{error}；{recovery}"),
        None => error,
    }
}

pub(crate) fn restore_snapshot(
    state: &AppState,
    entry: &TrashEntry,
    record: &SnapshotRecord,
) -> Result<(), String> {
    let dir = history_dir(state);
    let index = dir.join("index.json");
    let _guard = state.snapshot_index_lock.lock();
    let before = read_snapshot_index(&index);
    let destination = trash::checked_file(&dir, &record.file_name)?;
    if before
        .iter()
        .any(|item| item.id == record.id && dir.join(&item.file_name).is_file())
    {
        return Err("目标文件已存在，无法恢复".into());
    }
    trash::copy_out(&state.trash_dir, entry, &destination)?;
    let mut records = before.clone();
    records.retain(|item| item.id != record.id);
    records.push(record.clone());
    records.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    if let Err(error) = write_snapshot_index(&index, &records) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    if let Err(error) = trash::discard(&state.trash_dir, entry) {
        if write_snapshot_index(&index, &before).is_ok() {
            let _ = fs::remove_file(destination);
        }
        return Err(error);
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct SnapshotSource {
    pub(crate) directory: PathBuf,
    pub(crate) record: SnapshotRecord,
}

pub(crate) fn replace_snapshot(
    state: &AppState,
    source: &SnapshotSource,
    image: &RgbaImage,
) -> Result<SnapshotRecord, String> {
    let dir = &source.directory;
    let index = dir.join("index.json");
    let _trash_guard = state.trash_lock.lock();
    let _guard = state.snapshot_index_lock.lock();
    let mut records = read_snapshot_index(&index);
    let position = records
        .iter()
        .position(|record| {
            record.id == source.record.id && record.file_name == source.record.file_name
        })
        .ok_or("原图已不在历史记录中，请重新打开标注")?;
    let original = records[position].clone();
    let mut edited = write_snapshot_file(
        state,
        dir,
        image,
        &source.record.app_name,
        source.record.app_id.clone(),
        None,
    )?;
    edited.created_at = original.created_at;
    records[position] = edited.clone();
    let result = update_snapshot_history(
        &state.trash_dir,
        dir,
        std::slice::from_ref(&original),
        &records,
    );
    if let Err(error) = result {
        let _ = fs::remove_file(dir.join(&edited.file_name));
        return Err(error);
    }
    remove_thumbnail_files(state, &original.id);
    let _ = write_thumbnail(state, &edited.id, image, None);
    Ok(edited)
}

#[tauri::command]
pub(crate) async fn annotate_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    on_worker(app, move |app, state| {
        let directory = history_dir(state);
        let (mut record, bytes) = {
            let _guard = state.snapshot_index_lock.lock();
            let record = read_snapshot_index(&directory.join("index.json"))
                .into_iter()
                .find(|item| item.id == id)
                .ok_or("找不到这条快照")?;
            let path = trash::checked_file(&directory, &record.file_name)?;
            let bytes = fs::read(path).map_err(|_| "快照文件已被移动或删除")?;
            (record, bytes)
        };
        record.app_id = os::reconcile_app_id(&record.app_name, record.app_id.as_deref());
        let image = image::load_from_memory(&bytes)
            .map_err(|error| format!("无法读取快照图片：{error}"))?
            .to_rgba8();
        capture::open_annotate_window(app, state, &image, SnapshotSource { directory, record })
    })
    .await
}

/// 把历史里的一张重新放回剪贴板，内容一直保留到用户复制别的东西
#[tauri::command]
pub(crate) async fn copy_snapshot(app: AppHandle, id: String) -> Result<String, String> {
    on_worker(app, move |_app, state| copy_snapshot_now(state, id)).await
}

fn copy_snapshot_now(state: &AppState, id: String) -> Result<String, String> {
    let record = find_record(state, &id)?;
    let image = image::open(history_dir(state).join(&record.file_name))
        .map_err(|_| "快照文件已被移动或删除".to_string())?
        .to_rgba8();
    clipboard::copy_image(image)?;
    if interface_is_english() {
        Ok(format!("Copied {}.", record.app_name))
    } else {
        Ok(format!("已复制 {}", record.app_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_keeps_edited_image_in_history_and_archives_original_bytes() {
        check_history_replacement(false);
    }

    #[test]
    fn index_failure_restores_original_bytes_to_history_folder() {
        check_history_replacement(true);
    }

    fn check_history_replacement(fail_index_write: bool) {
        let root = std::env::temp_dir().join(format!(
            "snapshot-history-replacement-{}-{}-{fail_index_write}",
            std::process::id(),
            now_millis()
        ));
        let history = root.join("history");
        let trash_dir = root.join("trash");
        fs::create_dir_all(&history).unwrap();
        let index = history.join("index.json");
        let original = SnapshotRecord {
            id: "original".into(),
            file_name: "original.png".into(),
            app_name: "Example".into(),
            width: 200,
            height: 100,
            size_bytes: 8,
            created_at: 1,
            app_id: None,
        };
        let edited = SnapshotRecord {
            id: "edited".into(),
            file_name: "edited.png".into(),
            width: 80,
            height: 40,
            ..original.clone()
        };
        let original_path = history.join(&original.file_name);
        let edited_path = history.join(&edited.file_name);
        fs::write(&original_path, b"original").unwrap();
        fs::write(&edited_path, b"edited").unwrap();
        if fail_index_write {
            fs::create_dir(&index).unwrap();
        } else {
            write_snapshot_index(&index, std::slice::from_ref(&original)).unwrap();
        }

        let result = update_snapshot_history(&trash_dir, &history, &[original], &[edited]);
        if fail_index_write {
            assert!(result.is_err());
            assert_eq!(fs::read(&original_path).unwrap(), b"original");
            assert_eq!(fs::read_dir(&trash_dir).unwrap().count(), 0);
        } else {
            result.unwrap();
            let archived = fs::read_dir(&trash_dir)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(fs::read(archived.join("file")).unwrap(), b"original");
            assert!(!original_path.exists());
            let active = read_snapshot_index(&index);
            assert_eq!(active.len(), 1);
            assert_eq!(
                (active[0].id.as_str(), active[0].width, active[0].height),
                ("edited", 80, 40)
            );
            assert_eq!(fs::read(&edited_path).unwrap(), b"edited");
        }
        fs::remove_dir_all(root).unwrap();
    }

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
    fn snapshot_record_reads_old_json_without_app_id() {
        // 升级前的索引没有 appId 这一项：缺省 None，不显示角标，其余字段照常读
        let old = r#"{
            "id": "snap-1", "fileName": "snap-1.png", "appName": "Codex",
            "width": 10, "height": 10, "sizeBytes": 5, "createdAt": 1
        }"#;
        let record: SnapshotRecord = serde_json::from_str(old).unwrap();
        assert_eq!(record.app_id, None);
        assert_eq!(record.app_name, "Codex");

        // 新记录带上稳定标识，序列化/反序列化往返不丢；None 不写进 JSON
        let mut fresh = record.clone();
        fresh.app_id = Some("/usr/bin/codex".into());
        let json = serde_json::to_string(&fresh).unwrap();
        assert!(json.contains("\"appId\":\"/usr/bin/codex\""));
        let back: SnapshotRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.app_id.as_deref(), Some("/usr/bin/codex"));
        assert!(!serde_json::to_string(&record).unwrap().contains("appId"));
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
        assert_eq!(thumbnail_size(1920, 1080), (1067, 600));
        // 滚动长截图又窄又长：高度封顶，宽度跟着比例走
        assert_eq!(thumbnail_size(1280, 6400), (120, 600));
        // 超宽屏按宽度封顶
        assert_eq!(thumbnail_size(10000, 1000), (1600, 160));
        // 本来就小的不放大
        assert_eq!(thumbnail_size(120, 90), (120, 90));

        let sample = RgbaImage::from_pixel(32, 24, image::Rgba([24, 96, 200, 255]));
        let bytes = encode_thumbnail_jpeg(&make_thumbnail(&sample)).unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 24));
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
    fn timed_image_write_round_trips_every_supported_format() {
        let image = RgbaImage::from_pixel(3, 2, image::Rgba([200, 100, 50, 128]));
        let trace = CaptureTrace::start();
        for (format, ext) in [
            (ImageFormat::Png, "png"),
            (ImageFormat::Jpeg, "jpg"),
            (ImageFormat::WebP, "webp"),
        ] {
            let path = std::env::temp_dir().join(format!("snapshot-timed-image-test.{ext}"));
            write_image_timed(&image, &path, format, &trace).expect("写盘失败");
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
            app_id: None,
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
    fn legacy_history_migration_keeps_every_record_beyond_the_old_limit() {
        let root = std::env::temp_dir().join(format!(
            "snapshot-history-no-limit-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let legacy = root.join("legacy");
        let destination = root.join("pictures/Snapshot");
        let marker = root.join("app-data/migration-complete");
        let records: Vec<_> = (0..250)
            .map(|index| SnapshotRecord {
                id: format!("snap-{index}"),
                file_name: format!("snap-{index}.png"),
                app_name: "Codex".into(),
                width: 10,
                height: 10,
                size_bytes: 5,
                created_at: index,
                app_id: None,
            })
            .collect();
        fs::create_dir_all(&legacy).unwrap();
        write_snapshot_index(&legacy.join("index.json"), &records).unwrap();

        migrate_legacy_history(&legacy, &destination, &marker).unwrap();

        let restored = read_snapshot_index(&destination.join("index.json"));
        assert_eq!(restored.len(), 250);
        assert_eq!(restored.first().unwrap().id, "snap-249");
        assert_eq!(restored.last().unwrap().id, "snap-0");
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
        assert_eq!(default_history_dir_for_mode(&fallback, true), fallback);
        assert_eq!(default_history_dir_for_mode(&fallback, false), resolved);
    }

    #[test]
    fn corrupt_index_falls_back_to_the_last_valid_backup() {
        let root = std::env::temp_dir().join(format!(
            "snapshot-index-recovery-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let path = root.join("index.json");
        let record = |id: &str, created_at: u64| SnapshotRecord {
            id: id.into(),
            file_name: format!("{id}.png"),
            app_name: id.into(),
            width: 10,
            height: 10,
            size_bytes: 5,
            created_at,
            app_id: None,
        };
        write_snapshot_index(&path, &[record("first", 1)]).unwrap();
        write_snapshot_index(&path, &[record("second", 2)]).unwrap();
        write_snapshot_index(&path, &[record("third", 3)]).unwrap();
        fs::write(&path, b"{").unwrap();

        let recovered = read_snapshot_index(&path);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, "second");
        let _ = fs::remove_dir_all(root);
    }
}
