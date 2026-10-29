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
    let app_name = window.app_name().unwrap_or_else(|_| "应用".into());
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
    let (image, cursor_degraded) = capture_area(include_cursor, area, "窗口", &trace, || {
        window
            .capture_image()
            .map_err(|error| format!("截取失败：{error}"))
    })?;
    finalize_capture(&app, &state, image, &app_name, cursor_degraded, trace)
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
        return " (The pointer could not be included; the capture was saved without it.)".into();
    }
    let head = error.split(" / ").next().unwrap_or(error).trim();
    let short: String = head.chars().take(48).collect();
    let ellipsis = if head.chars().count() > 48 { "…" } else { "" };
    format!("（未能包含鼠标光标：{short}{ellipsis}）")
}

/// 统一收尾：按偏好决定是否落盘、剪贴板清空时限、截后动作与闪烁/音效提示。
/// `cursor_degraded`：Linux 带光标静帧失败后回退时的说明，会拼进成功文案。
pub(crate) fn finalize_capture(
    app: &AppHandle,
    state: &AppState,
    image: RgbaImage,
    app_name: &str,
    cursor_degraded: Option<String>,
    trace: CaptureTrace,
) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("截取结果为空图像".into());
    }
    let settings = state.settings.lock().clone();
    let (width, height) = (image.width(), image.height());

    // 原图已经成功拿到，立即通知主窗口。这里不等待编码、历史或剪贴板；
    // capture-feedback 仍保留在后处理末尾，表示整条截图流程已经结束。
    let _ = app.emit_to(
        "main",
        "capture-shot",
        json!({
            "shotId": trace.shot_id(),
            "startedAtMs": trace.started_at_ms(),
            "sentAtMs": now_millis(),
            "trace": trace.enabled(),
            "flash": settings.flash_on_capture,
            "shutterSound": settings.shutter_sound,
            "customSoundPath": settings.custom_sound_path,
        }),
    );
    trace.mark_capture_ready();

    // 「仅保存」必须进历史，否则用户选完既没有文件也没有剪贴板内容。
    let only_save = settings.after_capture == "saveas";
    let record = if settings.auto_save_local || only_save {
        snapshots::store_snapshot_traced(state, &image, app_name, &trace).ok()
    } else {
        None
    };
    let archived = record.is_some();
    if only_save && !archived {
        return Err(format!("未能把 {app_name} 保存到历史记录"));
    }
    if archived {
        let _ = app.emit("snapshots-changed", ());
    }
    let snapshot_id = record.map(|record| record.id);

    // after_capture：annotate 打开标注窗；saveas 仅保存到历史；默认剪贴板。
    let annotate = settings.after_capture == "annotate";
    if annotate {
        open_annotate_window(app, state, &image, app_name)?;
        trace.mark("annotate_open");
    } else if !only_save {
        let title = if interface_is_english() {
            format!("{app_name} screenshot")
        } else {
            format!("{app_name} 截图")
        };
        clipboard::copy_image(app, state, image, &title, snapshot_id.clone())?;
        trace.mark("clipboard");
    }

    // 活动、宠物成功反馈和兼容的最终事件都放在必需后处理成功之后，
    // 避免剪贴板/标注失败时先报一次成功。
    activity::record(
        app,
        activity::Activity::new("capture", app_name)
            .meta(format!("{width} × {height}"))
            .snapshot(snapshot_id.clone()),
    );
    trace.mark("activity");
    let _ = app.emit("pet-event", "capture.success");

    let _ = app.emit(
        "capture-feedback",
        json!({
            "shotId": trace.shot_id(),
            "sentAtMs": now_millis(),
            "ok": true,
            "historySaveAttempted": settings.auto_save_local || only_save,
            "historySaved": archived,
            "flash": settings.flash_on_capture,
            "shutterSound": settings.shutter_sound,
            "customSoundPath": settings.custom_sound_path,
        }),
    );
    trace.mark("feedback_event");
    if settings.hide_after_copy && !annotate && !only_save {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }

    let suffix = cursor_degraded.unwrap_or_default();
    if interface_is_english() {
        return if annotate {
            if archived {
                Ok(format!(
                    "Opened annotation for {app_name} · saved to history{suffix}"
                ))
            } else if settings.auto_save_local {
                Ok(format!(
                    "Opened annotation for {app_name} · history save failed{suffix}"
                ))
            } else {
                Ok(format!("Opened annotation for {app_name}{suffix}"))
            }
        } else if only_save {
            Ok(format!("Saved {app_name} to history{suffix}"))
        } else {
            let clear_label = snapshots::format_clear_label(&settings.clipboard_auto_clear);
            if archived {
                Ok(format!(
                    "Copied {app_name} and saved it to history · {clear_label}{suffix}"
                ))
            } else if settings.auto_save_local {
                Ok(format!(
                    "Copied {app_name} · history save failed · {clear_label}{suffix}"
                ))
            } else {
                Ok(format!("Copied {app_name} · {clear_label}{suffix}"))
            }
        };
    }
    if annotate {
        if archived {
            Ok(format!("已打开标注：{app_name}（已存入历史）{suffix}"))
        } else if settings.auto_save_local {
            Ok(format!("已打开标注：{app_name}（未能存入历史）{suffix}"))
        } else {
            Ok(format!("已打开标注：{app_name}{suffix}"))
        }
    } else if only_save {
        Ok(format!("已保存到历史记录：{app_name}{suffix}"))
    } else {
        let clear_label = snapshots::format_clear_label(&settings.clipboard_auto_clear);
        if archived {
            Ok(format!(
                "已复制 {app_name} 并存入历史，{clear_label}{suffix}"
            ))
        } else if settings.auto_save_local {
            Ok(format!(
                "已复制 {app_name}，{clear_label}（未能存入历史）{suffix}"
            ))
        } else {
            Ok(format!("已复制 {app_name}，{clear_label}{suffix}"))
        }
    }
}

fn save_image_as_dialog(
    app: &AppHandle,
    image: &RgbaImage,
    format_setting: &str,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let (format, ext) = snapshots::snapshot_format_parts(format_setting);
    let suggested = format!("snapshot-{}.{}", Local::now().format("%Y%m%d-%H%M%S"), ext);
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("Image", &[ext, "png", "jpg", "webp"])
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(false); // 用户取消另存，保留标注画布。
    };
    let path = file_path.into_path().map_err(|error| error.to_string())?;
    // 用户在对话框里改了扩展名就按扩展名存；认不出或不支持的扩展名才回退偏好格式
    let format = ImageFormat::from_path(&path)
        .ok()
        .filter(|guessed| {
            matches!(
                guessed,
                ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
            )
        })
        .unwrap_or(format);
    snapshots::write_image(image, &path, format).map_err(|error| format!("另存为失败：{error}"))?;
    Ok(true)
}

pub(crate) fn open_annotate_window(
    app: &AppHandle,
    state: &AppState,
    image: &RgbaImage,
    title: &str,
) -> Result<(), String> {
    let png = encode_png(image)?;
    *state.annotate_png.lock() = Some(png);
    *state.annotate_title.lock() = title.to_string();
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
/// 否则高分屏上大图会把工具栏推到屏幕外。
fn annotate_window_logical_size(
    image_width: u32,
    image_height: u32,
    scale: f64,
    work_width: u32,
    work_height: u32,
) -> (f64, f64) {
    const MIN_WIDTH: f64 = 480.0;
    const MIN_HEIGHT: f64 = 360.0;
    const MAX_WIDTH: f64 = 1280.0;
    const MAX_HEIGHT: f64 = 900.0;
    const MARGIN: f64 = 24.0;
    const CHROME_HEIGHT: f64 = 112.0;

    let scale = scale.max(0.1);
    let max_width = (work_width as f64 / scale - MARGIN * 2.0).clamp(MIN_WIDTH, MAX_WIDTH);
    let max_height = (work_height as f64 / scale - MARGIN * 2.0).clamp(MIN_HEIGHT, MAX_HEIGHT);
    let desired_width = image_width as f64 / scale + MARGIN;
    let desired_height = image_height as f64 / scale + CHROME_HEIGHT;
    (
        desired_width.clamp(MIN_WIDTH, max_width),
        desired_height.clamp(MIN_HEIGHT, max_height),
    )
}

#[tauri::command]
pub(crate) fn get_annotate_image(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(png) = state.annotate_png.lock().clone() else {
        return Ok(None);
    };
    Ok(Some(format!(
        "data:image/png;base64,{}",
        BASE64.encode(png)
    )))
}

#[tauri::command]
pub(crate) fn annotate_get_title(state: State<'_, AppState>) -> String {
    state.annotate_title.lock().clone()
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

#[tauri::command]
pub(crate) fn annotate_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    image_data: String,
) -> Result<String, String> {
    let image = decode_png_base64(&image_data)?;
    let settings = state.settings.lock().clone();
    let snapshot_id = if settings.auto_save_local {
        snapshots::store_snapshot(&state, &image, "标注")
            .ok()
            .map(|record| record.id)
    } else {
        None
    };
    if snapshot_id.is_some() {
        let _ = app.emit("snapshots-changed", ());
    }
    activity::record(
        &app,
        activity::Activity::new("capture", ui_text("标注图", "Annotated image"))
            .meta(format!("{} × {}", image.width(), image.height()))
            .snapshot(snapshot_id.clone()),
    );
    clipboard::copy_image(&app, &state, image, "标注图", snapshot_id)?;
    hide_annotate_window(&app, &state);
    Ok(format!(
        "已复制标注图，{}",
        snapshots::format_clear_label(&settings.clipboard_auto_clear)
    ))
}

#[tauri::command]
pub(crate) fn annotate_save(
    app: AppHandle,
    state: State<'_, AppState>,
    image_data: String,
) -> Result<String, String> {
    let image = decode_png_base64(&image_data)?;
    let format = state.settings.lock().snapshot_format.clone();
    if !save_image_as_dialog(&app, &image, &format)? {
        return Ok(ui_text(
            "已取消另存，标注仍保留",
            "Save canceled. Your annotations are still here.",
        )
        .into());
    }
    hide_annotate_window(&app, &state);
    Ok(ui_text("已保存标注图", "Annotated image saved").into())
}

#[tauri::command]
pub(crate) fn annotate_save_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    image_data: String,
) -> Result<String, String> {
    let image = decode_png_base64(&image_data)?;
    let title = if interface_is_english() {
        format!("{} · Annotation", state.annotate_title.lock())
    } else {
        format!("{} · 标注", state.annotate_title.lock())
    };
    snapshots::store_snapshot(&state, &image, &title)?;
    let _ = app.emit("snapshots-changed", ());
    hide_annotate_window(&app, &state);
    Ok(ui_text(
        "标注副本已保存到历史记录",
        "Annotated copy saved to history",
    )
    .into())
}

#[tauri::command]
pub(crate) fn annotate_close(app: AppHandle, state: State<'_, AppState>) {
    hide_annotate_window(&app, &state);
}

fn hide_annotate_window(app: &AppHandle, state: &AppState) {
    *state.annotate_png.lock() = None;
    if let Some(window) = app.get_webview_window("annotate") {
        let _ = window.hide();
    }
}

/// 标题栏的关闭键只隐藏标注窗；窗口本身留给下一次截图或历史预览复用。
pub(crate) fn conceal_annotate_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        hide_annotate_window(app, &state);
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
    let monitor = primary_monitor()?;
    let name = monitor
        .name()
        .unwrap_or_else(|_| ui_text("全屏", "Full screen").into());
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
            .map_err(|error| format!("全屏截取失败：{error} / fullscreen capture failed: {error}"))
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
        let (width, height) = annotate_window_logical_size(1200, 700, 1.0, 1920, 1040);
        assert_eq!(width, 1224.0);
        assert_eq!(height, 812.0);

        assert_eq!(
            annotate_window_logical_size(100, 80, 1.0, 1920, 1040),
            (480.0, 360.0)
        );
    }
}
