use super::*;
use crate::capture_timing::CaptureTrace;

/// 把 RGBA 位图编码成 PNG 字节（标注窗口、应用图标用）。
pub(crate) fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| format!("编码图像失败：{error}"))?;
    Ok(bytes)
}

/// 截一个窗口（不传就是前台窗口）。快捷键和输入框都经 `actions` 调到这里
pub(crate) fn capture_window(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<u32>,
    trace: CaptureTrace,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    os::require_screen_capture_access()?;
    let target_id = id
        .or_else(|| {
            state
                .tracker
                .lock()
                .previous
                .as_ref()
                .map(|window| window.id)
        })
        .ok_or_else(|| "还没有上一个应用可截取".to_string())?;
    trace.mark("target_resolve");
    #[cfg(target_os = "windows")]
    if let Some(main) = tracker::own_main_window(&app, target_id) {
        trace.mark("window_enum");
        if main.is_minimized().map_err(|error| error.to_string())? {
            os::restore_minimized(target_id)?;
            trace.mark("window_restore");
        }
        let hwnd = target_id as isize;
        let (x, y, width, height) = os::capture_own_window_bounds(hwnd)?;
        let area = Some(Area {
            x,
            y,
            width,
            height,
        });
        trace.mark("window_metadata");
        let include_cursor = state.settings.lock().include_cursor;
        let (image, cursor_degraded) =
            capture_area(include_cursor, area, "窗口", &trace, || {
                os::capture_own_window(hwnd)
            })?;
        let app_id = os::app_stable_id(std::process::id());
        return finalize_capture(
            &app,
            &state,
            image,
            "snapshot",
            app_id,
            cursor_degraded,
            trace,
        );
    }
    #[cfg(target_os = "macos")]
    {
        // 独立窗口采集不依赖 xcap 的 on-screen 列表或台前调度的缩略图矩形，
        // 也不还原/激活后台应用。来源应用标识直接取自被截窗口所属进程，避免误标为上一个前台应用。
        let include_cursor = state.settings.lock().include_cursor;
        let captured = os::capture_window_image(target_id, include_cursor)?;
        trace.mark("engine_capture_screencapturekit");
        let app_id = captured
            .bundle_id
            .or_else(|| captured.pid.and_then(os::app_stable_id));
        finalize_capture(
            &app,
            &state,
            captured.image,
            &captured.app_name,
            app_id,
            None,
            trace,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = Window::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|window| window.id().ok() == Some(target_id))
            .ok_or_else(|| "目标窗口已经关闭".to_string())?;
        trace.mark("window_enum");
        if window.is_minimized().unwrap_or(false) {
            os::restore_minimized(target_id)?;
            trace.mark("window_restore");
        }
        let app_name = window
            .app_name()
            .unwrap_or_else(|_| crate::ui_text("应用", "App").into());
        let include_cursor = state.settings.lock().include_cursor;
        let area = match (window.x(), window.y(), window.width(), window.height()) {
            (Ok(x), Ok(y), Ok(width), Ok(height)) => Some(Area {
                x,
                y,
                width,
                height,
            }),
            _ => None,
        };
        trace.mark("window_metadata");
        let (image, cursor_degraded) =
            capture_area(include_cursor, area, "窗口", &trace, || {
                window
                    .capture_image()
                    .map_err(|error| format!("截取失败：{error}"))
            })?;
        let app_id = window.pid().ok().and_then(os::app_stable_id);
        finalize_capture(
            &app,
            &state,
            image,
            &app_name,
            app_id,
            cursor_degraded,
            trace,
        )
    }
}

/// 一块屏幕区域（窗口或显示器）在屏幕上的位置与逻辑尺寸
pub(crate) struct Area {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    /// 只有 Linux 让 ffmpeg 按矩形抓时要用；Windows/macOS 合成光标只需宽度换算缩放
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) height: u32,
}

/// 截一块区域；开了「包含光标」就交给平台把光标带上。
///
/// 各平台带光标的办法不同（Windows/macOS 截完再按热点合成，Linux 让 ffmpeg 直接带光标抓），
/// 但失败了都退回不带光标的截图，并把原因拼进成功提示，不让用户以为开关生效了。
fn capture_area(
    include_cursor: bool,
    area: Option<Area>,
    what: &str,
    trace: &CaptureTrace,
    capture: impl FnOnce() -> Result<RgbaImage, String>,
) -> Result<(RgbaImage, Option<String>), String> {
    if !include_cursor {
        let image = capture()?;
        trace.mark("engine_capture");
        return Ok((image, None));
    }
    let Some(area) = area else {
        let note = cursor_degrade_note(&format!("无法读取{what}几何，已回退无光标截图"));
        let image = capture()?;
        trace.mark("engine_capture");
        return Ok((image, Some(note)));
    };
    let (image, failure) = os::capture_with_cursor(&area, capture)?;
    trace.mark("engine_capture_with_cursor");
    Ok((image, failure.map(|error| cursor_degrade_note(&error))))
}

/// 把光标合成失败的原因压成短中文，附在截图成功 toast 后。
fn cursor_degrade_note(error: &str) -> String {
    if interface_is_english() {
        return " The pointer couldn’t be included.".into();
    }
    let head = error.split(" / ").next().unwrap_or(error).trim();
    let short: String = head.chars().take(48).collect();
    let ellipsis = if head.chars().count() > 48 { "…" } else { "" };
    format!("（未能包含鼠标光标：{short}{ellipsis}）")
}

/// 统一收尾：存入历史、放进剪贴板，并给出闪烁/音效提示。
/// `cursor_degraded`：Linux 带光标静帧失败后回退时的说明，会拼进成功文案。
pub(crate) fn finalize_capture(
    app: &AppHandle,
    state: &AppState,
    image: RgbaImage,
    app_name: &str,
    app_id: Option<String>,
    cursor_degraded: Option<String>,
    trace: CaptureTrace,
) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("截取结果为空图像".into());
    }
    let settings = state.settings.lock().clone();

    // 原图已经成功拿到，立即通知主窗口播放快门反馈，不等待编码、历史或剪贴板。
    let _ = app.emit_to(
        "main",
        "capture-shot",
        json!({
            "shotId": trace.shot_id(),
            "startedAtMs": trace.started_at_ms(),
            "sentAtMs": now_millis(),
            "trace": trace.enabled(),
            "shutterSound": settings.shutter_sound,
            "customSoundPath": settings.custom_sound_path,
        }),
    );
    trace.mark_capture_ready();

    // 截图固定「复制 + 存历史」；存失败不阻断剪贴板。
    let archived =
        match snapshots::store_snapshot_traced(state, &image, app_name, app_id.clone(), &trace) {
            Ok(_) => true,
            Err(error) => {
                eprintln!("snapshot: could not save snapshot for {app_name}: {error}");
                false
            }
        };
    if archived {
        let _ = app.emit("snapshots-changed", ());
    }

    clipboard::copy_image(image)?;
    trace.mark("clipboard");

    let _ = app.emit("pet-event", "capture.success");
    let suffix = cursor_degraded.unwrap_or_default();
    if interface_is_english() {
        let head = if archived {
            format!("Copied {app_name} and saved it to History.")
        } else {
            format!("Copied {app_name}, but couldn’t save it to History.")
        };
        return Ok(format!("{head}{suffix}"));
    }
    if archived {
        Ok(format!("已复制 {app_name} 并存入历史{suffix}"))
    } else {
        Ok(format!("已复制 {app_name}（未能存入历史）{suffix}"))
    }
}

pub(crate) struct AnnotateSession {
    id: u64,
    png: Vec<u8>,
    source: snapshots::SnapshotSource,
}

pub(crate) fn open_annotate_window(
    app: &AppHandle,
    state: &AppState,
    image: &RgbaImage,
    source: snapshots::SnapshotSource,
) -> Result<(), String> {
    let png = encode_png(image)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let title = source.record.app_name.clone();
    *state.annotate_session.lock() = Some(AnnotateSession {
        id: SEQUENCE.fetch_add(1, Ordering::Relaxed),
        png,
        source,
    });
    let window = app
        .get_webview_window("annotate")
        .ok_or_else(|| "标注窗口不存在".to_string())?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));
    let work_area = monitor.as_ref().map(|monitor| monitor.work_area().size);
    let (width, height) = annotate_window_logical_size(
        image.width(),
        image.height(),
        scale,
        work_area.map_or(1200, |size| size.width),
        work_area.map_or(800, |size| size.height),
    );
    let _ = window.unminimize();
    let _ = window.unmaximize();
    let _ = window.set_size(LogicalSize::new(width, height));
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let x = area.position.x as f64 + (area.size.width as f64 - width * scale) / 2.0;
        let y = area.position.y as f64 + (area.size.height as f64 - height * scale) / 2.0;
        let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    } else {
        let _ = window.center();
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = app.emit("annotate-ready", json!({ "title": title }));
    Ok(())
}

/// 截图尺寸是物理像素，窗口尺寸是逻辑像素。按 DPI 换算后再限制到工作区，
/// 否则高分屏上大图会把工具栏推到屏幕外。放不下时按图片比例整体缩小，
/// 窗口和画布同比例，不会一边贴紧、另一边留出大片空白。
/// 前端：52px 工具栏（macOS 上红黄绿叠在里面）+ 画布四周各 16px。
fn annotate_window_logical_size(
    image_width: u32,
    image_height: u32,
    scale: f64,
    work_width: u32,
    work_height: u32,
) -> (f64, f64) {
    const MIN_WIDTH: f64 = 720.0; // 工具栏（工具、颜色、撤销、导出）一行放得下
    const MIN_HEIGHT: f64 = 320.0;
    const MAX_WIDTH: f64 = 1280.0;
    const MAX_HEIGHT: f64 = 900.0;
    const SCREEN_MARGIN: f64 = 24.0;
    const PADDING: f64 = 16.0;
    const TOOLBAR_HEIGHT: f64 = 52.0;

    let scale = scale.max(0.1);
    let max_width = (work_width as f64 / scale - SCREEN_MARGIN * 2.0).clamp(MIN_WIDTH, MAX_WIDTH);
    let max_height =
        (work_height as f64 / scale - SCREEN_MARGIN * 2.0).clamp(MIN_HEIGHT, MAX_HEIGHT);
    let chrome_width = PADDING * 2.0;
    let chrome_height = TOOLBAR_HEIGHT + PADDING * 2.0;
    let image_width = (image_width as f64 / scale).max(1.0);
    let image_height = (image_height as f64 / scale).max(1.0);
    let fit = ((max_width - chrome_width) / image_width)
        .min((max_height - chrome_height) / image_height)
        .min(1.0);
    (
        (image_width * fit + chrome_width)
            .round()
            .clamp(MIN_WIDTH, max_width),
        (image_height * fit + chrome_height)
            .round()
            .clamp(MIN_HEIGHT, max_height),
    )
}

fn annotate_data_url(session: &AnnotateSession) -> String {
    format!("data:image/png;base64,{}", BASE64.encode(&session.png))
}

#[tauri::command]
pub(crate) fn get_annotate_session(state: State<'_, AppState>) -> Option<Value> {
    state.annotate_session.lock().as_ref().map(|session| {
        json!({
            "id": session.id,
            "title": session.source.record.app_name,
            "imageData": annotate_data_url(session),
        })
    })
}

fn active_session(
    session: &Option<AnnotateSession>,
    session_id: Option<u64>,
) -> Result<&AnnotateSession, String> {
    session
        .as_ref()
        .filter(|session| session_id.is_none_or(|id| id == session.id))
        .ok_or_else(|| "待标注的截图已更换，请重新打开标注".into())
}

fn decode_png_base64(data: &str) -> Result<RgbaImage, String> {
    let trimmed = data
        .strip_prefix("data:image/png;base64,")
        .or_else(|| data.strip_prefix("data:image/jpeg;base64,"))
        .unwrap_or(data);
    let bytes = BASE64
        .decode(trimmed.trim())
        .map_err(|error| format!("标注图解码失败：{error}"))?;
    image::load_from_memory(&bytes)
        .map(|img| img.to_rgba8())
        .map_err(|error| format!("标注图解析失败：{error}"))
}

fn keep_markup(
    app: &AppHandle,
    state: &AppState,
    session: &AnnotateSession,
    image: &RgbaImage,
    changed: Option<bool>,
) -> Result<String, String> {
    if changed == Some(false) {
        return Ok(session.source.record.id.clone());
    }
    let edited = snapshots::replace_snapshot(state, &session.source, image)?;
    let _ = app.emit("snapshots-changed", ());
    Ok(edited.id)
}

/// 标注窗口唯一的出口：编辑版存入历史并替换原图（原图移入回收站）。
#[tauri::command]
pub(crate) async fn annotate_save_copy(
    app: AppHandle,
    image_data: String,
    session_id: Option<u64>,
    changed: Option<bool>,
) -> Result<String, String> {
    on_worker(app, move |app, state| {
        let image = decode_png_base64(&image_data)?;
        let current = state.annotate_session.lock();
        keep_markup(
            app,
            state,
            active_session(&current, session_id)?,
            &image,
            changed,
        )?;
        Ok(ui_text("已存入历史记录", "Saved to History").into())
    })
    .await
}

#[tauri::command]
pub(crate) fn annotate_close(app: AppHandle, state: State<'_, AppState>, session_id: Option<u64>) {
    hide_annotate_window(&app, &state, session_id);
}

fn hide_annotate_window(app: &AppHandle, state: &AppState, session_id: Option<u64>) {
    let mut current = state.annotate_session.lock();
    if session_id.is_some() && active_session(&current, session_id).is_err() {
        return;
    }
    *current = None;
    if let Some(window) = app.get_webview_window("annotate") {
        let _ = window.hide();
    }
}

/// 标题栏的关闭键只隐藏标注窗；窗口本身留给下一次截图或历史预览复用。
pub(crate) fn conceal_annotate_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        hide_annotate_window(app, &state, None);
    }
}

fn primary_monitor() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|error| format!("无法枚举显示器：{error}"))?;
    monitors
        .into_iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| {
            Monitor::all()
                .ok()
                .and_then(|items| items.into_iter().next())
        })
        .ok_or_else(|| "未找到可用显示器".into())
}

pub(crate) fn capture_fullscreen_image(
    include_cursor: bool,
    trace: &CaptureTrace,
) -> Result<(RgbaImage, String, Option<String>), String> {
    #[cfg(target_os = "macos")]
    os::require_screen_capture_access()?;
    let monitor = primary_monitor()?;
    let name = monitor
        .name()
        .unwrap_or_else(|_| ui_text("全屏", "Full Screen").into());
    let area = match (monitor.x(), monitor.y(), monitor.width(), monitor.height()) {
        (Ok(x), Ok(y), Ok(width), Ok(height)) => Some(Area {
            x,
            y,
            width,
            height,
        }),
        _ => None,
    };
    let (image, note) = capture_area(include_cursor, area, "显示器", trace, || {
        monitor
            .capture_image()
            .map_err(|error| format!("全屏截取失败：{error}"))
    })?;
    Ok((image, name, note))
}

/// 按 alpha 把光标叠到截图上，落在画布外的像素直接丢弃。
///
/// Windows 与 macOS 都是「截完再合成光标」，合成这一步与平台无关，放在这里共用；
/// Linux 由 ffmpeg 直接带光标抓，用不上。
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) fn blend_cursor(canvas: &mut RgbaImage, cursor: &RgbaImage, left: i64, top: i64) {
    for (x, y, pixel) in cursor.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 {
            continue;
        }
        let target_x = left + i64::from(x);
        let target_y = top + i64::from(y);
        if target_x < 0
            || target_y < 0
            || target_x >= i64::from(canvas.width())
            || target_y >= i64::from(canvas.height())
        {
            continue;
        }
        let base = *canvas.get_pixel(target_x as u32, target_y as u32);
        let mix = |over: u8, under: u8| -> u8 {
            ((u32::from(over) * alpha + u32::from(under) * (255 - alpha)) / 255) as u8
        };
        canvas.put_pixel(
            target_x as u32,
            target_y as u32,
            image::Rgba([
                mix(pixel[0], base[0]),
                mix(pixel[1], base[1]),
                mix(pixel[2], base[2]),
                base[3].max(pixel[3]),
            ]),
        );
    }
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod blend_tests {
    use super::blend_cursor;
    use image::{Rgba, RgbaImage};

    #[test]
    fn respects_alpha_and_clips_out_of_bounds() {
        let mut canvas = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let overlay = RgbaImage::from_pixel(2, 2, Rgba([255, 255, 255, 255]));
        blend_cursor(&mut canvas, &overlay, 3, 3); // 只有左上角那个像素落在画布内
        assert_eq!(canvas.get_pixel(3, 3).0, [255, 255, 255, 255]);
        assert_eq!(canvas.get_pixel(0, 0).0, [0, 0, 0, 255]);
    }

    #[test]
    fn fully_transparent_cursor_changes_nothing() {
        let mut canvas = RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]));
        let overlay = RgbaImage::from_pixel(2, 2, Rgba([255, 255, 255, 0]));
        blend_cursor(&mut canvas, &overlay, 0, 0);
        assert_eq!(canvas.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn half_alpha_blends_halfway() {
        let mut canvas = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        let overlay = RgbaImage::from_pixel(1, 1, Rgba([255, 255, 255, 128]));
        blend_cursor(&mut canvas, &overlay, 0, 0);
        let value = canvas.get_pixel(0, 0).0[0];
        assert!((127..=129).contains(&value), "got {value}");
    }
}

#[cfg(test)]
mod annotate_window_tests {
    use super::annotate_window_logical_size;

    #[test]
    fn high_dpi_large_capture_stays_inside_the_work_area() {
        // 复现 175% 缩放下 2558×1599 的截图：旧逻辑开出的高度会超过工作区。
        let scale = 1.75;
        let work = (2560, 1515);
        let (width, height) = annotate_window_logical_size(2558, 1599, scale, work.0, work.1);
        assert!(width * scale <= work.0 as f64 - 40.0);
        assert!(height * scale <= work.1 as f64 - 40.0);
        assert!(height < 900.0, "工具栏必须留在屏幕内");
    }

    #[test]
    fn ordinary_capture_keeps_room_for_the_toolbar_and_small_images_are_compact() {
        // 1:1 放得下：图片 + 四周 16px + 52px 工具栏，不多留空
        let (width, height) = annotate_window_logical_size(1200, 700, 1.0, 1920, 1040);
        assert_eq!(width, 1232.0);
        assert_eq!(height, 784.0);
        // Retina 截图按逻辑像素算
        assert_eq!(
            annotate_window_logical_size(1292, 836, 2.0, 2940, 1840),
            (720.0, 502.0)
        );
        assert_eq!(
            annotate_window_logical_size(1600, 1000, 2.0, 2940, 1840),
            (832.0, 584.0)
        );

        assert_eq!(
            annotate_window_logical_size(100, 80, 1.0, 1920, 1040),
            (720.0, 320.0)
        );
    }

    #[test]
    fn oversized_capture_shrinks_with_its_own_aspect_ratio() {
        // 3:1 的宽图放不下 1280 宽：整体缩小，窗口高度跟着变矮，而不是撑满 900 高再留白
        let (width, height) = annotate_window_logical_size(3000, 1000, 1.0, 2560, 1440);
        assert_eq!(width, 1280.0);
        let image_height = height - 52.0 - 32.0;
        assert!(
            (((width - 32.0) / image_height) - 3.0).abs() < 0.02,
            "画布比例应保持 3:1"
        );
        // 很窄的竖长图：高度到顶，宽度只留到工具栏放得下的最小宽度
        assert_eq!(
            annotate_window_logical_size(800, 2400, 1.0, 2560, 1440),
            (720.0, 900.0)
        );
    }
}
