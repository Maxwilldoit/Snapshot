mod actions;
mod activity;
mod capabilities;
mod capture;
mod capture_timing;
mod clipboard;
mod launchpad;
mod launchpad_cache;
mod media;
mod pet;
mod pet_catalog;
mod pet_key;
mod pet_layout;
mod pet_walk;
mod polish;
mod prompt_history;
mod prompt_library;
mod recording;
mod settings;
mod shortcuts;
mod snapshots;
mod tracker;

// 三端各一套原生实现（os/windows、os/macos、os/linux），对外提供同名的一组函数：
// 录制、带光标截图、还原最小化、开机自启、取图标、打开文件夹、本机能力、
// 支持的快捷键动作。共享代码只写 `os::xxx`，不再到处 #[cfg]；
// 某一端少实现了哪个，那一端的编译直接报错，而不是运行时才发现。
#[cfg(target_os = "windows")]
#[path = "os/windows/mod.rs"]
mod os;
#[cfg(target_os = "macos")]
#[path = "os/macos/mod.rs"]
mod os;
#[cfg(target_os = "linux")]
#[path = "os/linux/mod.rs"]
mod os;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
compile_error!("应用快照只支持 Windows、macOS 和 Linux");

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use image::{ImageFormat, RgbaImage};
use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::HashMap,
    ffi::OsStr,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WindowEvent,
};
use xcap::{Monitor, Window};

struct AppState {
    settings_path: PathBuf,
    snapshots_dir: PathBuf,
    /// 快照缩略图，放在应用数据目录，不往用户选的保存目录里塞东西
    thumbs_dir: PathBuf,
    /// 导入时复制进来的伴侣素材与它们的缩略图
    pets_dir: PathBuf,
    activity: Mutex<activity::ActivityLog>,
    prompt_history: Mutex<prompt_history::PromptHistory>,
    saved_prompts: Mutex<prompt_library::PromptLibrary>,
    pet_catalog_cache: pet_catalog::PetCatalogCache,
    /// 剪贴板里是不是我们放的图、多久后清
    clipboard: Mutex<Option<clipboard::ClipboardState>>,
    /// 每放一次图、每次手动清空/取消都加一，让过期的清空线程自己作废
    clipboard_generation: AtomicU64,
    settings: Mutex<settings::Settings>,
    tracker: Arc<Mutex<tracker::TrackerState>>,
    recorder: Mutex<recording::Recorder>,
    pet_position_revision: AtomicU64,
    /// 窗口移动很密集（自由走动时每帧一次），只留一个延迟落盘任务。
    pet_position_persist_pending: AtomicBool,
    /// 放大去容纳超出基准画布的动作时，窗口左上角相对平时那个方窗的偏移（物理像素）。
    /// 存位置时减掉它，下次启动仍从方窗的位置摆。
    pet_frame_shift: Mutex<(i32, i32)>,
    quick_menu_anchor: Mutex<Option<(f64, f64)>>,
    quick_menu_pending_show: AtomicBool,
    /// 标注窗口待编辑 PNG（RGBA 编码前的原始 PNG 字节）
    annotate_png: Mutex<Option<Vec<u8>>>,
    annotate_title: Mutex<String>,
    /// 启动时没能注册上的全局快捷键，等主窗口加载后再提示用户
    shortcut_conflicts: Mutex<Vec<String>>,
    /// 系统里实际注册成功的键；释放失败时保留，供下次操作重试。
    shortcut_registrations: Mutex<Vec<String>>,
    shortcut_pause_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    tray_open_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    tray_quit_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    launch_catalog: launchpad_cache::CatalogCache,
    launch_icons: Mutex<HashMap<String, Vec<u8>>>,
    /// 快照索引的读改写必须原子化；否则并发截图会互相覆盖历史记录。
    snapshot_index_lock: Mutex<()>,
}

static INTERFACE_ENGLISH: AtomicBool = AtomicBool::new(false);
pub(crate) const AUTOSTART_ARG: &str = "--autostart";

pub(crate) fn interface_is_english() -> bool {
    INTERFACE_ENGLISH.load(Ordering::Relaxed)
}

pub(crate) fn ui_text(zh: &'static str, en: &'static str) -> &'static str {
    if interface_is_english() {
        en
    } else {
        zh
    }
}

/// 桌宠窗口左上角的 y 上限：窗口底边最多贴到工作区底边，也就是任务栏上沿。
fn pet_top_limit(work_area_bottom: i32, window_height: i32) -> i32 {
    work_area_bottom - window_height.max(0)
}

fn should_show_main_window(started_at_login: bool, tray_available: bool) -> bool {
    !started_at_login || !tray_available
}

pub(crate) fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.into();
    }
    value.chars().take(max).collect::<String>() + "…"
}

fn json_backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

fn atomic_write_bytes(path: &Path, payload: &[u8]) -> Result<(), String> {
    static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| "数据文件路径缺少文件名".to_string())?;
    let (temporary, mut file) = loop {
        let mut name = file_name.to_os_string();
        name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let candidate = path.with_file_name(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    };
    use std::io::Write;
    let result = file.write_all(payload).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

/// 写入 JSON 前保留上一份可解析的版本。替换本身通过同目录临时文件完成，
/// 避免进程中断后只留下半截文件。
pub(crate) fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if let Ok(previous) = fs::read(path) {
        if serde_json::from_slice::<Value>(&previous).is_ok() {
            if let Err(error) = atomic_write_bytes(&json_backup_path(path), &previous) {
                eprintln!(
                    "snapshot: could not preserve backup for {}: {error}",
                    path.display()
                );
            }
        }
    }
    atomic_write_bytes(path, &payload)
}

/// 主文件损坏时读取上一份有效备份，避免把历史静默显示为空。
pub(crate) fn read_json_with_backup<T: DeserializeOwned>(path: &Path) -> Option<T> {
    if let Ok(bytes) = fs::read(path) {
        if let Ok(value) = serde_json::from_slice(&bytes) {
            return Some(value);
        }
    }
    let backup = json_backup_path(path);
    let bytes = fs::read(&backup).ok()?;
    let value = serde_json::from_slice(&bytes).ok()?;
    eprintln!(
        "snapshot: recovered {} from {}",
        path.display(),
        backup.display()
    );
    Some(value)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// WebKitGTK、窗口捕获和托盘会在不同线程里使用 Xlib；未在第一次调用前开启线程支持时，
/// Ubuntu 22.04 的无头启动会在渲染几帧后触发 xcb 的多线程断言。
#[cfg(target_os = "linux")]
fn init_x11_threads() {
    if let Ok(xlib) = x11_dl::xlib::Xlib::open() {
        // SAFETY: XInitThreads only enables the library's global locking and must run first.
        unsafe {
            (xlib.XInitThreads)();
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn init_x11_threads() {}

pub fn run() {
    init_x11_threads();
    let started_at_login = std::env::args_os().any(|arg| arg == OsStr::new(AUTOSTART_ARG));
    // 配置文件里定义的窗口在 setup() 之前就已创建并开始加载前端，
    // 若把 manage() 留在 setup() 里，前端可能抢先发出命令并撞上
    // "state not managed"。所以状态提到 Builder 阶段准备好。
    //
    // 路径这里自己算：Tauri 的 app_config_dir()/app_data_dir() 实现就是
    // dirs::config_dir()/dirs::data_dir() 再拼 bundle identifier，
    // 标识符从 context 取，和 tauri.conf.json 保持同源，不会写死漂移。
    let context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    let settings_path = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(&identifier)
        .join("settings.json");
    let data_dir = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(&identifier);
    let legacy_snapshots_dir = data_dir.join("snapshots");
    let snapshots_dir = snapshots::default_history_dir(&legacy_snapshots_dir);
    let thumbs_dir = data_dir.join("thumbs");
    let pets_dir = data_dir.join("pets");
    let activity_path = settings_path.with_file_name("activity.json");
    let prompt_history_path = data_dir.join("prompt-history.json");
    let saved_prompts_path = data_dir.join("saved-prompts.json");
    let settings = settings::read_settings(&settings_path);
    if settings.save_dir.trim().is_empty() {
        let migration_marker = data_dir.join("snapshot-history-migrated");
        if let Err(error) = snapshots::migrate_legacy_history(
            &legacy_snapshots_dir,
            &snapshots_dir,
            &migration_marker,
        ) {
            eprintln!("snapshot: could not migrate snapshot history: {error}");
        }
    }

    tauri::Builder::default()
        // 必须第一个注册：WebView2 的用户数据目录是独占锁，
        // 第二个实例抢不到就会静默退出（用户看到的是"双击没反应"）。
        // 交给这个插件拦下来，改成把已有窗口唤到前台。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            actions::focus_existing_window(app);
        }))
        .plugin(shortcuts::plugin())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, media::handle)
        .manage(AppState {
            settings_path,
            snapshots_dir,
            thumbs_dir,
            pets_dir,
            activity: Mutex::new(activity::ActivityLog::load(activity_path)),
            prompt_history: Mutex::new(prompt_history::PromptHistory::load(prompt_history_path)),
            saved_prompts: Mutex::new(prompt_library::PromptLibrary::load(saved_prompts_path)),
            pet_catalog_cache: pet_catalog::PetCatalogCache::new(data_dir.join("pet-catalog.json")),
            clipboard: Mutex::new(None),
            clipboard_generation: AtomicU64::new(0),
            settings: Mutex::new(settings),
            tracker: Arc::new(Mutex::new(tracker::TrackerState::default())),
            recorder: Mutex::new(recording::Recorder::default()),
            pet_position_revision: AtomicU64::new(0),
            pet_position_persist_pending: AtomicBool::new(false),
            pet_frame_shift: Mutex::new((0, 0)),
            quick_menu_anchor: Mutex::new(None),
            quick_menu_pending_show: AtomicBool::new(false),
            annotate_png: Mutex::new(None),
            annotate_title: Mutex::new(String::new()),
            shortcut_conflicts: Mutex::new(Vec::new()),
            shortcut_registrations: Mutex::new(Vec::new()),
            shortcut_pause_item: Mutex::new(None),
            tray_open_item: Mutex::new(None),
            tray_quit_item: Mutex::new(None),
            launch_catalog: launchpad_cache::CatalogCache::new(
                data_dir.join("launchpad-catalog.json"),
            ),
            launch_icons: Mutex::new(HashMap::new()),
            snapshot_index_lock: Mutex::new(()),
        })
        .setup(move |app| {
            let state = app.state::<AppState>();
            let settings = state.settings.lock().clone();
            let tracker = state.tracker.clone();
            if let Some(window) = app.get_webview_window("pet") {
                let window_size = window.outer_size().ok();
                let monitors = window.available_monitors().unwrap_or_default();
                let saved = settings.pet_position.clone().and_then(|saved| {
                    monitors.iter().find_map(|monitor| {
                        let origin = monitor.position();
                        let size = monitor.size();
                        let width = window_size
                            .as_ref()
                            .map(|value| value.width as i32)
                            .unwrap_or(60);
                        let height = window_size
                            .as_ref()
                            .map(|value| value.height as i32)
                            .unwrap_or(60);
                        let inside = saved.x >= origin.x
                            && saved.y >= origin.y
                            && saved.x + width <= origin.x + size.width as i32
                            && saved.y + height <= origin.y + size.height as i32;
                        if !inside {
                            return None;
                        }
                        // 旧配置允许存到任务栏下面；启动时先把底边收回到工作区内。
                        let area = monitor.work_area();
                        let bottom = area.position.y + area.size.height as i32;
                        Some(PhysicalPosition::new(
                            saved.x,
                            saved.y.min(pet_top_limit(bottom, height)),
                        ))
                    })
                });
                if let Some(position) = saved {
                    let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
                } else if let Ok(Some(monitor)) = window.primary_monitor() {
                    let screen = monitor.size();
                    let origin = monitor.position();
                    let width = window_size
                        .as_ref()
                        .map(|value| value.width as i32)
                        .unwrap_or(60);
                    let height = window_size
                        .as_ref()
                        .map(|value| value.height as i32)
                        .unwrap_or(60);
                    let x = origin.x + screen.width as i32 - width - 32;
                    let y = origin.y + (screen.height as i32 - height) / 2;
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
            }
            tracker::start_tracker(app.handle().clone(), tracker);
            launchpad::preload(app.handle().clone());
            pet_catalog::preload(app.handle().clone());
            #[cfg(target_os = "windows")]
            os::start_pet_visibility(app.handle().clone());

            let failed = shortcuts::register_all(app.handle(), &settings);
            if !failed.is_empty() {
                eprintln!("snapshot: {}", shortcuts::conflict_message(&failed));
                activity::record_error(
                    app.handle(),
                    ui_text("快捷键没注册上", "Shortcuts were not registered"),
                    &failed.join("、"),
                );
                *state.shortcut_conflicts.lock() = failed;
            }

            // 配置里若已勾选自启，启动时把系统启动项与设置对齐（不会默认打开）。
            // 应用被移动过路径时，这一步顺带把启动项里的旧路径刷新掉。
            if settings.launch_on_boot {
                if let Err(error) = os::apply_autostart(true) {
                    eprintln!("snapshot: could not sync autostart entry: {error}");
                }
            }

            let open_settings =
                MenuItem::with_id(app, "open-settings", "打开设置", true, None::<&str>)?;
            let pause_shortcuts = CheckMenuItem::with_id(
                app,
                "pause-shortcuts",
                "暂停全局快捷键",
                true,
                settings.shortcuts_paused,
                None::<&str>,
            )?;
            *state.shortcut_pause_item.lock() = Some(pause_shortcuts.clone());
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            *state.tray_open_item.lock() = Some(open_settings.clone());
            *state.tray_quit_item.lock() = Some(quit.clone());
            let menu = Menu::with_items(app, &[&open_settings, &pause_shortcuts, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open-settings" => actions::show_main_window(app.clone()),
                    "pause-shortcuts" => shortcuts::toggle_from_tray(app),
                    "quit" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let _ = state.recorder.lock().stop();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click (and Windows double-click) opens the main window where the
                    // tray backend emits click events. Linux tray-icon 0.24 via
                    // libayatana-appindicator has no Activate/click callback — menu only.
                    // Right-click / context menu (打开设置 / 退出) is unchanged.
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                        | TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => {
                            actions::show_main_window(tray.app_handle().clone());
                        }
                        _ => {}
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            // Linux 上若会话没有 StatusNotifierHost（精简环境 / 无扩展的 GNOME），
            // 托盘会建失败；主窗口与快捷键仍应可用，不能把整个 setup 拖死。
            let tray_available = match tray.build(app) {
                Ok(_) => true,
                Err(error) => {
                    eprintln!(
                        "snapshot: system tray unavailable ({error}); continuing without tray"
                    );
                    false
                }
            };
            // 主窗口在配置里默认隐藏，正常启动时到这里再显示，避免开机自启时闪一下。
            // 没有可用托盘时，自启后仍需保留一个可见入口。
            if should_show_main_window(started_at_login, tray_available) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(window.label(), "main" | "pet-catalog") {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if window.label() == "launchpad" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    launchpad::conceal(window.app_handle());
                }
            } else if window.label() == "annotate" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    capture::conceal_annotate_window(window.app_handle());
                }
            } else if window.label() == "prompt-library" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if window.label() == "pet" {
                if let WindowEvent::Moved(position) = event {
                    let mut position = PhysicalPosition::new(position.x, position.y);
                    // 无论拖动还是自由走动，都先把窗口底边压回任务栏上方。
                    // set_position 会再发一次 Moved，届时位置已在界内，不会循环。
                    let gravity = window
                        .app_handle()
                        .try_state::<AppState>()
                        .map(|state| state.settings.lock().pet_gravity)
                        .unwrap_or(true);
                    if gravity {
                        if let (Ok(Some(monitor)), Ok(size)) =
                            (window.current_monitor(), window.outer_size())
                        {
                            let area = monitor.work_area();
                            let limit = pet_top_limit(
                                area.position.y + area.size.height as i32,
                                size.height as i32,
                            );
                            if position.y > limit {
                                position.y = limit;
                                let _ = window.set_position(position);
                            }
                        }
                    }
                    let app = window.app_handle().clone();
                    {
                        let Some(state) = app.try_state::<AppState>() else {
                            return;
                        };
                        let (shift_x, shift_y) = *state.pet_frame_shift.lock();
                        state.settings.lock().pet_position = Some(settings::PetPosition {
                            x: position.x.saturating_sub(shift_x),
                            y: position.y.saturating_sub(shift_y),
                        });
                        state.pet_position_revision.fetch_add(1, Ordering::SeqCst);
                        if state
                            .pet_position_persist_pending
                            .swap(true, Ordering::SeqCst)
                        {
                            return;
                        }
                    }
                    thread::spawn(move || loop {
                        thread::sleep(Duration::from_millis(350));
                        let Some(state) = app.try_state::<AppState>() else {
                            return;
                        };
                        let revision = state.pet_position_revision.load(Ordering::SeqCst);
                        {
                            let settings = state.settings.lock();
                            let _ = settings::persist_settings(&state.settings_path, &settings);
                        }
                        state
                            .pet_position_persist_pending
                            .store(false, Ordering::SeqCst);
                        if state.pet_position_revision.load(Ordering::SeqCst) == revision {
                            break;
                        }
                        // 期间又移动过：如果已经有新任务接手就退出，否则由这个任务继续。
                        if state
                            .pet_position_persist_pending
                            .swap(true, Ordering::SeqCst)
                        {
                            break;
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            actions::set_app_language,
            settings::load_settings,
            settings::save_prompt_settings,
            settings::clear_api_key,
            settings::fetch_models,
            settings::default_prompt,
            pet::select_pet_appearance,
            pet::set_pet_frame_shift,
            pet::set_pet_hitbox,
            pet::pet_animation_duration,
            pet::add_pet_assets,
            pet_catalog::fetch_pet_catalog,
            pet_catalog::show_pet_catalog,
            pet_catalog::install_catalog_pet,
            prompt_library::show_prompt_library_window,
            prompt_library::hide_prompt_library,
            prompt_library::list_saved_prompts,
            prompt_library::save_saved_prompt,
            prompt_library::delete_saved_prompt,
            pet::rename_pet_asset,
            pet::delete_pet_asset,
            settings::save_shortcuts,
            shortcuts::get_shortcut_conflicts,
            shortcuts::set_shortcuts_paused,
            settings::save_preferences,
            tracker::get_previous_app,
            tracker::list_capturable_windows,
            recording::get_recording_status,
            recording::toggle_recording,
            polish::polish_text,
            snapshots::list_snapshots,
            snapshots::open_snapshots_dir,
            snapshots::get_snapshot_dir,
            recording::open_recordings_dir,
            recording::get_recording_dir,
            snapshots::delete_snapshots,
            snapshots::copy_snapshot,
            activity::list_activity,
            prompt_history::list_prompt_history,
            clipboard::get_clipboard_state,
            clipboard::clear_clipboard_now,
            clipboard::keep_clipboard,
            clipboard::copy_text,
            clipboard::read_clipboard_text,
            capabilities::platform_capabilities,
            actions::show_quick_menu,
            actions::resize_quick_menu,
            actions::hide_quick_menu,
            actions::run_action,
            actions::show_main_window,
            launchpad::show_launchpad,
            launchpad::hide_launchpad,
            launchpad::launchpad_state,
            launchpad::save_launchpad,
            launchpad::launch_app,
            capture::get_annotate_image,
            capture::annotate_get_title,
            capture::annotate_copy,
            capture::annotate_save,
            capture::annotate_save_copy,
            snapshots::annotate_snapshot,
            capture::annotate_close,
        ])
        .run(context)
        .expect("运行 snapshot 失败");
}

#[cfg(test)]
mod pet_asset_tests {
    use super::*;

    /// 老配置含已废弃的录制目录绑定与（Win/mac 上）不支持的滚动长截图：
    /// 移除它们，补出新动作，保留其它已有绑定。
    #[test]
    fn old_settings_migrate_shortcut_actions() {
        let path = std::env::temp_dir().join("snapshot-settings-migration.json");
        let legacy = r#"{
            "baseUrl": "https://api.example.com/v1",
            "model": "demo",
            "templates": [{"id":"builtin-default","name":"内置","content":"x","builtin":true}],
            "activeTemplateId": "builtin-default",
            "selectedAppearanceId": "app-icon",
            "petAssets": [],
            "saveDir": "~/LegacyCaptures",
            "shortcuts": [
                {"action":"snapshot","accelerator":"Alt+Shift+2"},
                {"action":"record","accelerator":null},
                {"action":"recordings","accelerator":"Alt+Shift+R"},
                {"action":"polish","accelerator":null},
                {"action":"scrolling","accelerator":null}
            ]
        }"#;
        fs::write(&path, legacy).expect("写测试配置失败");

        let settings = settings::read_settings(&path);
        let actions: Vec<&str> = settings
            .shortcuts
            .iter()
            .map(|item| item.action.as_str())
            .collect();
        // 平台不支持的动作（如 Win/mac 的 scrolling）不应被迁移补回
        #[cfg(target_os = "linux")]
        assert_eq!(
            actions,
            vec![
                "snapshot",
                "record",
                "polish",
                "scrolling",
                "fullscreen",
                "prompts",
                "palette"
            ]
        );
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            actions,
            vec![
                "snapshot",
                "record",
                "polish",
                "fullscreen",
                "prompts",
                "palette"
            ]
        );

        // 已绑定的键不能在迁移中丢失
        let snapshot = settings
            .shortcuts
            .iter()
            .find(|item| item.action == "snapshot")
            .unwrap();
        assert_eq!(snapshot.accelerator.as_deref(), Some("Alt+Shift+2"));
        // 新补的那条应当是未绑定状态
        let fullscreen = settings
            .shortcuts
            .iter()
            .find(|item| item.action == "fullscreen")
            .unwrap();
        assert!(fullscreen.accelerator.is_none());
        let prompts = settings
            .shortcuts
            .iter()
            .find(|item| item.action == "prompts")
            .unwrap();
        assert_eq!(
            prompts.accelerator.as_deref(),
            Some("CommandOrControl+Shift+P")
        );
        // 老版录制与快照共用 saveDir，新版应将它迁移到独立录制目录。
        assert_eq!(settings.recording_dir, "~/LegacyCaptures");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn prompt_shortcut_does_not_duplicate_an_existing_binding() {
        let path = std::env::temp_dir().join(format!(
            "snapshot-settings-prompt-shortcut-{}.json",
            std::process::id()
        ));
        let legacy = r#"{
            "baseUrl":"",
            "model":"",
            "templates":[],
            "activeTemplateId":"builtin-default",
            "shortcuts":[{"action":"polish","accelerator":"CommandOrControl+Shift+P"}]
        }"#;
        fs::write(&path, legacy).expect("写测试配置失败");
        let settings = settings::read_settings(&path);
        let prompts = settings
            .shortcuts
            .iter()
            .find(|item| item.action == "prompts")
            .unwrap();
        assert!(prompts.accelerator.is_none());
        let polish = settings
            .shortcuts
            .iter()
            .find(|item| item.action == "polish")
            .unwrap();
        assert_eq!(
            polish.accelerator.as_deref(),
            Some("CommandOrControl+Shift+P")
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pet_bottom_stops_at_work_area_edge() {
        // 底部任务栏：工作区底边 1040，136px 高的桌宠最多把左上角放到 904。
        assert_eq!(pet_top_limit(1040, 136), 904);
        // 副屏在负坐标时同样按所在屏幕的工作区算。
        assert_eq!(pet_top_limit(-80, 200), -280);
        // 桌宠本身比工作区还高时，也优先守住底边，不让脚落到任务栏下面。
        assert_eq!(pet_top_limit(600, 900), -300);
    }

    #[test]
    fn login_startup_stays_hidden_when_the_tray_is_available() {
        assert!(should_show_main_window(false, true));
        assert!(!should_show_main_window(true, true));
        assert!(should_show_main_window(false, false));
        assert!(should_show_main_window(true, false));
    }
}
