//! 静帧截取辅助：X11 下可用 ffmpeg x11grab 带光标抓一帧。

use image::RgbaImage;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static CURSOR_CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

fn display_spec() -> Result<String, String> {
    super::session::x11_display()
        .filter(|_| !super::session::is_wayland_session())
        .ok_or_else(|| "无 X11 DISPLAY，无法用 x11grab 抓带光标静帧".to_string())
}

fn clamp_x11_rect(x: i32, y: i32, width: u32, height: u32) -> Result<(i32, i32, u32, u32), String> {
    let crop_x = x.max(0);
    let crop_y = y.max(0);
    let clamped_width = width.saturating_sub(crop_x.abs_diff(x));
    let clamped_height = height.saturating_sub(crop_y.abs_diff(y));
    if clamped_width < 2 || clamped_height < 2 {
        return Err("截取区域太小".into());
    }
    Ok((crop_x, crop_y, clamped_width, clamped_height))
}

fn capture_rect_with_cursor(x: i32, y: i32, width: u32, height: u32) -> Result<RgbaImage, String> {
    let (x, y, width, height) = clamp_x11_rect(x, y, width, height)?;
    let display = display_spec()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = CURSOR_CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let path = std::env::temp_dir().join(format!("snapshot-cursor-{pid}-{stamp}-{seq}.png"));
    let input = format!("{display}+{x},{y}");
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "x11grab",
            "-draw_mouse",
            "1",
            "-video_size",
            &format!("{width}x{height}"),
            "-i",
            &input,
            "-frames:v",
            "1",
            "-update",
            "1",
        ])
        .arg(&path)
        .status()
        .map_err(|_| "未找到 ffmpeg，无法抓带光标静帧".to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        return Err("ffmpeg x11grab 抓带光标静帧失败".into());
    }
    let opened = image::open(&path);
    let _ = std::fs::remove_file(&path);
    let image = opened
        .map_err(|error| format!("读取光标静帧失败：{error}"))?
        .to_rgba8();
    Ok(image)
}

/// 任意屏幕矩形静帧（含鼠标光标）。窗口与全屏截图都按各自的矩形调用；失败由调用方回退。
pub fn capture_region_with_cursor(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    capture_rect_with_cursor(x, y, width, height)
}
