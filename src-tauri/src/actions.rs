use super::*;
use crate::capture_timing::CaptureTrace;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
};

#[tauri::command]
pub(crate) fn set_app_language(
    app: AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let english = language == "en";
    super::INTERFACE_ENGLISH.store(english, Ordering::Relaxed);
    if let Some(item) = state.tray_open_item.lock().as_ref() {
        item.set_text(ui_text("打开设置", "Open Settings"))
            .map_err(|error| error.to_string())?;
    }
    if let Some(item) = state.shortcut_pause_item.lock().as_ref() {
        item.set_text(ui_text("暂停全局快捷键", "Pause global shortcuts"))
            .map_err(|error| error.to_string())?;
    }
    if let Some(item) = state.tray_quit_item.lock().as_ref() {
        item.set_text(ui_text("退出", "Quit"))
            .map_err(|error| error.to_string())?;
    }
    let updated = {
        let mut settings = state.settings.lock();
        let changed = settings::sync_builtin_prompt(&mut settings, english);
        if changed {
            settings::persist_settings(&state.settings_path, &settings)?;
            Some(settings.clone())
        } else {
            None
        }
    };
    if let Some(settings) = updated {
        settings::emit_settings(&app, &settings);
    }
    Ok(())
}

/// 输入框窗口的逻辑大小由页面按当前视图量好再告诉这里（resize_quick_menu）；
/// 这是页面还没量过时的初始值，以及防止量错的上下限
const PALETTE_INITIAL_SIZE: (f64, f64) = (400.0, 360.0);
const PALETTE_WIDTH_RANGE: (f64, f64) = (240.0, 760.0);
const PALETTE_HEIGHT_RANGE: (f64, f64) = (160.0, 760.0);

/// 右键桌宠：在桌宠旁边展开，往屏幕中心的方向开
#[tauri::command]
pub(crate) fn show_quick_menu(
    app: AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    *state.quick_menu_anchor.lock() = Some((x, y));
    open_palette(&app, &state)
}

/// 全局快捷键呼出：放在光标所在屏幕的上方居中，像系统的搜索框
pub(crate) fn show_palette_centered(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.quick_menu_anchor.lock() = None;
    open_palette(app, &state)
}

fn open_palette(app: &AppHandle, state: &AppState) -> Result<(), String> {
    app.get_webview_window("quick-menu")
        .ok_or_else(|| "输入框窗口不存在".to_string())?;
    // The frontend resets content and remounts the panel on palette-opened. Wait until
    // that mount reports its measured size before showing the native window.
    state.quick_menu_pending_show.store(true, Ordering::SeqCst);
    let _ = app.emit_to("quick-menu", "palette-opened", ());

    // If the webview is still starting, do not leave the menu permanently hidden.
    let fallback_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            thread::sleep(Duration::from_millis(160));
        })
        .await;
        let Some(state) = fallback_app.try_state::<AppState>() else {
            return;
        };
        if !state.quick_menu_pending_show.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(window) = fallback_app.get_webview_window("quick-menu") {
            let (width, height) = current_logical_size(&window).unwrap_or(PALETTE_INITIAL_SIZE);
            let anchor = *state.quick_menu_anchor.lock();
            if position_palette(&fallback_app, &window, anchor, width, height).is_ok() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
    Ok(())
}

fn current_logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?;
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// 页面换了视图、内容变多变少（进润色、展开窗口列表）时由页面告诉窗口该多大
#[tauri::command]
pub(crate) fn resize_quick_menu(
    app: AppHandle,
    state: State<'_, AppState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("quick-menu")
        .ok_or_else(|| "输入框窗口不存在".to_string())?;
    let width = width.clamp(PALETTE_WIDTH_RANGE.0, PALETTE_WIDTH_RANGE.1);
    let height = height.clamp(PALETTE_HEIGHT_RANGE.0, PALETTE_HEIGHT_RANGE.1);
    set_palette_bounds(
        &app,
        &window,
        *state.quick_menu_anchor.lock(),
        width,
        height,
    )?;
    if state.quick_menu_pending_show.swap(false, Ordering::SeqCst) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn monitor_at(window: &tauri::WebviewWindow, sx: f64, sy: f64) -> Option<tauri::Monitor> {
    window.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            sx >= position.x as f64
                && sx <= (position.x + size.width as i32) as f64
                && sy >= position.y as f64
                && sy <= (position.y + size.height as i32) as f64
        })
    })
}

fn position_palette(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    anchor: Option<(f64, f64)>,
    logical_width: f64,
    logical_height: f64,
) -> Result<(), String> {
    window
        .set_position(palette_position(
            app,
            window,
            anchor,
            logical_width,
            logical_height,
        )?)
        .map_err(|e| e.to_string())
}

/// 尺寸和位置放在同一次系统窗口更新里。分成 set_size + set_position 会先长一下、
/// 再挪到新位置；快捷菜单换页时，这两帧之间的空隙就会闪。
fn set_palette_bounds(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    anchor: Option<(f64, f64)>,
    logical_width: f64,
    logical_height: f64,
) -> Result<(), String> {
    let position = palette_position(app, window, anchor, logical_width, logical_height)?;
    #[cfg(target_os = "windows")]
    {
        let scale = window.scale_factor().unwrap_or(1.0);
        let width = (logical_width * scale).round().max(1.0) as i32;
        let height = (logical_height * scale).round().max(1.0) as i32;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        let updated = unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                position.x,
                position.y,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        };
        if updated == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        window
            .set_size(LogicalSize::new(logical_width, logical_height))
            .map_err(|e| e.to_string())?;
        window.set_position(position).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn palette_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    anchor: Option<(f64, f64)>,
    logical_width: f64,
    logical_height: f64,
) -> Result<PhysicalPosition<i32>, String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = logical_width * scale;
    let height = logical_height * scale;

    let (mut px, mut py, monitor) = match anchor {
        Some((x, y)) => {
            let (sx, sy) = (x * scale, y * scale);
            let monitor = monitor_at(window, sx, sy);
            // 桌宠在哪个象限，就往朝屏幕中心的那只角展开
            let (open_right, open_down) = match &monitor {
                Some(monitor) => {
                    let position = monitor.position();
                    let size = monitor.size();
                    (
                        sx < position.x as f64 + size.width as f64 / 2.0,
                        sy < position.y as f64 + size.height as f64 / 2.0,
                    )
                }
                None => (true, true),
            };
            let px = if open_right {
                sx - 40.0 * scale
            } else {
                sx - width + 40.0 * scale
            };
            let py = if open_down {
                sy - 24.0 * scale
            } else {
                sy - height + 24.0 * scale
            };
            (px, py, monitor)
        }
        None => {
            let cursor = app.cursor_position().ok();
            let monitor = cursor
                .and_then(|point| monitor_at(window, point.x, point.y))
                .or_else(|| window.primary_monitor().ok().flatten());
            match &monitor {
                Some(monitor) => {
                    let position = monitor.position();
                    let size = monitor.size();
                    (
                        position.x as f64 + (size.width as f64 - width) / 2.0,
                        position.y as f64 + size.height as f64 * 0.16,
                        Some(monitor.clone()),
                    )
                }
                None => (200.0, 160.0, None),
            }
        }
    };

    // 钳位兜底：防多屏错位时窗口跑出屏幕
    if let Some(monitor) = monitor {
        let position = monitor.position();
        let size = monitor.size();
        let max_x = (position.x + size.width as i32) as f64 - width;
        let max_y = (position.y + size.height as i32) as f64 - height;
        px = px.clamp(position.x as f64, max_x.max(position.x as f64));
        py = py.clamp(position.y as f64, max_y.max(position.y as f64));
    }
    Ok(PhysicalPosition::new(px.round() as i32, py.round() as i32))
}

#[tauri::command]
pub(crate) fn hide_quick_menu(app: AppHandle) {
    let _ = hide_quick_menu_window(&app);
}

fn hide_quick_menu_window(app: &AppHandle) -> Result<Option<tauri::WebviewWindow>, String> {
    if let Some(state) = app.try_state::<AppState>() {
        state.quick_menu_pending_show.store(false, Ordering::SeqCst);
    }
    if let Some(window) = app.get_webview_window("quick-menu") {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(Some(window));
    }
    Ok(None)
}

/// 输入框里执行一个会截屏的动作：先把自己藏起来再动手，否则会截进画面里。
/// `target_id` 只对「截一个窗口」有用。失败会记进活动，主窗口的猫会播报。
#[tauri::command]
pub(crate) async fn run_action(
    app: AppHandle,
    action: String,
    target_id: Option<u32>,
) -> Result<String, String> {
    let is_capture = capture_action(&action);
    let trace = is_capture.then(CaptureTrace::start);
    let menu = match hide_quick_menu_window(&app) {
        Ok(menu) => menu,
        Err(error) if is_capture => {
            if let Some(trace) = &trace {
                trace.finish("error");
            }
            activity::record_error(&app, action_failure_title(&action), &error);
            emit_pet_failure(&app, &action);
            return Err(error);
        }
        Err(_) => None,
    };
    if let Some(trace) = &trace {
        trace.mark("menu_hide");
    }

    // 只有会读取屏幕的动作才需要在菜单消失后等待。窗口选择和其它菜单动作
    // 没必要承担这个固定开销。
    if is_capture {
        if let Some(menu) = menu {
            settle_hidden_quick_menu(menu).await;
        }
        if let Some(trace) = &trace {
            trace.mark("menu_settle");
        }
    }

    let result = perform_with_trace(&app, &action, target_id, trace.as_ref()).await;
    if let Some(trace) = &trace {
        trace.finish(if result.is_ok() { "ok" } else { "error" });
    }
    if let Err(error) = &result {
        activity::record_error(&app, action_failure_title(&action), error);
        if action != "polish" {
            emit_pet_failure(&app, &action);
        }
    }
    result
}

fn capture_action(action: &str) -> bool {
    matches!(action, "capture" | "snapshot" | "fullscreen" | "scrolling")
}

async fn settle_hidden_quick_menu(window: tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        let settled = tauri::async_runtime::spawn_blocking(move || os::wait_until_hidden(&window))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
        if settled.is_ok() {
            return;
        }
        // DwmFlush 不可用时宁可多等，也不能把菜单拍进截图。
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;

    let _ = tauri::async_runtime::spawn_blocking(|| {
        thread::sleep(Duration::from_millis(160));
    })
    .await;
}

pub(crate) fn action_failure_title(action: &str) -> &'static str {
    match action {
        "snapshot" | "capture" => ui_text("截图失败", "Capture failed"),
        "fullscreen" => ui_text("全屏截图失败", "Fullscreen capture failed"),
        "scrolling" => ui_text("滚动长截图失败", "Scrolling capture failed"),
        "record" => ui_text("录制失败", "Recording failed"),
        "polish" => ui_text("润色失败", "Rewrite failed"),
        "prompts" => ui_text("Prompt 库打开失败", "Could not open Prompt library"),
        _ => ui_text("操作失败", "Action failed"),
    }
}

pub(crate) fn emit_pet_failure(app: &AppHandle, action: &str) {
    let event = match action {
        "snapshot" | "capture" | "fullscreen" | "scrolling" => "capture.failure",
        "record" => "recording.failure",
        "polish" => "polish.failure",
        _ => return,
    };
    let _ = app.emit("pet-event", event);
}

/// 第二个实例启动时把已有窗口唤到前台。
/// 这里刻意不调 center()：窗口多半已在用户摆好的位置上，没必要弹回屏幕中央。
pub(crate) fn focus_existing_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.center();
        let _ = window.set_focus();
    }
}

/// 执行一个全局快捷键动作（由 shortcuts.rs 的按键回调调用）。
pub(crate) async fn perform(app: &AppHandle, action: &str) -> Result<String, String> {
    let trace = capture_action(action).then(CaptureTrace::start);
    let result = perform_with_trace(app, action, None, trace.as_ref()).await;
    if let Some(trace) = &trace {
        trace.finish(if result.is_ok() { "ok" } else { "error" });
    }
    result
}

async fn perform_with_trace(
    app: &AppHandle,
    action: &str,
    target_id: Option<u32>,
    trace: Option<&CaptureTrace>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    match action {
        "capture" | "snapshot" => {
            let capture_app = app.clone();
            let capture_trace = trace.cloned().unwrap_or_else(CaptureTrace::start);
            // xcap/GDI、编码、缩略图和剪贴板都会阻塞，整段放到阻塞线程池，
            // 避免占住 Tauri 的异步运行时。即时快门事件仍在原图返回时立即发送。
            tauri::async_runtime::spawn_blocking(move || {
                let state = capture_app.state::<AppState>();
                capture::capture_window(capture_app.clone(), state, target_id, capture_trace)
            })
            .await
            .map_err(|error| error.to_string())?
        }
        "palette" => show_palette_centered(app).map(|_| String::new()),
        "prompts" => prompt_library::show_prompt_library(app.clone())
            .await
            .map(|_| String::new()),
        "record" => recording::toggle_recording(app.clone(), state, None).map(|status| {
            if status.active {
                status
                    .message
                    .unwrap_or_else(|| ui_text("录制已开始", "Recording started").into())
            } else {
                ui_text("录制已保存", "Recording saved").into()
            }
        }),
        "polish" => polish::polish_clipboard(app.clone(), state).await,
        "fullscreen" => {
            let include_cursor = state.settings.lock().include_cursor;
            let capture_trace = trace.cloned().unwrap_or_else(CaptureTrace::start);
            let capture_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = capture_app.state::<AppState>();
                let (image, name, cursor_degraded) =
                    capture::capture_fullscreen_image(include_cursor, &capture_trace)?;
                capture::finalize_capture(
                    &capture_app,
                    &state,
                    image,
                    &name,
                    cursor_degraded,
                    capture_trace,
                )
            })
            .await
            .map_err(|error| error.to_string())?
        }
        // 滚动长截图只有 Linux/X11 有实现（其余平台的 SHORTCUT_ACTIONS 里也没有这一项）
        #[cfg(target_os = "linux")]
        "scrolling" => {
            let target_id = state
                .tracker
                .lock()
                .previous
                .as_ref()
                .map(|window| window.id)
                .ok_or_else(|| "还没有上一个应用可截取".to_string())?;
            let image = tauri::async_runtime::spawn_blocking(move || {
                os::capture_scrolling_window(target_id)
            })
            .await
            .map_err(|error| error.to_string())??;
            capture::finalize_capture(
                app,
                &state,
                image,
                ui_text("滚动长截图", "Scrolling capture"),
                None,
                trace.cloned().unwrap_or_else(CaptureTrace::start),
            )
        }
        _ => Err("未知快捷键动作".into()),
    }
}
