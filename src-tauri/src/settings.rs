use super::polish::{self, PromptTemplate};
use super::{os, AppState};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// 保留旧配置的布局，macOS 不再编译或启动启动台，也不丢弃跨平台配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchpadFolder {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) app_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutBinding {
    pub(crate) action: String,
    pub(crate) accelerator: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetPosition {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

pub(crate) fn default_appearance_id() -> String {
    "app-icon".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) has_api_key: bool,
    pub(crate) templates: Vec<PromptTemplate>,
    pub(crate) active_template_id: String,
    #[serde(default = "default_appearance_id")]
    pub(crate) selected_appearance_id: String,
    #[serde(default)]
    pub(crate) pet_assets: Vec<super::pet::PetAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pet_position: Option<PetPosition>,
    /// 桌宠大小：按屏幕算出的基准大小的百分比，100 就是原来的大小
    #[serde(default = "default_pet_scale")]
    pub(crate) pet_scale: u32,
    /// 空闲时在屏幕底部自由走动。
    #[serde(default)]
    pub(crate) pet_wander: bool,
    /// 空闲时随机播放普通动作。
    #[serde(default)]
    pub(crate) pet_random_actions: bool,
    /// 松开拖拽后落回当前屏幕工作区底部。
    #[serde(default = "default_true")]
    pub(crate) pet_gravity: bool,
    /// 用户把桌宠收起来了：选中的形象保留，只是不显示。旧配置缺省时视为显示。
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) pet_hidden: bool,
    pub(crate) shortcuts: Vec<ShortcutBinding>,
    /// 只由用户手动切换；暂停时释放系统快捷键，但保留所有绑定。
    #[serde(default)]
    pub(crate) shortcuts_paused: bool,
    /// 按「窗口截图」「录屏」快捷键时，在桌宠旁弹出窗口列表；关闭时沿用直接作用于上一个应用。
    #[serde(default)]
    pub(crate) shortcut_pick_window: bool,
    #[serde(default = "default_snapshot_format")]
    pub(crate) snapshot_format: String,
    #[serde(default)]
    pub(crate) save_dir: String,
    /// 录制产物目录。留空则沿用 save_dir，再空则落到「下载」。
    #[serde(default)]
    pub(crate) recording_dir: String,
    #[serde(default = "default_shutter_sound")]
    pub(crate) shutter_sound: String,
    #[serde(default)]
    pub(crate) custom_sound_path: Option<String>,
    #[serde(default)]
    pub(crate) launch_on_boot: bool,
    #[serde(default)]
    pub(crate) include_cursor: bool,
    #[serde(default)]
    pub(crate) record_system_audio: bool,
    #[serde(default)]
    pub(crate) record_microphone: bool,
    /// 启动台顶层顺序，`app:<id>` 或 `folder:<id>`。空的表示还没排过，按名字排。
    #[serde(default)]
    pub(crate) launchpad_order: Vec<String>,
    #[serde(default)]
    pub(crate) launchpad_folders: Vec<LaunchpadFolder>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_true() -> bool {
    true
}

fn default_snapshot_format() -> String {
    "png".into()
}

fn default_shutter_sound() -> String {
    "crisp".into()
}

/// 桌宠大小能调的范围（百分比），和前端 lib/petSize.ts 的 PET_SCALE 一致
const PET_SCALE_RANGE: (u32, u32) = (30, 200);

fn default_pet_scale() -> u32 {
    100
}

fn clamp_pet_scale(value: u32) -> u32 {
    value.clamp(PET_SCALE_RANGE.0, PET_SCALE_RANGE.1)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            model: String::new(),
            has_api_key: false,
            templates: vec![polish::default_template()],
            active_template_id: "builtin-default".into(),
            selected_appearance_id: default_appearance_id(),
            pet_assets: Vec::new(),
            pet_position: None,
            pet_scale: default_pet_scale(),
            pet_wander: false,
            pet_random_actions: false,
            pet_gravity: true,
            pet_hidden: false,
            shortcuts: default_shortcut_bindings(),
            shortcuts_paused: false,
            shortcut_pick_window: false,
            snapshot_format: default_snapshot_format(),
            save_dir: String::new(),
            recording_dir: String::new(),
            shutter_sound: default_shutter_sound(),
            custom_sound_path: None,
            launch_on_boot: false,
            include_cursor: false,
            record_system_audio: false,
            record_microphone: false,
            launchpad_order: Vec::new(),
            launchpad_folders: Vec::new(),
        }
    }
}

/// 本平台支持的全局快捷键动作（由各平台自己声明，如滚动长截图只有 Linux 有），全部未绑定。
fn default_shortcut_bindings() -> Vec<ShortcutBinding> {
    os::SHORTCUT_ACTIONS
        .iter()
        .map(|action| ShortcutBinding {
            action: action.to_string(),
            accelerator: (*action == "prompts").then(|| "CommandOrControl+Shift+P".into()),
        })
        .collect()
}

fn is_supported_action(action: &str) -> bool {
    os::SHORTCUT_ACTIONS.contains(&action)
}

/// 偏好设置的增量补丁：None 表示未发送，可空字段用 Value 区分"没传"和"显式置空"
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreferencesPatch {
    pub(crate) snapshot_format: Option<String>,
    pub(crate) save_dir: Option<String>,
    pub(crate) recording_dir: Option<String>,
    pub(crate) shutter_sound: Option<String>,
    pub(crate) custom_sound_path: Option<serde_json::Value>,
    pub(crate) launch_on_boot: Option<bool>,
    pub(crate) include_cursor: Option<bool>,
    pub(crate) record_system_audio: Option<bool>,
    pub(crate) record_microphone: Option<bool>,
    pub(crate) pet_scale: Option<u32>,
    pub(crate) pet_wander: Option<bool>,
    pub(crate) pet_random_actions: Option<bool>,
    pub(crate) pet_gravity: Option<bool>,
    pub(crate) shortcut_pick_window: Option<bool>,
}

pub(crate) fn read_settings(path: &PathBuf) -> Settings {
    let mut settings = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default();
    settings.has_api_key = polish::has_api_key();
    if settings.templates.is_empty() {
        settings.templates = Settings::default().templates;
        settings.active_template_id = "builtin-default".into();
    }
    // 只保留本平台支持的动作：旧版的「打开录制目录」、Win/mac 上残留的滚动长截图都在这里
    // 去掉。前端直接渲染这份列表，不必再自己猜平台。
    settings
        .shortcuts
        .retain(|item| is_supported_action(&item.action));
    // 老配置里没有后来新增的动作（如 fullscreen）。其余已有绑定原样保留，
    // 缺的追加到末尾；平台不支持的动作（如 Win/mac 的 scrolling）不补。
    for mut fallback in default_shortcut_bindings() {
        if !settings
            .shortcuts
            .iter()
            .any(|item| item.action == fallback.action)
        {
            // 不把新动作的默认键插到用户已经占用的同一个键上。
            if fallback.accelerator.as_deref().is_some_and(|key| {
                settings
                    .shortcuts
                    .iter()
                    .any(|item| item.accelerator.as_deref() == Some(key))
            }) {
                fallback.accelerator = None;
            }
            settings.shortcuts.push(fallback);
        }
    }
    let mut backfilled_action_bounds = false;
    for asset in &mut settings.pet_assets {
        if asset.animations.is_empty() {
            if let Ok(animations) =
                super::pet::find_pet_animation_entries(&PathBuf::from(&asset.path))
            {
                asset.animations = animations;
            }
        }
        if !asset.animations.is_empty()
            && !asset.animations.iter().any(|entry| entry == &asset.entry)
        {
            asset.entry = asset.animations[0].clone();
        }
        let gif_count = asset
            .animations
            .iter()
            .filter(|entry| entry.to_ascii_lowercase().ends_with(".gif"))
            .count();
        if asset.action_bounds.is_empty() && gif_count > 0 && PathBuf::from(&asset.path).is_file() {
            if let Ok(bounds) =
                super::pet::read_gif_action_bounds(&PathBuf::from(&asset.path), &asset.animations)
            {
                if !bounds.is_empty() {
                    asset.action_bounds = bounds;
                    backfilled_action_bounds = true;
                }
            }
        }
        if (asset.layout.is_none() || asset.behavior.is_none())
            && asset.path.to_ascii_lowercase().ends_with(".zip")
            && PathBuf::from(&asset.path).is_file()
        {
            if let Ok(Some(manifest)) =
                super::pet_layout::read_pet_layout(&PathBuf::from(&asset.path), &asset.animations)
            {
                if asset.layout.is_none() {
                    asset.layout = Some(manifest.layout);
                    backfilled_action_bounds = true;
                }
                if asset.event_actions.is_empty() && !manifest.event_actions.is_empty() {
                    asset.event_actions = manifest.event_actions;
                    backfilled_action_bounds = true;
                }
                if asset.state_actions.is_empty() && !manifest.state_actions.is_empty() {
                    asset.state_actions = manifest.state_actions;
                    backfilled_action_bounds = true;
                }
                if asset.behavior.is_none() && manifest.behavior.is_some() {
                    asset.behavior = manifest.behavior;
                    backfilled_action_bounds = true;
                }
            }
        }
    }
    super::pet::refresh_missing(&mut settings.pet_assets);
    // 手改过配置文件、写了范围外的值：按边界算
    settings.pet_scale = clamp_pet_scale(settings.pet_scale);
    if settings.selected_appearance_id != "app-icon"
        && !settings
            .pet_assets
            .iter()
            .any(|asset| asset.id == settings.selected_appearance_id)
    {
        settings.selected_appearance_id = default_appearance_id();
    }
    if backfilled_action_bounds {
        // Persist the one-time decode so startup does not remeasure every old GIF package.
        let _ = persist_settings(path, &settings);
    }
    settings
}

pub(crate) fn persist_settings(path: &PathBuf, settings: &Settings) -> Result<(), String> {
    static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let mut stored = settings.clone();
    stored.has_api_key = false;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "设置文件路径缺少文件名".to_string())?;
    // 同目录临时文件完整写入并同步后才替换原配置，失败时不破坏原文件。
    let (temp_path, mut temp_file) = loop {
        let mut temp_name = file_name.to_os_string();
        temp_name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let temp_path = path.with_file_name(temp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => break (temp_path, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    };
    let result = temp_file
        .write_all(json.as_bytes())
        .and_then(|_| temp_file.sync_all());
    drop(temp_file);
    let result = result.and_then(|_| fs::rename(&temp_path, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(|error| error.to_string())
}

pub(crate) fn emit_settings<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let _ = app.emit("settings-changed", settings);
}

#[tauri::command]
pub(crate) fn load_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().clone()
}

#[tauri::command]
pub(crate) async fn save_shortcuts(
    app: AppHandle,
    shortcuts: Vec<ShortcutBinding>,
) -> Result<Settings, String> {
    let shortcuts = shortcuts
        .into_iter()
        .filter(|item| is_supported_action(&item.action))
        .collect::<Vec<_>>();
    super::shortcuts::validate(&shortcuts)?;
    super::shortcuts::save_bindings(app, shortcuts).await
}

fn apply_patch_fields(target: &mut Settings, prefs: &PreferencesPatch) -> Result<(), String> {
    if let Some(value) = prefs.snapshot_format.as_ref() {
        target.snapshot_format = value.clone();
    }
    if let Some(value) = prefs.save_dir.as_ref() {
        target.save_dir = value.clone();
    }
    if let Some(value) = prefs.recording_dir.as_ref() {
        target.recording_dir = value.clone();
    }
    if let Some(value) = prefs.shutter_sound.as_ref() {
        target.shutter_sound = value.clone();
    }
    if let Some(value) = prefs.custom_sound_path.as_ref() {
        // 只能清空或原样回传；换音效要走 import_custom_sound，免得把任意路径塞进媒体协议
        match value.as_str() {
            None => target.custom_sound_path = None,
            Some(path) if target.custom_sound_path.as_deref() == Some(path) => {}
            Some(_) => return Err("请用「导入」选择音效文件".into()),
        }
    }
    if let Some(value) = prefs.launch_on_boot {
        target.launch_on_boot = value;
    }
    if let Some(value) = prefs.include_cursor {
        target.include_cursor = value;
    }
    if let Some(value) = prefs.record_system_audio {
        target.record_system_audio = value;
    }
    if let Some(value) = prefs.record_microphone {
        target.record_microphone = value;
    }
    if let Some(value) = prefs.pet_scale {
        target.pet_scale = clamp_pet_scale(value);
    }
    if let Some(value) = prefs.pet_wander {
        target.pet_wander = value;
    }
    if let Some(value) = prefs.pet_random_actions {
        target.pet_random_actions = value;
    }
    if let Some(value) = prefs.pet_gravity {
        target.pet_gravity = value;
    }
    if let Some(value) = prefs.shortcut_pick_window {
        target.shortcut_pick_window = value;
    }
    Ok(())
}

pub(crate) fn apply_preferences_patch(
    app: &AppHandle,
    state: &AppState,
    prefs: PreferencesPatch,
) -> Result<Settings, String> {
    let (previous_autostart, next_autostart, autostart_changed) = {
        let current = state.settings.lock();
        let mut preview = current.clone();
        apply_patch_fields(&mut preview, &prefs)?;
        let changed =
            prefs.launch_on_boot.is_some() && preview.launch_on_boot != current.launch_on_boot;
        (current.launch_on_boot, preview.launch_on_boot, changed)
    };

    if autostart_changed {
        // 只在显式改动时写系统启动项，默认不装；取消即删除。不在锁内执行外部 I/O。
        os::apply_autostart(next_autostart)?;
    }

    let committed = {
        let mut settings = state.settings.lock();
        let mut next = settings.clone();
        if let Err(error) = apply_patch_fields(&mut next, &prefs)
            .and_then(|()| persist_settings(&state.settings_path, &next))
        {
            drop(settings);
            if autostart_changed {
                let _ = os::apply_autostart(previous_autostart);
            }
            return Err(error);
        }
        *settings = next.clone();
        next
    };

    if prefs.launch_on_boot.is_some() {
        if let Some(item) = state.autostart_item.lock().as_ref() {
            let _ = item.set_checked(committed.launch_on_boot);
        }
    }
    emit_settings(app, &committed);
    Ok(committed)
}

#[tauri::command]
pub(crate) async fn save_preferences(
    app: AppHandle,
    prefs: PreferencesPatch,
) -> Result<Settings, String> {
    super::on_worker(app, move |app, state| {
        apply_preferences_patch(app, state, prefs)
    })
    .await
}

const SOUND_EXTENSIONS: [&str; 4] = ["mp3", "wav", "ogg", "m4a"];
const SOUND_SIZE_LIMIT: u64 = 20 * 1024 * 1024;

/// 导入的快门声复制一份进应用数据目录，之后只播这份：原文件挪走、删掉都不受影响，
/// 媒体协议也只需放行这个目录里的文件。
pub(crate) fn store_custom_sound(sounds_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| SOUND_EXTENSIONS.contains(&ext.as_str()))
        .ok_or_else(|| "只支持 MP3、WAV、OGG、M4A 音效".to_string())?;
    let meta = fs::metadata(source).map_err(|_| "音效文件已被移动或删除".to_string())?;
    if !meta.is_file() {
        return Err("音效文件已被移动或删除".into());
    }
    fs::create_dir_all(sounds_dir).map_err(|error| format!("无法保存音效：{error}"))?;
    let target = sounds_dir.join(format!("shutter-{}.{ext}", super::now_millis()));
    let partial = target.with_extension("partial");
    fs::copy(source, &partial)
        .and_then(|_| fs::rename(&partial, &target))
        .map_err(|error| {
            let _ = fs::remove_file(&partial);
            format!("无法保存音效：{error}")
        })?;
    // 只留当前这一份
    if let Ok(entries) = fs::read_dir(sounds_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != target {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(target)
}

/// 设置里的音效是不是应用自己目录里的那份（媒体协议只放行这种）
pub(crate) fn is_stored_sound(sounds_dir: &Path, path: &str) -> bool {
    let path = Path::new(path);
    path.parent() == Some(sounds_dir)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("shutter-"))
}

/// 老版本直接记了原文件路径：启动时复制一份进来，复制不了（原文件已不在）就保持原样。
pub(crate) fn adopt_custom_sound(settings: &mut Settings, sounds_dir: &Path) -> bool {
    let Some(path) = settings.custom_sound_path.clone() else {
        return false;
    };
    if is_stored_sound(sounds_dir, &path) {
        return false;
    }
    match store_custom_sound(sounds_dir, Path::new(&path)) {
        Ok(stored) => {
            settings.custom_sound_path = Some(stored.to_string_lossy().into_owned());
            true
        }
        Err(error) => {
            eprintln!("snapshot: custom sound left in place ({path}): {error}");
            false
        }
    }
}

#[tauri::command]
pub(crate) async fn import_custom_sound(app: AppHandle, path: String) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 上限只管新导入的；老设置里已经在用的那份不管多大都照搬，免得升级后快门声没了
        if fs::metadata(&path).is_ok_and(|meta| meta.len() > SOUND_SIZE_LIMIT) {
            return Err("音效文件太大（上限 20 MB）".into());
        }
        let stored = store_custom_sound(&state.sounds_dir, Path::new(&path))?;
        let mut settings = state.settings.lock();
        settings.shutter_sound = "custom".into();
        settings.custom_sound_path = Some(stored.to_string_lossy().into_owned());
        persist_settings(&state.settings_path, &settings)?;
        let result = settings.clone();
        emit_settings(&app, &result);
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SettingsTestDir(PathBuf);

    impl SettingsTestDir {
        fn new(label: &str) -> Self {
            static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "snapshot-settings-{label}-{}-{}",
                    std::process::id(),
                    DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("创建设置测试目录失败：{error}"),
                }
            }
        }

        fn assert_only_settings_file(&self) {
            let files = fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            assert_eq!(files, vec![self.0.join("settings.json")]);
        }
    }

    impl Drop for SettingsTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.0.join("settings.json"));
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn old_settings_without_pet_scale_use_the_default_size() {
        let json = r#"{"baseUrl":"","model":"","templates":[],"activeTemplateId":"builtin-default","shortcuts":[]}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.pet_scale, 100);
        assert!(!settings.pet_wander);
        assert!(!settings.pet_random_actions);
        assert!(settings.pet_gravity);
        assert!(!settings.pet_hidden);
        assert!(!settings.shortcuts_paused);
    }

    #[test]
    fn hidden_pet_survives_settings_reload() {
        let path =
            std::env::temp_dir().join(format!("snapshot-hidden-pet-{}.json", std::process::id()));
        let settings = Settings {
            pet_hidden: true,
            ..Default::default()
        };
        persist_settings(&path, &settings).unwrap();
        let reloaded = read_settings(&path);
        assert!(reloaded.pet_hidden);
        assert_eq!(reloaded.selected_appearance_id, "app-icon");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn old_gif_assets_gain_complete_action_bounds_when_settings_load() {
        let directory = SettingsTestDir::new("pet-bounds");
        let zip_path = directory.0.join("old-pet.zip");
        let mut gif_bytes = Vec::new();
        {
            let palette = [0, 0, 0, 255, 0, 0];
            let mut encoder = gif::Encoder::new(&mut gif_bytes, 4, 4, &palette).unwrap();
            for (x, y) in [(1, 1), (2, 2)] {
                let mut pixels = vec![0; 16];
                pixels[y * 4 + x] = 1;
                let mut frame = gif::Frame::from_palette_pixels(4, 4, pixels, palette, Some(0));
                frame.delay = 10;
                frame.dispose = gif::DisposalMethod::Background;
                encoder.write_frame(&frame).unwrap();
            }
        }
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut archive = zip::ZipWriter::new(file);
            archive
                .start_file("idle.gif", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut archive, &gif_bytes).unwrap();
            archive.finish().unwrap();
        }
        let settings = Settings {
            pet_assets: vec![super::super::pet::PetAsset {
                id: "old".into(),
                name: "old".into(),
                path: zip_path.to_string_lossy().into(),
                entry: "idle.gif".into(),
                animations: vec!["idle.gif".into()],
                event_actions: Default::default(),
                state_actions: Default::default(),
                behavior: None,
                source: String::new(),
                size_bytes: 0,
                imported_at: 0,
                last_used_at: 0,
                missing: false,
                layout: None,
                action_bounds: Default::default(),
            }],
            ..Default::default()
        };
        let settings_path = directory.0.join("settings.json");
        persist_settings(&settings_path, &settings).unwrap();

        let reloaded = read_settings(&settings_path);
        let shape = &reloaded.pet_assets[0].action_bounds["idle.gif"];
        assert_eq!((shape.width, shape.height), (4, 4));
        assert_eq!(shape.bounds.left, 0.25);
        assert_eq!(shape.bounds.top, 0.25);

        fs::remove_file(zip_path).unwrap();
    }

    #[test]
    fn read_settings_backfills_missing_zip_manifest_layout_and_behavior() {
        let directory = SettingsTestDir::new("pet-manifest-backfill");
        let zip_path = directory.0.join("whale.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            archive.start_file("idle.webm", options).unwrap();
            std::io::Write::write_all(&mut archive, b"webm").unwrap();
            archive.start_file("drag.webm", options).unwrap();
            std::io::Write::write_all(&mut archive, b"webm").unwrap();
            archive.start_file("tap.webm", options).unwrap();
            std::io::Write::write_all(&mut archive, b"webm").unwrap();
            archive.start_file("pet.json", options).unwrap();
            std::io::Write::write_all(
                &mut archive,
                br#"{
                  "version": 1,
                  "base": { "width": 640, "height": 360, "anchor": [320, 330] },
                  "animations": { "idle.webm": { "anchor": [320, 330] } },
                  "events": { "capture.success": "tap.webm" },
                  "behavior": {
                    "id": "dsh-pet",
                    "referenceWidth": 462,
                    "weights": { "idle": 10, "turn": 0, "move": 0, "action": 0 },
                    "idle": ["idle.webm"],
                    "clicks": ["tap.webm"],
                    "drag": ["drag.webm"]
                  }
                }"#,
            )
            .unwrap();
            archive.finish().unwrap();
        }
        let settings = Settings {
            pet_assets: vec![super::super::pet::PetAsset {
                id: "whale".into(),
                name: "大肥鱼".into(),
                path: zip_path.to_string_lossy().into(),
                entry: "idle.webm".into(),
                animations: vec!["idle.webm".into(), "drag.webm".into(), "tap.webm".into()],
                event_actions: Default::default(),
                state_actions: Default::default(),
                behavior: None,
                source: String::new(),
                size_bytes: 0,
                imported_at: 0,
                last_used_at: 0,
                missing: false,
                layout: None,
                action_bounds: Default::default(),
            }],
            ..Default::default()
        };
        let settings_path = directory.0.join("settings.json");
        persist_settings(&settings_path, &settings).unwrap();

        let reloaded = read_settings(&settings_path);
        let asset = &reloaded.pet_assets[0];
        assert_eq!(
            asset.layout.as_ref().map(|l| (l.base_width, l.base_height)),
            Some((640, 360))
        );
        assert_eq!(
            asset
                .event_actions
                .get("capture.success")
                .map(String::as_str),
            Some("tap.webm")
        );
        assert!(asset.behavior.is_some());

        fs::remove_file(zip_path).unwrap();
    }

    #[test]
    fn manual_shortcut_pause_survives_settings_reload() {
        let path = std::env::temp_dir().join(format!(
            "snapshot-paused-shortcuts-{}.json",
            std::process::id()
        ));
        let settings = Settings {
            shortcuts_paused: true,
            ..Default::default()
        };
        persist_settings(&path, &settings).unwrap();
        assert!(read_settings(&path).shortcuts_paused);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn atomic_repeated_replacement_preserves_paused_settings() {
        let directory = SettingsTestDir::new("replace");
        let path = directory.0.join("settings.json");
        let mut settings = Settings {
            model: "original model".repeat(100),
            has_api_key: true,
            ..Default::default()
        };
        persist_settings(&path, &settings).unwrap();

        settings.shortcuts_paused = true;
        for model in ["short", "a longer replacement model", "final"] {
            settings.model = model.into();
            persist_settings(&path, &settings).unwrap();
            let stored: Settings = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert!(stored.shortcuts_paused);
            assert_eq!(stored.model, model);
            assert!(!stored.has_api_key);
            directory.assert_only_settings_file();
        }
    }

    #[cfg(windows)]
    #[test]
    fn failed_atomic_rename_preserves_locked_settings_and_cleans_temp_file() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = SettingsTestDir::new("locked");
        let path = directory.0.join("settings.json");
        let mut settings = Settings {
            model: "original model".into(),
            shortcuts_paused: true,
            ..Default::default()
        };
        persist_settings(&path, &settings).unwrap();
        let original = fs::read(&path).unwrap();
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        settings.model = "replacement model".into();
        settings.shortcuts_paused = false;
        assert!(persist_settings(&path, &settings).is_err());
        directory.assert_only_settings_file();
        drop(locked);

        let retained = fs::read(&path).unwrap();
        assert_eq!(retained, original);
        let stored: Settings = serde_json::from_slice(&retained).unwrap();
        assert!(stored.shortcuts_paused);
        assert_eq!(stored.model, "original model");
    }

    #[test]
    fn pet_scale_is_kept_within_its_range() {
        assert_eq!(clamp_pet_scale(10), 30);
        assert_eq!(clamp_pet_scale(150), 150);
        assert_eq!(clamp_pet_scale(300), 200);
    }

    #[test]
    fn custom_sound_is_copied_in_and_old_paths_are_adopted_once() {
        let root = std::env::temp_dir().join(format!(
            "snapshot-sound-{}-{}",
            std::process::id(),
            super::super::now_millis()
        ));
        let sounds = root.join("sounds");
        fs::create_dir_all(&root).unwrap();
        let original = root.join("Shutter.WAV");
        fs::write(&original, b"RIFF").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();

        assert!(store_custom_sound(&sounds, &root.join("notes.txt")).is_err());
        assert!(store_custom_sound(&sounds, &root.join("gone.mp3")).is_err());

        let mut settings = Settings {
            custom_sound_path: Some(original.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        assert!(!is_stored_sound(
            &sounds,
            settings.custom_sound_path.as_deref().unwrap()
        ));
        assert!(adopt_custom_sound(&mut settings, &sounds));
        let stored = settings.custom_sound_path.clone().unwrap();
        assert!(is_stored_sound(&sounds, &stored));
        assert!(stored.ends_with(".wav"));
        assert_eq!(fs::read(&stored).unwrap(), b"RIFF");
        assert!(!adopt_custom_sound(&mut settings, &sounds));

        let escaped = sounds.join("..").join("Shutter.WAV");
        assert!(!is_stored_sound(&sounds, &escaped.to_string_lossy()));

        let mut missing = Settings {
            custom_sound_path: Some(root.join("gone.mp3").to_string_lossy().into_owned()),
            ..Settings::default()
        };
        assert!(!adopt_custom_sound(&mut missing, &sounds));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shortcut_pick_window_defaults_off_and_updates_via_patch() {
        let mut settings = Settings::default();
        assert!(!settings.shortcut_pick_window);
        apply_patch_fields(
            &mut settings,
            &PreferencesPatch {
                shortcut_pick_window: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(settings.shortcut_pick_window);
        let json = serde_json::to_string(&settings).unwrap();
        let reloaded: Settings = serde_json::from_str(&json).unwrap();
        assert!(reloaded.shortcut_pick_window);
    }
}
