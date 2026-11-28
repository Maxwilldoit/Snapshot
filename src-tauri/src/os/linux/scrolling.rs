//! 滚动长截图：X11 下对目标窗口连拍 + xdotool 翻页 + 纵向重叠拼接。
//! 纯 Wayland（无 `$DISPLAY`）返回可读双语错误。

use image::RgbaImage;
use std::process::Command;
use std::thread;
use std::time::Duration;
use xcap::Window;

use super::session::{is_wayland_session, x11_display};
use super::window::restore_minimized;

const MAX_FRAMES: usize = 28;
const SCROLL_SETTLE_MS: u64 = 280;
const OVERLAP_SEARCH_MIN: u32 = 24;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScrollMethod {
    PageDown,
    Wheel,
}

/// 对指定窗口做滚动长截图（best-effort）。
pub fn capture_scrolling_window(window_id: u32) -> Result<RgbaImage, String> {
    if is_wayland_session() || x11_display().is_none() {
        return Err("滚动长截图需要 X11/`$DISPLAY`（xdotool 翻页）。纯 Wayland 尚不支持".into());
    }

    ensure_xdotool()?;

    let window = find_window(window_id)?;

    if window.is_minimized().unwrap_or(false) {
        restore_minimized(window_id)?;
    }

    activate_window(window_id)?;
    let saved_mouse = query_mouse_location();

    let result = capture_frames_loop(window_id, &window);

    if let Some((mx, my)) = saved_mouse {
        restore_mouse_location(mx, my);
    }

    let frames = result?;
    if frames.len() < 2 {
        return frames
            .into_iter()
            .next()
            .ok_or_else(|| "未能截取滚动帧".into());
    }

    stitch_vertical(frames)
}

fn find_window(window_id: u32) -> Result<Window, String> {
    Window::all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|w| w.id().ok() == Some(window_id))
        .ok_or_else(|| "目标窗口已经关闭".to_string())
}

fn capture_frames_loop(window_id: u32, initial: &Window) -> Result<Vec<RgbaImage>, String> {
    let mut frames: Vec<RgbaImage> = Vec::new();
    frames.push(capture_one(initial)?);
    let mut method = ScrollMethod::PageDown;

    for step in 1..MAX_FRAMES {
        if active_window_id() != Some(window_id) {
            if step == 1 {
                activate_window(window_id)?;
                if active_window_id() != Some(window_id) {
                    return Err("无法激活目标窗口".into());
                }
            } else {
                // 用户中途切走了焦点，立刻停手并拼接已有帧，绝不往别的窗口发翻页键
                break;
            }
        }

        let current_window = find_window(window_id)?;
        scroll_once(&current_window, method)?;
        thread::sleep(Duration::from_millis(SCROLL_SETTLE_MS));

        let refreshed = find_window(window_id)?;
        let mut next = capture_one(&refreshed)?;
        let prev = frames.last().expect("frames non-empty");

        // 首帧若 Page_Down 没滚起来（如焦点落在地址栏或工具条上），再试一次窗口中心的滚轮
        if step == 1
            && method == ScrollMethod::PageDown
            && images_nearly_equal(prev, &next)
            && active_window_id() == Some(window_id)
        {
            if scroll_once(&refreshed, ScrollMethod::Wheel).is_ok() {
                thread::sleep(Duration::from_millis(SCROLL_SETTLE_MS));
                let after_wheel = find_window(window_id)?;
                next = capture_one(&after_wheel)?;
                if !images_nearly_equal(prev, &next) {
                    method = ScrollMethod::Wheel;
                }
            }
        }

        if images_nearly_equal(prev, &next) {
            break;
        }
        frames.push(next);
    }

    Ok(frames)
}

/// 本机能力里的「滚动长截图」也按这个判断，免得显示可用、一滚才报错
pub(super) fn ensure_xdotool() -> Result<(), String> {
    if Command::new("xdotool").arg("-version").output().is_err() {
        return Err("滚动长截图需要 xdotool，请安装后重试（如 apt install xdotool）".into());
    }
    Ok(())
}

fn activate_window(id: u32) -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["windowactivate", "--sync", &id.to_string()])
        .status()
        .map_err(|_| "无法激活目标窗口（xdotool）".to_string())?;
    if !status.success() {
        return Err("无法激活目标窗口".into());
    }
    thread::sleep(Duration::from_millis(120));
    Ok(())
}

fn active_window_id() -> Option<u32> {
    let output = Command::new("xdotool")
        .arg("getactivewindow")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .ok()
}

/// 发送一次翻页：不传 `--window` 以走 XTEST（GTK3/GTK4/WebKitGTK/Electron 等 XInput2 客户端
/// 会静默忽略 `--window` 触发的合成 XSendEvent）；调用方已核对当前活动窗口就是目标窗。
fn scroll_once(window: &Window, method: ScrollMethod) -> Result<(), String> {
    match method {
        ScrollMethod::PageDown => {
            let status = Command::new("xdotool")
                .args(["key", "--clearmodifiers", "Page_Down"])
                .status();
            match status {
                Ok(code) if code.success() => Ok(()),
                _ => Err("无法向目标窗口发送翻页（xdotool）".into()),
            }
        }
        ScrollMethod::Wheel => {
            let x = window.x().unwrap_or(0).max(0);
            let y = window.y().unwrap_or(0).max(0);
            let w = window.width().unwrap_or(160).max(40) as i32;
            let h = window.height().unwrap_or(160).max(40) as i32;
            let cx = (x + w / 2).to_string();
            let cy = (y + h / 2).to_string();
            let status = Command::new("xdotool")
                .args([
                    "mousemove",
                    "--sync",
                    &cx,
                    &cy,
                    "click",
                    "--clearmodifiers",
                    "--repeat",
                    "5",
                    "--delay",
                    "18",
                    "5",
                ])
                .status();
            match status {
                Ok(code) if code.success() => Ok(()),
                _ => Err("无法向目标窗口发送翻页（xdotool）".into()),
            }
        }
    }
}

fn query_mouse_location() -> Option<(i32, i32)> {
    let output = Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_mouse_location(&String::from_utf8_lossy(&output.stdout))
}

fn parse_mouse_location(shell_output: &str) -> Option<(i32, i32)> {
    let mut x = None;
    let mut y = None;
    for line in shell_output.lines() {
        if let Some(val) = line.strip_prefix("X=") {
            x = val.trim().parse::<i32>().ok();
        } else if let Some(val) = line.strip_prefix("Y=") {
            y = val.trim().parse::<i32>().ok();
        }
    }
    Some((x?, y?))
}

fn restore_mouse_location(x: i32, y: i32) {
    let _ = Command::new("xdotool")
        .args(["mousemove", &x.to_string(), &y.to_string()])
        .status();
}

fn capture_one(window: &Window) -> Result<RgbaImage, String> {
    window
        .capture_image()
        .map_err(|error| format!("滚动截取失败：{error}"))
}

fn images_nearly_equal(a: &RgbaImage, b: &RgbaImage) -> bool {
    if a.width() != b.width() || a.height() != b.height() {
        return false;
    }
    let step = 8u32;
    let mut checked = 0u32;
    let mut close = 0u32;
    let h = a.height();
    let w = a.width();
    let mut y = 0u32;
    while y < h {
        let mut x = 0u32;
        while x < w {
            checked += 1;
            let pa = a.get_pixel(x, y).0;
            let pb = b.get_pixel(x, y).0;
            let diff = pa
                .iter()
                .zip(pb.iter())
                .map(|(l, r)| (*l as i16 - *r as i16).unsigned_abs() as u32)
                .sum::<u32>();
            if diff < 48 {
                close += 1;
            }
            x = x.saturating_add(step);
        }
        y = y.saturating_add(step);
    }
    checked > 0 && (close as f32 / checked as f32) > 0.985
}

fn find_overlap(prev: &RgbaImage, next: &RgbaImage) -> u32 {
    const SCROLLBAR_GUTTER: u32 = 20;
    let width = prev.width().min(next.width());
    let max_overlap = prev.height().min(next.height()).saturating_sub(8);
    if max_overlap < OVERLAP_SEARCH_MIN || width < 8 {
        return OVERLAP_SEARCH_MIN.min(prev.height().min(next.height()) / 3);
    }

    // 避开右侧滚动条滑块区域，防止滑块下移干扰内容重叠打分
    let content_width = if width > SCROLLBAR_GUTTER * 2 {
        width - SCROLLBAR_GUTTER
    } else {
        width
    };

    let mut best_overlap = OVERLAP_SEARCH_MIN;
    let mut best_score = u64::MAX;
    let sample_step = 6u32;

    for overlap in OVERLAP_SEARCH_MIN..=max_overlap {
        let mut score = 0u64;
        let mut samples = 0u64;
        let row_step = if overlap >= 48 { sample_step } else { 3 };
        let mut row = 0u32;
        while row < overlap {
            let py = prev.height() - overlap + row;
            let mut x = 0u32;
            while x < content_width {
                let pa = prev.get_pixel(x, py).0;
                let pb = next.get_pixel(x, row).0;
                for i in 0..3 {
                    let d = pa[i] as i32 - pb[i] as i32;
                    score += (d * d) as u64;
                }
                samples += 1;
                x = x.saturating_add(sample_step);
            }
            row = row.saturating_add(row_step);
        }
        let normalized = score.checked_div(samples).unwrap_or(u64::MAX);
        if normalized < best_score {
            best_score = normalized;
            best_overlap = overlap;
        }
    }
    best_overlap
}

fn blit_rows(
    dest: &mut RgbaImage,
    dest_y: u32,
    src: &RgbaImage,
    src_y: u32,
    rows: u32,
    width: u32,
) {
    for row in 0..rows {
        for x in 0..width {
            let pixel = *src.get_pixel(x, src_y + row);
            dest.put_pixel(x, dest_y + row, pixel);
        }
    }
}

fn stitch_vertical(frames: Vec<RgbaImage>) -> Result<RgbaImage, String> {
    let width = frames
        .iter()
        .map(|f| f.width())
        .min()
        .ok_or_else(|| "无帧可拼接".to_string())?;
    if width < 2 {
        return Err("滚动截图像素宽度无效".into());
    }

    let mut total_height = frames[0].height();
    let mut overlaps = Vec::with_capacity(frames.len().saturating_sub(1));
    for i in 1..frames.len() {
        let overlap = find_overlap(&frames[i - 1], &frames[i]);
        overlaps.push(overlap);
        total_height = total_height.saturating_add(frames[i].height().saturating_sub(overlap));
    }

    if total_height > 32_000 {
        return Err("拼接结果过高（可能重叠检测失败），已中止".into());
    }

    let mut canvas = RgbaImage::new(width, total_height);
    blit_rows(&mut canvas, 0, &frames[0], 0, frames[0].height(), width);

    let mut cursor_y = frames[0].height();
    for (i, frame) in frames.iter().enumerate().skip(1) {
        let overlap = overlaps[i - 1];
        let append_h = frame.height().saturating_sub(overlap);
        if append_h == 0 {
            continue;
        }
        blit_rows(&mut canvas, cursor_y, frame, overlap, append_h, width);
        cursor_y = cursor_y.saturating_add(append_h);
    }

    if cursor_y < total_height {
        Ok(image::imageops::crop_imm(&canvas, 0, 0, width, cursor_y).to_image())
    } else {
        Ok(canvas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, shade: u8) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([shade, shade, shade, 255]))
    }

    #[test]
    fn nearly_equal_detects_identical() {
        let a = solid(40, 40, 10);
        let b = solid(40, 40, 10);
        assert!(images_nearly_equal(&a, &b));
    }

    #[test]
    fn stitch_appends_with_overlap() {
        let mut top = solid(20, 40, 20);
        let mut bottom = solid(20, 40, 200);
        for y in 24..40 {
            for x in 0..20 {
                top.put_pixel(x, y, Rgba([90, 90, 90, 255]));
                bottom.put_pixel(x, y - 24, Rgba([90, 90, 90, 255]));
            }
        }
        let stitched = stitch_vertical(vec![top, bottom]).expect("stitch");
        assert_eq!(stitched.width(), 20);
        assert!(stitched.height() > 40);
        assert!(stitched.height() <= 64);
    }

    #[test]
    fn find_overlap_handles_non_multiple_of_four_and_ignores_scrollbar_gutter() {
        // 模拟 120×100 窗口翻页后重叠 42px（非 4 的倍数），且右侧 16px 滚动条位置完全不同
        let full = RgbaImage::from_fn(120, 158, |x, y| {
            Rgba([
                ((x * 7 + y * 13) % 251) as u8,
                ((y * 17) % 239) as u8,
                ((x * 11 + y * 5) % 241) as u8,
                255,
            ])
        });
        let mut top = image::imageops::crop_imm(&full, 0, 0, 120, 100).to_image();
        let mut bottom = image::imageops::crop_imm(&full, 0, 58, 120, 100).to_image();
        for y in 0..100 {
            for x in 104..120 {
                top.put_pixel(
                    x,
                    y,
                    if y < 30 {
                        Rgba([40, 40, 40, 255])
                    } else {
                        Rgba([240, 240, 240, 255])
                    },
                );
                bottom.put_pixel(
                    x,
                    y,
                    if y > 70 {
                        Rgba([40, 40, 40, 255])
                    } else {
                        Rgba([240, 240, 240, 255])
                    },
                );
            }
        }
        assert_eq!(find_overlap(&top, &bottom), 42);
        let stitched = stitch_vertical(vec![top, bottom]).expect("stitch");
        assert_eq!(stitched.dimensions(), (120, 158));
    }

    #[test]
    fn parses_xdotool_shell_mouse_location() {
        let raw = "X=512\nY=384\nSCREEN=0\nWINDOW=12582915\n";
        assert_eq!(parse_mouse_location(raw), Some((512, 384)));
        assert_eq!(parse_mouse_location("SCREEN=0\n"), None);
    }
}
