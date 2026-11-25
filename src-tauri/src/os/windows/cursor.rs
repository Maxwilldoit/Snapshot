//! 静帧截图合成鼠标光标：xcap 只给窗口像素，光标要按热点自己画上去。

use crate::capture::blend_cursor;
use image::{Rgba, RgbaImage};
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetObjectW, SelectObject,
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    },
    UI::WindowsAndMessaging::{
        DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HCURSOR,
        ICONINFO,
    },
};

#[derive(Debug)]
enum CursorGraphic {
    /// 现代 32 位带 alpha 通道的彩色光标（如 Windows 11 箭头、手型）。
    Alpha(RgbaImage),
    /// 老式单色或无 alpha 通道的掩码光标（如文本 I-beam、十字准星）。
    /// 每个像素存 `(and_rgb, xor_rgb)`，合成时按 GDI 语义执行 `(dst & and) ^ xor`，
    /// 同时还原实心黑、实心白、透明和反色笔画，避免白底输入框上反色 I-beam 变白隐身。
    Masked {
        width: u32,
        height: u32,
        pixels: Vec<([u8; 3], [u8; 3])>,
    },
}

/// 从黑底与白底两次 `DrawIconEx` 的 32 位 BGRA DIB 反推出每个像素的 GDI AND/XOR 掩码：
/// 对任意底色 `D`，黑底结果 `B = (0 & M) ^ X = X`，白底结果 `W = (255 & M) ^ X = M ^ X`，
/// 因此 `X = B`、`M = B ^ W`，对目标像素执行 `(D & M) ^ X` 即可无损复现 GDI 行为。
fn masked_from_dibs(
    width: u32,
    height: u32,
    on_black_bgra: &[u8],
    on_white_bgra: &[u8],
) -> Option<CursorGraphic> {
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if on_black_bgra.len() != expected || on_white_bgra.len() != expected {
        return None;
    }
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize));
    let mut has_visible_effect = false;
    for (black, white) in on_black_bgra
        .as_chunks::<4>()
        .0
        .iter()
        .zip(on_white_bgra.as_chunks::<4>().0.iter())
    {
        let b = [black[2], black[1], black[0]];
        let w = [white[2], white[1], white[0]];
        let and = [b[0] ^ w[0], b[1] ^ w[1], b[2] ^ w[2]];
        let xor = b;
        if and != [255, 255, 255] || xor != [0, 0, 0] {
            has_visible_effect = true;
        }
        pixels.push((and, xor));
    }
    if !has_visible_effect {
        return None;
    }
    Some(CursorGraphic::Masked {
        width,
        height,
        pixels,
    })
}

fn apply_masked_cursor(
    canvas: &mut RgbaImage,
    width: u32,
    height: u32,
    pixels: &[([u8; 3], [u8; 3])],
    left: i64,
    top: i64,
) {
    if width == 0 || height == 0 {
        return;
    }
    for (index, &(and, xor)) in pixels.iter().enumerate() {
        if and == [255, 255, 255] && xor == [0, 0, 0] {
            continue;
        }
        let x = (index as u32) % width;
        let y = (index as u32) / width;
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
        canvas.put_pixel(
            target_x as u32,
            target_y as u32,
            Rgba([
                (base[0] & and[0]) ^ xor[0],
                (base[1] & and[1]) ^ xor[1],
                (base[2] & and[2]) ^ xor[2],
                255,
            ]),
        );
    }
}

fn overlay_graphic(canvas: &mut RgbaImage, graphic: &CursorGraphic, left: i64, top: i64) {
    match graphic {
        CursorGraphic::Alpha(cursor) => blend_cursor(canvas, cursor, left, top),
        CursorGraphic::Masked {
            width,
            height,
            pixels,
        } => apply_masked_cursor(canvas, *width, *height, pixels, left, top),
    }
}

/// 将指定系统光标句柄栅格化为位图或掩码，并附带热点坐标。
unsafe fn cursor_graphic_from_hcursor(cursor: HCURSOR) -> Option<(CursorGraphic, i32, i32)> {
    if cursor.is_null() {
        return None;
    }
    let mut icon: ICONINFO = zeroed();
    if GetIconInfo(cursor, &mut icon) == 0 {
        return None;
    }
    // 单色光标的掩码位图是上下两段（AND + XOR），高度要折半才是真实尺寸。
    let mut bitmap: BITMAP = zeroed();
    let (source, halve) = if icon.hbmColor.is_null() {
        (icon.hbmMask, true)
    } else {
        (icon.hbmColor, false)
    };
    let measured = GetObjectW(
        source,
        size_of::<BITMAP>() as i32,
        (&mut bitmap as *mut BITMAP).cast(),
    );
    if !icon.hbmMask.is_null() {
        DeleteObject(icon.hbmMask);
    }
    if !icon.hbmColor.is_null() {
        DeleteObject(icon.hbmColor);
    }
    if measured == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
        return None;
    }
    let width = bitmap.bmWidth;
    let height = if halve {
        bitmap.bmHeight / 2
    } else {
        bitmap.bmHeight
    };
    if height <= 0 {
        return None;
    }

    let dc = CreateCompatibleDC(null_mut());
    if dc.is_null() {
        return None;
    }
    let mut bitmap_info: BITMAPINFO = zeroed();
    bitmap_info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    bitmap_info.bmiHeader.biWidth = width;
    bitmap_info.bmiHeader.biHeight = -height;
    bitmap_info.bmiHeader.biPlanes = 1;
    bitmap_info.bmiHeader.biBitCount = 32;
    bitmap_info.bmiHeader.biCompression = BI_RGB;
    let mut bits: *mut c_void = null_mut();
    let dib = CreateDIBSection(dc, &bitmap_info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
    if dib.is_null() || bits.is_null() {
        DeleteDC(dc);
        return None;
    }
    let old = SelectObject(dc, dib);
    let byte_len = (width * height * 4) as usize;
    let drawn_on_black = DrawIconEx(dc, 0, 0, cursor, width, height, 0, null_mut(), DI_NORMAL);

    let graphic = if drawn_on_black == 0 {
        None
    } else {
        let on_black = std::slice::from_raw_parts(bits as *const u8, byte_len).to_vec();
        let pixels = on_black.as_chunks::<4>().0;
        let has_alpha = pixels.iter().any(|pixel| pixel[3] != 0);
        if has_alpha {
            let mut image = RgbaImage::new(width as u32, height as u32);
            for (index, pixel) in pixels.iter().enumerate() {
                let x = (index as i32) % width;
                let y = (index as i32) / width;
                image.put_pixel(
                    x as u32,
                    y as u32,
                    Rgba([pixel[2], pixel[1], pixel[0], pixel[3]]),
                );
            }
            Some(CursorGraphic::Alpha(image))
        } else {
            // 无 alpha 通道的光标（例如单色/反色 I-beam）在白底上再画一次，
            // 通过黑/白双底反推精确的 AND/XOR 掩码。
            std::slice::from_raw_parts_mut(bits as *mut u8, byte_len).fill(0xFF);
            let drawn_on_white =
                DrawIconEx(dc, 0, 0, cursor, width, height, 0, null_mut(), DI_NORMAL);
            if drawn_on_white == 0 {
                None
            } else {
                let on_white = std::slice::from_raw_parts(bits as *const u8, byte_len);
                masked_from_dibs(width as u32, height as u32, &on_black, on_white)
            }
        }
    };

    SelectObject(dc, old);
    DeleteObject(dib);
    DeleteDC(dc);

    graphic.map(|graphic| (graphic, icon.xHotspot as i32, icon.yHotspot as i32))
}

/// 取当前光标的图形、屏幕位置与热点。热点是光标图内对应「尖端」的那个点，
/// 贴图时要减掉它，否则光标会整体偏右下。
fn cursor_bitmap() -> Option<(CursorGraphic, i32, i32, i32, i32)> {
    unsafe {
        let mut info: CURSORINFO = zeroed();
        info.cbSize = size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut info) == 0 || info.flags != CURSOR_SHOWING || info.hCursor.is_null() {
            return None;
        }
        let (graphic, hot_x, hot_y) = cursor_graphic_from_hcursor(info.hCursor)?;
        Some((
            graphic,
            info.ptScreenPos.x,
            info.ptScreenPos.y,
            hot_x,
            hot_y,
        ))
    }
}

/// 截图像素与逻辑点的比例，以及光标贴图的左上角像素坐标。
/// 与 macOS 的 cursor.rs 同一套算法：先按缩放把「光标相对窗口的位移」换算成像素，
/// 再减掉热点——热点是光标图内对应尖端的那个点，不减会整体偏右下。
fn overlay_origin_px(
    cursor_screen: (i32, i32),
    hot_spot: (i32, i32),
    window_origin: (i32, i32),
    scale: f64,
) -> (i32, i32) {
    let left = (f64::from(cursor_screen.0 - window_origin.0) * scale).round() as i32 - hot_spot.0;
    let top = (f64::from(cursor_screen.1 - window_origin.1) * scale).round() as i32 - hot_spot.1;
    (left, top)
}

/// 把当前光标合成进刚截下来的位图。
///
/// `window_origin` / `logical_width` 是 xcap 报的窗口左上角与逻辑宽度，
/// 用来换算截图像素与点的比例。失败一律返回 Err，由调用方拼成降级说明，
/// 避免用户开了「包含光标」却拿到一张没光标的图而毫不知情。
pub fn overlay_into(
    image: &mut RgbaImage,
    window_origin: (i32, i32),
    logical_width: u32,
) -> Result<(), String> {
    if logical_width == 0 {
        return Err("窗口逻辑宽度为 0，无法换算缩放".into());
    }
    let scale = f64::from(image.width()) / f64::from(logical_width);
    if !(0.5..=4.0).contains(&scale) {
        return Err(format!("截图与窗口的缩放比例异常（{scale:.2}）"));
    }
    let (cursor, screen_x, screen_y, hot_x, hot_y) =
        cursor_bitmap().ok_or("取不到当前系统光标位图")?;
    let (left, top) = overlay_origin_px((screen_x, screen_y), (hot_x, hot_y), window_origin, scale);
    overlay_graphic(image, &cursor, i64::from(left), i64::from(top));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, IDC_ARROW, IDC_CROSS, IDC_IBEAM,
    };

    #[test]
    fn origin_subtracts_hot_spot_and_window_offset() {
        // 光标在 (120,140)，窗口左上角 (100,100)，热点 (4,4)，1x 屏
        assert_eq!(
            overlay_origin_px((120, 140), (4, 4), (100, 100), 1.0),
            (16, 36)
        );
    }

    #[test]
    fn high_dpi_scale_doubles_the_offset() {
        // 同样的点位，200% 缩放下像素偏移要翻倍；热点是图内坐标，不参与缩放
        assert_eq!(
            overlay_origin_px((120, 140), (4, 4), (100, 100), 2.0),
            (36, 76)
        );
    }

    #[test]
    fn masked_cursor_preserves_transparent_opaque_and_invert_pixels() {
        // 4 个像素依次为：透明、实心黑、实心白、XOR 反色（BGRA 顺序）
        let on_black = [
            0, 0, 0, 0, // transparent: (0 & 1) ^ 0 = 0
            0, 0, 0, 0, // opaque black: (0 & 0) ^ 0 = 0
            255, 255, 255, 0, // opaque white: (0 & 0) ^ 255 = 255
            255, 255, 255, 0, // XOR invert: (0 & 1) ^ 255 = 255
        ];
        let on_white = [
            255, 255, 255, 255, // transparent: (255 & 1) ^ 0 = 255
            0, 0, 0, 255, // opaque black: (255 & 0) ^ 0 = 0
            255, 255, 255, 255, // opaque white: (255 & 0) ^ 255 = 255
            0, 0, 0, 255, // XOR invert: (255 & 1) ^ 255 = 0
        ];
        let graphic = masked_from_dibs(4, 1, &on_black, &on_white).expect("应当识别为有效掩码光标");

        // 叠到浅灰底 (240, 200, 160)
        let mut light = RgbaImage::from_pixel(4, 1, Rgba([240, 200, 160, 255]));
        overlay_graphic(&mut light, &graphic, 0, 0);
        assert_eq!(*light.get_pixel(0, 0), Rgba([240, 200, 160, 255])); // 透明保持原样
        assert_eq!(*light.get_pixel(1, 0), Rgba([0, 0, 0, 255])); // 实心黑保留，不会被当成透明丢弃
        assert_eq!(*light.get_pixel(2, 0), Rgba([255, 255, 255, 255])); // 实心白保留
        assert_eq!(*light.get_pixel(3, 0), Rgba([15, 55, 95, 255])); // 反色精确取反

        // 叠到纯白底 (255, 255, 255)：XOR 反色像素变成纯黑可见，不再白底隐身
        let mut white = RgbaImage::from_pixel(4, 1, Rgba([255, 255, 255, 255]));
        overlay_graphic(&mut white, &graphic, 0, 0);
        assert_eq!(*white.get_pixel(3, 0), Rgba([0, 0, 0, 255]));

        // 全透明空光标返回 None
        let empty_black = [0u8; 4];
        let empty_white = [255u8; 4];
        assert!(masked_from_dibs(1, 1, &empty_black, &empty_white).is_none());
    }

    #[test]
    fn system_ibeam_and_cross_are_visible_on_both_white_and_black_backgrounds() {
        for cursor_id in [IDC_IBEAM, IDC_CROSS] {
            let hcursor = unsafe { LoadCursorW(null_mut(), cursor_id) };
            assert!(!hcursor.is_null());
            let (graphic, _, _) =
                unsafe { cursor_graphic_from_hcursor(hcursor) }.expect("系统单色光标不应被丢弃");

            let mut white = RgbaImage::from_pixel(64, 64, Rgba([255, 255, 255, 255]));
            overlay_graphic(&mut white, &graphic, 8, 8);
            let dark_on_white = white
                .pixels()
                .filter(|p| p[0] < 128 && p[1] < 128 && p[2] < 128)
                .count();
            assert!(
                dark_on_white > 0,
                "单色/反色光标叠在纯白文本框上必须出现可见深色笔画"
            );

            let mut black = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 255]));
            overlay_graphic(&mut black, &graphic, 8, 8);
            let light_on_black = black
                .pixels()
                .filter(|p| p[0] > 128 && p[1] > 128 && p[2] > 128)
                .count();
            assert!(
                light_on_black > 0,
                "单色/反色光标叠在纯黑深色模式背景上必须出现可见浅色笔画"
            );
        }
    }

    #[test]
    fn system_arrow_cursor_overlays_visibly() {
        let hcursor = unsafe { LoadCursorW(null_mut(), IDC_ARROW) };
        assert!(!hcursor.is_null());
        let (graphic, _, _) =
            unsafe { cursor_graphic_from_hcursor(hcursor) }.expect("系统箭头光标不应失败");
        let mut canvas = RgbaImage::from_pixel(64, 64, Rgba([120, 120, 120, 255]));
        overlay_graphic(&mut canvas, &graphic, 8, 8);
        let changed = canvas
            .pixels()
            .filter(|p| **p != Rgba([120, 120, 120, 255]))
            .count();
        assert!(changed > 0, "箭头光标应当在画布上留下可见像素");
    }
}
