use super::settings::{default_appearance_id, emit_settings, persist_settings, Settings};
use super::*;
use serde::Deserialize;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetAsset {
    pub(crate) id: String,
    pub(crate) name: String,
    /// 实际读取的文件。新导入的会复制进应用数据目录，旧版导入的仍指向原位置
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) entry: String,
    #[serde(default)]
    pub(crate) animations: Vec<String>,
    /// 作者按语义事件指定的动画
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) event_actions: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) state_actions: HashMap<String, String>,
    /// 导入时用户选的原文件，只做展示
    #[serde(default)]
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) size_bytes: u64,
    #[serde(default)]
    pub(crate) imported_at: u64,
    /// 最近一次被选为伴侣的时间。
    #[serde(default)]
    pub(crate) last_used_at: u64,
    /// 素材文件找不到了（旧版按原路径读取，原文件被移走就会这样）。每次读盘重算
    #[serde(default)]
    pub(crate) missing: bool,
    /// 压缩包里的 pet.json。没有时每个动画都缩进同一个方窗
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) layout: Option<pet_layout::PetLayout>,
}

/// 名字超过这个长度就截断，免得形象架上一行放不下
const PET_NAME_LIMIT: usize = 40;

pub(crate) fn refresh_missing(assets: &mut [PetAsset]) {
    for asset in assets {
        asset.missing = !Path::new(&asset.path).is_file();
    }
}

fn pets_dir(state: &AppState) -> &Path {
    &state.pets_dir
}

// 去底算法升级时，三个派生缓存一起换版本，现有形象也会重新生成。
fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.thumb4.png"))
}

/// 动作名里有斜杠和中文，拿它的哈希（FNV-1a）当文件名
fn fnv(entry: &str) -> u64 {
    entry.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x0100_0000_01b3)
    })
}

/// 走路动作处理后的缓存
fn walk_cache_path(dir: &Path, id: &str, entry: &str) -> PathBuf {
    dir.join(format!("{id}.walk4-{:016x}.gif", fnv(entry)))
}

/// 抠掉背景以后的那份素材
fn key_cache_path(dir: &Path, id: &str, entry: &str) -> PathBuf {
    dir.join(format!("{id}.keyed3-{:016x}.gif", fnv(entry)))
}

fn is_derived_cache_name(name: &str, id: &str) -> bool {
    let Some(suffix) = name
        .strip_prefix(id)
        .and_then(|name| name.strip_prefix('.'))
    else {
        return false;
    };
    if matches!(
        suffix,
        "thumb.png" | "thumb2.png" | "thumb3.png" | "thumb4.png"
    ) {
        return true;
    }
    let Some(animation) = [
        "walk-", "walk2-", "walk3-", "walk4-", "keyed-", "keyed2-", "keyed3-",
    ]
    .iter()
    .find_map(|prefix| suffix.strip_prefix(prefix)) else {
        return false;
    };
    let Some((hash, extension)) = animation.split_once('.') else {
        return false;
    };
    // 只认完整的缓存名和原子写入的临时文件，避免前缀相近的 id 被误删。
    hash.len() == 16
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        && (extension == "gif"
            || extension.strip_prefix("partial").is_some_and(|sequence| {
                !sequence.is_empty() && sequence.bytes().all(|byte| byte.is_ascii_digit())
            }))
}

/// 形象删掉、或者重新导入时，把由它派生出来的缓存一起清掉：
/// 缩略图、走路动作、抠过背景的素材
fn remove_derived_cache(dir: &Path, id: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| is_derived_cache_name(name, id))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 选中后广播、落盘、顺手把桌宠窗口叫出来
fn commit(app: &AppHandle, state: &AppState, settings: &mut Settings) -> Result<Settings, String> {
    refresh_missing(&mut settings.pet_assets);
    persist_settings(&state.settings_path, settings)?;
    let result = settings.clone();
    emit_settings(app, &result);
    Ok(result)
}

#[tauri::command]
pub(crate) fn select_pet_appearance(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Settings, String> {
    let mut settings = state.settings.lock();
    if id != "app-icon" {
        let asset = settings
            .pet_assets
            .iter_mut()
            .find(|asset| asset.id == id)
            .ok_or_else(|| "找不到这个形象".to_string())?;
        if !Path::new(&asset.path).is_file() {
            return Err("这个形象的素材文件找不到了".into());
        }
        asset.last_used_at = now_millis();
    }
    settings.selected_appearance_id = id;
    let result = commit(&app, &state, &mut settings)?;
    show_pet(&app);
    Ok(result)
}

fn show_pet(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    os::refresh_pet_visibility(app);
    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.show();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetImportFailure {
    path: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetImportResult {
    settings: Settings,
    imported: usize,
    failed: Vec<PetImportFailure>,
}

/// 一次导入多个 ZIP / GIF / WebM（对话框多选或拖进窗口）。
///
/// 每个文件复制一份进应用数据目录再用：原先按原路径读取，用户清一次「下载」文件夹，
/// 形象就大面积失效。坏的那几个单独列出原因，不连累其它。
#[tauri::command]
pub(crate) fn add_pet_assets(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<PetImportResult, String> {
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        match prepare_import(&state, &path) {
            Ok(asset) => imported.push(asset),
            Err(reason) => failed.push(PetImportFailure { path, reason }),
        }
    }
    register_imports(&app, &state, imported, failed)
}

fn register_imports(
    app: &AppHandle,
    state: &AppState,
    imported: Vec<PetAsset>,
    failed: Vec<PetImportFailure>,
) -> Result<PetImportResult, String> {
    let count = imported.len();
    let mut settings = state.settings.lock();
    let mut next = settings.clone();
    let new_paths: Vec<_> = imported.iter().map(|asset| asset.path.clone()).collect();
    let mut obsolete = Vec::new();
    let mut updated_ids = Vec::new();
    for asset in imported {
        let id = match next
            .pet_assets
            .iter_mut()
            .find(|existing| !existing.source.is_empty() && existing.source == asset.source)
        {
            // 同一个原文件再导入一次：当作更新，保留名字与 id
            Some(existing) => {
                let old_path = existing.path.clone();
                existing.path = asset.path;
                existing.entry = asset.entry;
                existing.animations = asset.animations;
                existing.layout = asset.layout;
                existing.event_actions = asset.event_actions;
                existing.state_actions = asset.state_actions;
                existing.size_bytes = asset.size_bytes;
                existing.last_used_at = asset.last_used_at;
                if old_path != existing.path {
                    obsolete.push(old_path);
                }
                updated_ids.push(existing.id.clone());
                existing.id.clone()
            }
            None => {
                let id = asset.id.clone();
                next.pet_assets.push(asset);
                id
            }
        };
        next.selected_appearance_id = id;
    }
    // 保存失败时保留原来的设置和素材；不要让一次下载更新破坏已安装的宠物。
    refresh_missing(&mut next.pet_assets);
    if let Err(error) = persist_settings(&state.settings_path, &next) {
        for path in new_paths {
            remove_owned_file(state, &path);
        }
        return Err(error);
    }
    *settings = next.clone();
    for path in obsolete {
        remove_owned_file(state, &path);
    }
    for id in updated_ids {
        remove_derived_cache(pets_dir(state), &id);
    }
    emit_settings(app, &next);
    drop(settings);
    if count > 0 {
        show_pet(app);
    }
    Ok(PetImportResult {
        settings: next,
        imported: count,
        failed,
    })
}

pub(crate) fn import_catalog_asset(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    id: &str,
    name: &str,
) -> Result<Settings, String> {
    let mut asset = prepare_import(state, path)?;
    asset.name = truncate(name, PET_NAME_LIMIT);
    // 稳定的库内身份：重新导入或升级同一只时保留用户的名字与 id。
    asset.source = format!("https://github.com/Maxwilldoit/Pets#{id}");
    register_imports(app, state, vec![asset], vec![]).map(|result| result.settings)
}

/// 校验一个文件、复制进应用目录、读出动作表；还没登记进设置
fn prepare_import(state: &AppState, raw_path: &str) -> Result<PetAsset, String> {
    let canonical =
        fs::canonicalize(raw_path.trim()).map_err(|_| "无法读取这个文件".to_string())?;
    if !canonical.is_file() {
        return Err("请选择一个 ZIP、GIF 或 WebM".into());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let single_animation = matches!(extension.as_str(), "gif" | "webm");
    if extension != "zip" && !single_animation {
        return Err("只支持 ZIP、GIF 或 WebM".into());
    }
    let size_bytes = fs::metadata(&canonical)
        .map_err(|error| error.to_string())?
        .len();
    // 单个动画按单文件的上限算，压缩包按整包算
    let limit = if single_animation { 50 } else { 100 } * 1024 * 1024;
    if size_bytes > limit {
        return Err(if single_animation {
            "动画文件不能超过 50MB".to_string()
        } else {
            "压缩包不能超过 100MB".to_string()
        });
    }
    let animations = find_pet_animation_entries(&canonical)?;
    let entry = animations
        .first()
        .cloned()
        .ok_or_else(|| "这份素材里没有可用动画".to_string())?;
    let manifest = if single_animation {
        None
    } else {
        pet_layout::read_pet_layout(&canonical, &animations)?
    };

    let now = now_millis();
    // 同一毫秒导入多个时靠序号区分
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let id = format!("pet-{now}-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let dir = pets_dir(state);
    fs::create_dir_all(dir).map_err(|error| format!("无法创建素材目录：{error}"))?;
    let stored = dir.join(format!("{id}.{extension}"));
    fs::copy(&canonical, &stored).map_err(|error| format!("复制素材失败：{error}"))?;

    Ok(PetAsset {
        id,
        name: canonical
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|stem| truncate(stem, PET_NAME_LIMIT))
            .unwrap_or_else(|| "伴侣".into()),
        path: stored.to_string_lossy().to_string(),
        entry,
        animations,
        layout: manifest.as_ref().map(|manifest| manifest.layout.clone()),
        event_actions: manifest
            .as_ref()
            .map(|manifest| manifest.event_actions.clone())
            .unwrap_or_default(),
        state_actions: manifest
            .as_ref()
            .map(|manifest| manifest.state_actions.clone())
            .unwrap_or_default(),
        source: canonical.to_string_lossy().to_string(),
        size_bytes,
        imported_at: now,
        last_used_at: now,
        missing: false,
    })
}

/// 只删我们自己复制进来的文件，用户原来的文件不碰
fn remove_owned_file(state: &AppState, path: &str) {
    let path = Path::new(path);
    if path.starts_with(pets_dir(state)) {
        let _ = fs::remove_file(path);
    }
}

/// 窗口为了包住超出基准画布的动作而挪开时，左上角相对平时那个方窗的偏移（物理像素）。
/// 拖动、放大都会触发 Moved，存盘时减掉这段，存下来的仍是方窗的位置。
#[tauri::command]
pub(crate) fn set_pet_frame_shift(state: State<'_, AppState>, x: i32, y: i32) {
    *state.pet_frame_shift.lock() = (x, y);
}

/// 桌宠窗口里的媒体矩形（WebView 的逻辑像素）。Windows 将透明外圈裁出原生窗口区域，
/// 这样点到透明处会穿过桌宠；其它平台保留普通窗口行为。
#[cfg(target_os = "windows")]
fn pet_hitbox_region(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    factor: f64,
    client_width: u32,
    client_height: u32,
) -> Option<(i32, i32, i32, i32)> {
    let finite = [x, y, width, height].into_iter().all(f64::is_finite);
    if client_width == 0
        || client_height == 0
        || !finite
        || factor <= 0.0
        || width <= 0.0
        || height <= 0.0
    {
        return None;
    }
    let width_limit = client_width as i32;
    let height_limit = client_height as i32;
    let content_left = (x * factor).floor() as i32;
    let content_top = (y * factor).floor() as i32;
    let content_right = ((x + width) * factor).ceil() as i32;
    let content_bottom = ((y + height) * factor).ceil() as i32;
    if content_right <= 0
        || content_bottom <= 0
        || content_left >= width_limit
        || content_top >= height_limit
    {
        return None;
    }
    let left = (content_left - 1).clamp(0, width_limit - 1);
    let top = (content_top - 1).clamp(0, height_limit - 1);
    let right = (content_right + 1).clamp(1, width_limit);
    let bottom = (content_bottom + 1).clamp(1, height_limit);
    (right > left && bottom > top).then_some((left, top, right - left, bottom - top))
}

#[tauri::command]
pub(crate) fn set_pet_hitbox(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let factor = window.scale_factor().map_err(|error| error.to_string())?;
        let client = window.inner_size().map_err(|error| error.to_string())?;
        match pet_hitbox_region(x, y, width, height, factor, client.width, client.height) {
            Some((left, top, region_width, region_height)) => {
                crate::os::set_window_region(handle, left, top, region_width, region_height)
            }
            None => crate::os::set_window_region(handle, 0, 0, 0, 0),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, x, y, width, height);
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn rename_pet_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<Settings, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    let mut settings = state.settings.lock();
    let asset = settings
        .pet_assets
        .iter_mut()
        .find(|asset| asset.id == id)
        .ok_or_else(|| "找不到这个形象".to_string())?;
    asset.name = truncate(name, PET_NAME_LIMIT);
    commit(&app, &state, &mut settings)
}

#[tauri::command]
pub(crate) fn delete_pet_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Settings, String> {
    if id == "app-icon" {
        return Err("默认应用图标不可删除".into());
    }
    let mut settings = state.settings.lock();
    let position = settings
        .pet_assets
        .iter()
        .position(|asset| asset.id == id)
        .ok_or_else(|| "找不到这个形象".to_string())?;
    let removed = settings.pet_assets.remove(position);
    remove_owned_file(&state, &removed.path);
    remove_derived_cache(pets_dir(&state), &removed.id);
    if settings.selected_appearance_id == id {
        settings.selected_appearance_id = default_appearance_id();
    }
    commit(&app, &state, &mut settings)
}

/// 形象架上的静态缩略图：默认 GIF 动作的第一帧。WebM 由前端用暂停的视频显示首帧。
/// 几十个动画同时动起来既吵又费电，架子上只放静态帧。
pub(crate) fn read_thumbnail(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let path = thumb_path(pets_dir(state), id);
    if let Ok(bytes) = fs::read(&path) {
        return Ok(bytes);
    }
    let (entry, media) = read_raw_animation(state, id, None)?;
    if is_pet_webm(&entry) {
        return Err("WebM 的首帧由页面中的视频元素读取".into());
    }
    let gif = media;
    pet_walk::validate_gif_budget(&gif)?;
    let frame = image::load_from_memory_with_format(&gif, ImageFormat::Gif)
        .map_err(|_| "读不出这份素材的第一帧".to_string())?
        .to_rgba8();
    let small = image::imageops::thumbnail(
        &frame,
        frame.width().min(200),
        (frame.height() as f64 * frame.width().min(200) as f64 / frame.width().max(1) as f64)
            .round()
            .max(1.0) as u32,
    );
    let png = capture::encode_png(&small)?;
    fs::create_dir_all(pets_dir(state)).map_err(|error| error.to_string())?;
    let _ = fs::write(&path, &png);
    Ok(png)
}

/// 读出某个形象的一段动画（媒体协议用）。不指定动作时取该形象的默认动作。
/// GIF 里画了白底的顺手抠成透明；WebM 保持原始透明视频，不在 Rust 侧重编码。
pub(crate) fn read_animation(
    state: &AppState,
    id: &str,
    entry: Option<&str>,
) -> Result<Vec<u8>, String> {
    let (entry_name, raw) = read_raw_animation(state, id, entry)?;
    if is_pet_webm(&entry_name) {
        return Ok(raw);
    }
    let cache = key_cache_path(pets_dir(state), id, &entry_name);
    if let Ok(bytes) = fs::read(&cache) {
        return Ok(bytes);
    }
    let bytes = match pet_key::key_out(&raw) {
        Ok(Some(keyed)) => keyed,
        Ok(None) => raw,
        Err(error) => {
            eprintln!("snapshot: background left as is ({entry_name}): {error}");
            raw
        }
    };
    // 左右两个方向可能同时来要同一个动作：各写各的临时文件再改名，免得读到或写出半个文件
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let partial = cache.with_extension(format!(
        "partial{}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    if fs::write(&partial, &bytes).is_ok() && fs::rename(&partial, &cache).is_err() {
        let _ = fs::remove_file(&partial);
    }
    Ok(bytes)
}

/// 按动作名把素材原样读出来（压缩包里的条目，或者直接导入的动画），不碰背景。
fn read_raw_animation(
    state: &AppState,
    id: &str,
    entry: Option<&str>,
) -> Result<(String, Vec<u8>), String> {
    let asset = state
        .settings
        .lock()
        .pet_assets
        .iter()
        .find(|asset| asset.id == id)
        .cloned()
        .ok_or_else(|| "找不到这个形象".to_string())?;
    let archive_path = PathBuf::from(&asset.path);
    let requested = entry.filter(|value| !value.is_empty());
    let entry_name = if let Some(requested) = requested {
        // 只认登记过的动作名，不能借路径读压缩包里的任意条目
        if !asset
            .animations
            .iter()
            .any(|candidate| candidate == requested)
        {
            return Err("压缩包内没有这个动画".into());
        }
        requested.to_string()
    } else if asset.entry.is_empty() {
        find_pet_animation_entries(&archive_path)?
            .into_iter()
            .next()
            .ok_or_else(|| "压缩包内没有可预览的形象".to_string())?
    } else {
        asset.entry
    };
    if !is_pet_animation(&entry_name) {
        return Err("这个动作不是 GIF 或 WebM，无法预览".into());
    }
    // 直接导入的动画本身就是素材，没有压缩包可拆
    let bytes = if is_pet_animation(&asset.path) {
        let bytes = fs::read(&archive_path).map_err(|_| "桌宠动画已被移动或删除".to_string())?;
        if bytes.len() > 50 * 1024 * 1024 {
            return Err("桌宠动画不能超过 50MB".into());
        }
        bytes
    } else {
        let file =
            fs::File::open(&archive_path).map_err(|_| "桌宠压缩包已被移动或删除".to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|_| "桌宠压缩包已损坏".to_string())?;
        let mut entry = archive
            .by_name(&entry_name)
            .map_err(|_| "压缩包内的预览动画已丢失".to_string())?;
        if entry.size() > 50 * 1024 * 1024 {
            return Err("桌宠动画不能超过 50MB".into());
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| "读取桌宠动画失败".to_string())?;
        bytes
    };
    Ok((entry_name, bytes))
}

/// 一轮 GIF 的总时长。按浏览器常见的处理方式，把 0 延时帧视为 100ms、
/// 小于 20ms 的帧至少留 20ms；单帧素材则展示 1 秒。
fn gif_duration_ms(bytes: &[u8]) -> Result<u64, String> {
    pet_walk::validate_gif_budget(bytes)?;
    let options = gif::DecodeOptions::new();
    let mut decoder = options
        .read_info(Cursor::new(bytes))
        .map_err(|error| format!("读取 GIF 时长失败：{error}"))?;
    let mut frames = 0u64;
    let mut total = 0u64;
    while let Some(frame) = decoder
        .next_frame_info()
        .map_err(|error| format!("读取 GIF 帧失败：{error}"))?
    {
        frames += 1;
        let delay = u64::from(frame.delay) * 10;
        total += if delay == 0 { 100 } else { delay.max(20) };
    }
    if frames == 0 {
        return Err("GIF 里没有可播放的帧".into());
    }
    Ok(if frames == 1 { 1000 } else { total })
}

/// 前端按一轮动画的时长决定何时回到待机，避免固定 3 秒把长动作截断。
#[tauri::command]
pub(crate) fn pet_animation_duration(
    state: State<'_, AppState>,
    id: String,
    entry: String,
) -> Result<u64, String> {
    let (entry_name, bytes) = read_raw_animation(&state, &id, Some(&entry))?;
    if is_pet_webm(&entry_name) {
        return Err("WebM 时长由前端读取视频元数据".into());
    }
    gif_duration_ms(&bytes)
}

/// 拖动桌宠时播的走路动作（媒体协议用）。横穿画布的改成原地走（见 pet_walk），
/// 结果按动作缓存在素材目录里；本来就原地走、或者处理不了的照用原图，拖动时总有图可播。
pub(crate) fn read_walk(state: &AppState, id: &str, entry: &str) -> Result<Vec<u8>, String> {
    // WebM 已经是透明视频，不再用 GIF 的拆帧/原地化算法；窗口移动本身就能带着它走。
    if is_pet_webm(entry) {
        return read_animation(state, id, Some(entry));
    }
    let cache = walk_cache_path(pets_dir(state), id, entry);
    if let Ok(bytes) = fs::read(&cache) {
        return Ok(bytes);
    }
    // 先按普通动作读一遍：顺带校验这是登记过的动作
    let walk = read_animation(state, id, Some(entry))?;
    let idle = read_animation(state, id, None).unwrap_or_default();
    let bytes = match pet_walk::walk_in_place(&walk, &idle) {
        Ok(Some(converted)) => converted,
        Ok(None) => walk,
        Err(error) => {
            eprintln!("snapshot: walk animation left as is ({entry}): {error}");
            walk
        }
    };
    // 左右两个方向可能同时来要同一个动作：各写各的临时文件再改名，免得读到或写出半个文件
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let partial = cache.with_extension(format!(
        "partial{}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    if fs::write(&partial, &bytes).is_ok() && fs::rename(&partial, &cache).is_err() {
        let _ = fs::remove_file(&partial);
    }
    Ok(bytes)
}

/// 收集一份桌宠素材里可用的动作。
///
/// 传进来的可能是压缩包，也可能是直接导入的单个 GIF / WebM——后者本身就是唯一的动作。
pub(crate) fn find_pet_animation_entries(path: &PathBuf) -> Result<Vec<String>, String> {
    let single_path = path.to_string_lossy();
    if is_pet_animation(&single_path) {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法读取这个动画的文件名".to_string())?;
        return Ok(vec![name.to_string()]);
    }

    let file = fs::File::open(path).map_err(|_| "无法读取桌宠压缩包".to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "桌宠压缩包已损坏".to_string())?;
    let mut found = Vec::new();
    let mut has_webm = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "无法读取桌宠压缩包目录".to_string())?;
        if entry.is_dir() || entry.size() > 50 * 1024 * 1024 {
            continue;
        }
        let name = entry
            .name()
            .map_err(|_| "无法读取桌宠压缩包条目名".to_string())?
            .into_owned();
        let lower = name.to_lowercase();
        if !is_pet_animation(&lower) {
            continue;
        }
        has_webm |= is_pet_webm(&lower);
        // 包根目录下的 idle.gif 没有前导分隔符，单独按文件名判一次，
        // 否则会被当成普通动作排到后面去
        let file_name = lower.rsplit('/').next().unwrap_or(lower.as_str());
        let is_idle = file_name.starts_with("idle")
            || file_name.contains("待机")
            || lower.contains("/idle")
            || lower.contains("_idle")
            || lower.contains("-idle");
        found.push((if is_idle { 0 } else { 1 }, lower, name));
    }
    // DSH 一类包同时含 preview/*.gif 与 webm/*.webm；有 WebM 时跳过预览图，
    // 避免同一个动作出现两遍，也优先使用真正透明的视频版本。
    if has_webm {
        found.retain(|(_, lower, _)| !lower.contains("preview/"));
    }
    found.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| is_pet_webm(&right.1).cmp(&is_pet_webm(&left.1)))
            .then(left.1.cmp(&right.1))
    });
    if found.is_empty() {
        return Err("压缩包内没有 GIF 或 WebM 动画".into());
    }
    Ok(found.into_iter().map(|item| item.2).collect())
}

/// 桌宠静帧动画支持 GIF 与 WebM。
fn is_pet_gif(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|extension| extension.eq_ignore_ascii_case("gif"))
        .unwrap_or(false)
}

fn is_pet_webm(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|extension| extension.eq_ignore_ascii_case("webm"))
        .unwrap_or(false)
}

fn is_pet_animation(path: &str) -> bool {
    is_pet_gif(path) || is_pet_webm(path)
}

/// 媒体协议按真实容器给 Content-Type，不能把 WebM 标成 image/gif。
pub(crate) fn animation_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "video/webm"
    } else {
        "image/gif"
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct CacheTestDir(PathBuf);

    impl CacheTestDir {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "snapshot-pet-cache-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).expect("创建缓存测试目录失败");
            Self(dir)
        }
    }

    impl Drop for CacheTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn derived_cache_paths_bypass_previous_algorithm_outputs() {
        let temp = CacheTestDir::new();
        let dir = &temp.0;
        let id = "pet-7";
        let entry = "动作/走路.gif";
        let hash = fnv(entry);
        let previous = [
            dir.join(format!("{id}.thumb.png")),
            dir.join(format!("{id}.thumb2.png")),
            dir.join(format!("{id}.thumb3.png")),
            dir.join(format!("{id}.walk-{hash:016x}.gif")),
            dir.join(format!("{id}.walk2-{hash:016x}.gif")),
            dir.join(format!("{id}.walk3-{hash:016x}.gif")),
            dir.join(format!("{id}.keyed-{hash:016x}.gif")),
            dir.join(format!("{id}.keyed2-{hash:016x}.gif")),
        ];
        for path in &previous {
            fs::write(path, b"previous algorithm").unwrap();
        }
        let current = [
            (thumb_path(dir, id), dir.join(format!("{id}.thumb4.png"))),
            (
                walk_cache_path(dir, id, entry),
                dir.join(format!("{id}.walk4-{hash:016x}.gif")),
            ),
            (
                key_cache_path(dir, id, entry),
                dir.join(format!("{id}.keyed3-{hash:016x}.gif")),
            ),
        ];
        for (path, expected) in current {
            assert_eq!(path, expected);
            assert_eq!(
                fs::read(&path).unwrap_err().kind(),
                std::io::ErrorKind::NotFound,
                "旧缓存不应命中新算法的路径：{path:?}"
            );
            fs::write(&path, b"current algorithm").unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"current algorithm");
        }
        for path in previous {
            assert_eq!(fs::read(path).unwrap(), b"previous algorithm");
        }
        assert_ne!(
            walk_cache_path(dir, id, entry),
            walk_cache_path(dir, id, "idle.gif")
        );
        assert_ne!(
            key_cache_path(dir, id, entry),
            key_cache_path(dir, id, "idle.gif")
        );
    }

    #[test]
    fn removing_derived_cache_cleans_all_versions_and_partial_files() {
        let temp = CacheTestDir::new();
        let dir = &temp.0;
        let id = "pet-7";
        let mut caches = vec![
            dir.join(format!("{id}.thumb.png")),
            dir.join(format!("{id}.thumb2.png")),
            dir.join(format!("{id}.thumb3.png")),
            dir.join(format!("{id}.thumb4.png")),
        ];
        for entry in ["idle.gif", "动作/走路.gif"] {
            for version in [
                "walk", "walk2", "walk3", "walk4", "keyed", "keyed2", "keyed3",
            ] {
                let path = dir.join(format!("{id}.{version}-{:016x}.gif", fnv(entry)));
                caches.push(path.with_extension("partial0"));
                caches.push(path.with_extension("partial42"));
                caches.push(path);
            }
        }
        for path in &caches {
            fs::write(path, b"stale cache").unwrap();
        }

        remove_derived_cache(dir, id);

        for path in caches {
            assert!(!path.exists(), "应当清理新旧缓存及临时文件：{path:?}");
        }
        assert_eq!(fs::read_dir(dir).unwrap().count(), 0);
        remove_derived_cache(dir, id);
        remove_derived_cache(&dir.join("missing"), id);
    }

    #[test]
    fn removing_derived_cache_preserves_similar_ids_and_non_cache_files() {
        let temp = CacheTestDir::new();
        let dir = &temp.0;
        let id = "pet-7";
        let hash = fnv("idle.gif");
        let mut preserved = vec![
            dir.join(format!("{id}.gif")),
            dir.join(format!("{id}.zip")),
            dir.join(format!("{id}.thumbnail.png")),
            dir.join(format!("{id}.thumb4.png.bak")),
            dir.join(format!("{id}.walk4-{hash:016x}.gif.bak")),
            dir.join(format!("{id}.walk4-{hash:016x}.partial")),
            dir.join(format!("{id}.walk4-{hash:016x}.partial-1")),
            dir.join(format!("{id}.keyed3-{hash:016x}.partial42.bak")),
            dir.join(format!("{id}.keyed3-0123456789abcde.gif")),
            dir.join(format!("{id}.keyed3-0123456789abcdef0.gif")),
            dir.join(format!("{id}.keyed3-0123456789abcdeg.gif")),
        ];
        for sibling in [
            "pet-70",
            "pet-7-extra",
            "pet-7.thumb",
            "pet-7.thumb2",
            "pet-7.thumb3",
            "pet-7.thumb4",
            "pet-7.walk-sibling",
            "pet-7.walk2-sibling",
            "pet-7.walk3-sibling",
            "pet-7.walk4-sibling",
            "pet-7.keyed-sibling",
            "pet-7.keyed2-sibling",
            "pet-7.keyed3-sibling",
        ] {
            preserved.extend([
                dir.join(format!("{sibling}.gif")),
                dir.join(format!("{sibling}.zip")),
                thumb_path(dir, sibling),
                walk_cache_path(dir, sibling, "idle.gif"),
                key_cache_path(dir, sibling, "idle.gif"),
            ]);
        }
        for path in &preserved {
            fs::write(path, b"keep this resource").unwrap();
        }
        let own_cache = thumb_path(dir, id);
        fs::write(&own_cache, b"remove this cache").unwrap();

        remove_derived_cache(dir, id);

        assert!(!own_cache.exists());
        for path in &preserved {
            assert_eq!(
                fs::read(path).unwrap_or_else(|error| panic!("不应误删 {path:?}：{error}")),
                b"keep this resource"
            );
        }
        assert_eq!(fs::read_dir(dir).unwrap().count(), preserved.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(name: &str, entries: &[&str]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("snapshot-pet-test-{name}.zip"));
        let file = fs::File::create(&path).expect("建测试包失败");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for entry in entries {
            writer.start_file(*entry, options).expect("写入条目失败");
            writer.write_all(b"fake-bytes").expect("写入内容失败");
        }
        writer.finish().expect("收尾失败");
        path
    }

    #[test]
    fn gif_and_webm_count_as_pet_assets() {
        assert!(is_pet_animation("a.gif"));
        assert!(is_pet_animation("a.GIF"));
        assert!(is_pet_animation("a.webm"));
        assert!(is_pet_animation("a.WEBM"));
        assert!(!is_pet_animation("a.mp4"));
        assert!(!is_pet_animation("a.webp"));
        assert!(!is_pet_animation("a.png"));
        assert!(!is_pet_animation("noext"));
    }

    #[test]
    fn supported_entries_are_kept_and_idle_comes_first() {
        let path = make_zip(
            "mixed",
            &[
                "cover.png",
                "pose/walk.mp4",
                "pose/walk.gif",
                "pose/idle.gif",
                "pose/wave.webm",
            ],
        );
        let found = find_pet_animation_entries(&path).expect("应当找到动画");
        assert_eq!(
            found,
            vec![
                "pose/idle.gif".to_string(),
                "pose/wave.webm".to_string(),
                "pose/walk.gif".to_string()
            ]
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn idle_at_package_root_is_still_the_default_pose() {
        let path = make_zip("root-idle", &["walk.gif", "idle.gif"]);
        let found = find_pet_animation_entries(&path).expect("应当找到 GIF");
        assert_eq!(found, vec!["idle.gif".to_string(), "walk.gif".to_string()]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_webm_only_package_is_importable() {
        let path = make_zip("video-only", &["cat/idle.mp4", "cat/walk.webm"]);
        assert_eq!(
            find_pet_animation_entries(&path).expect("WebM 应当可用"),
            vec!["cat/walk.webm".to_string()]
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn dsh_preview_gifs_yield_to_webm_and_chinese_idle_is_detected() {
        let path = make_zip(
            "dsh-assets",
            &[
                "assets/preview/daiji-huxi-xiuxian.gif",
                "assets/preview/chi-baifan.gif",
                "assets/webm/吃白饭.webm",
                "assets/webm/待机呼吸休闲.webm",
            ],
        );
        assert_eq!(
            find_pet_animation_entries(&path).expect("DSH 素材应当可用"),
            vec![
                "assets/webm/待机呼吸休闲.webm".to_string(),
                "assets/webm/吃白饭.webm".to_string()
            ]
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_single_gif_file_is_its_own_animation() {
        let path = std::env::temp_dir().join("snapshot-pet-test-single.gif");
        fs::write(&path, b"fake-gif").expect("写测试 GIF 失败");
        let found = find_pet_animation_entries(&path).expect("直接导入的 GIF 应当可用");
        assert_eq!(found, vec!["snapshot-pet-test-single.gif".to_string()]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_single_webm_file_is_its_own_animation() {
        let path = std::env::temp_dir().join("snapshot-pet-test-single.webm");
        fs::write(&path, b"fake-webm").expect("写测试 WebM 失败");
        let found = find_pet_animation_entries(&path).expect("直接导入的 WebM 应当可用");
        assert_eq!(found, vec!["snapshot-pet-test-single.webm".to_string()]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn package_without_any_supported_asset_is_rejected() {
        let path = make_zip("empty", &["readme.txt"]);
        assert!(find_pet_animation_entries(&path).is_err());
    }

    #[test]
    fn an_old_pet_asset_without_layout_still_loads() {
        let asset: PetAsset = serde_json::from_str(
            r#"{"id":"p","name":"n","path":"a.gif","entry":"a.gif","animations":["a.gif"]}"#,
        )
        .expect("旧配置里没有 layout 也应当能读");
        assert!(asset.layout.is_none());
    }

    #[test]
    fn gif_duration_sums_one_full_animation_loop() {
        let mut bytes = Vec::new();
        {
            let palette = [0, 0, 0, 255, 255, 255];
            let mut encoder = gif::Encoder::new(&mut bytes, 1, 1, &palette).unwrap();
            for delay in [5, 12, 0] {
                let mut frame = gif::Frame::from_rgba_speed(1, 1, &mut [255, 255, 255, 255], 10);
                frame.delay = delay;
                encoder.write_frame(&frame).unwrap();
            }
        }
        assert_eq!(gif_duration_ms(&bytes), Ok(50 + 120 + 100));
    }

    #[test]
    fn a_single_frame_gif_stays_visible_long_enough_to_read() {
        let mut bytes = Vec::new();
        {
            let palette = [0, 0, 0, 255, 255, 255];
            let mut encoder = gif::Encoder::new(&mut bytes, 1, 1, &palette).unwrap();
            let frame = gif::Frame::from_rgba_speed(1, 1, &mut [255, 255, 255, 255], 10);
            encoder.write_frame(&frame).unwrap();
        }
        assert_eq!(gif_duration_ms(&bytes), Ok(1000));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pet_hitbox_is_clamped_to_the_current_client_area() {
        assert_eq!(
            pet_hitbox_region(10.0, 20.0, 30.0, 40.0, 2.0, 100, 100),
            Some((19, 39, 62, 61))
        );
        assert_eq!(
            pet_hitbox_region(50.0, 50.0, 100.0, 100.0, 1.0, 100, 100),
            Some((49, 49, 51, 51))
        );
        assert_eq!(
            pet_hitbox_region(100.0, 100.0, 20.0, 20.0, 1.0, 100, 100),
            None
        );
    }
}
