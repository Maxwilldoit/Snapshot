//! GDI capture for our main HWND, which xcap excludes from window enumeration.

use image::RgbaImage;
use std::{mem::size_of, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::{
            CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
            GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
            DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
        },
    },
    System::Threading::GetCurrentProcessId,
    UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowThreadProcessId, IsIconic, PW_RENDERFULLCONTENT,
    },
};

// The generated binding lives behind Win32_Storage_Xps, which this crate does
// not enable. Keep the exact User32 ABI here instead of adding a feature.
#[link(name = "user32")]
extern "system" {
    fn PrintWindow(hwnd: HWND, hdc: HDC, flags: u32) -> i32;
}

/// Physical screen origin and size of the pixels returned by capture_own_window.
/// Use this origin for cursor composition after the invisible border is cropped.
/// Query close to capture time; moving/resizing between calls changes geometry.
pub(crate) fn capture_own_window_bounds(hwnd: isize) -> Result<(i32, i32, u32, u32), String> {
    let (window, frame) = read_window_geometry(hwnd as HWND)?;
    cropped_bounds(&window, &frame)
}

fn read_window_geometry(hwnd: HWND) -> Result<(RECT, RECT), String> {
    unsafe {
        let mut pid = 0;
        if hwnd.is_null() || GetWindowThreadProcessId(hwnd, &mut pid) == 0 {
            return Err("Invalid own-window HWND".into());
        }
        if pid != GetCurrentProcessId() {
            return Err("Capture HWND does not belong to this process".into());
        }
        if IsIconic(hwnd) != 0 {
            return Err("Restore the own window before capturing it".into());
        }

        // PrintWindow includes the non-client area and invisible resize border.
        // Our own Tauri window is DPI-aware; both rectangles use physical pixels.
        let mut window = RECT::default();
        if GetWindowRect(hwnd, &mut window) == 0 {
            return Err(win32_error("GetWindowRect"));
        }
        let mut frame = RECT::default();
        let status = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut frame as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        );
        if status < 0 {
            return Err(format!(
                "DwmGetWindowAttribute failed (HRESULT 0x{:08X})",
                status as u32
            ));
        }
        Ok((window, frame))
    }
}

/// Capture our main window, including content covered by other windows.
///
/// Call from a blocking worker: PrintWindow synchronously asks the window to
/// paint, so the UI thread must remain free to service that request. The caller
/// must restore a minimized window before calling. No UI dispatch is performed.
pub(crate) fn capture_own_window(hwnd: isize) -> Result<RgbaImage, String> {
    let hwnd = hwnd as HWND;
    let (window, frame) = read_window_geometry(hwnd)?;
    unsafe {
        let (width, height) = rect_size(&window)?;
        let buffer_len = pixel_buffer_len(width, height)?;
        let (x, y, crop_width, crop_height) = visible_crop(&window, &frame)?;

        // Install the guard before the first acquisition. Every early return
        // below releases all successfully acquired handles.
        let mut resources = CaptureResources {
            hwnd,
            window_dc: null_mut(),
            memory_dc: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
        };
        resources.window_dc = GetWindowDC(hwnd);
        if resources.window_dc.is_null() {
            return Err(win32_error("GetWindowDC"));
        }
        resources.memory_dc = CreateCompatibleDC(resources.window_dc);
        if resources.memory_dc.is_null() {
            return Err(win32_error("CreateCompatibleDC"));
        }
        resources.bitmap = CreateCompatibleBitmap(resources.window_dc, width, height);
        if resources.bitmap.is_null() {
            return Err(win32_error("CreateCompatibleBitmap"));
        }
        let previous = SelectObject(resources.memory_dc, resources.bitmap);
        if invalid_object(previous) {
            return Err(win32_error("SelectObject"));
        }
        resources.previous = previous;

        if PrintWindow(hwnd, resources.memory_dc, PW_RENDERFULLCONTENT) == 0 {
            // Never substitute a desktop BitBlt: occlusion would change pixels.
            return Err("PrintWindow(PW_RENDERFULLCONTENT) failed".into());
        }

        // GetDIBits requires the bitmap to be deselected from every DC.
        if invalid_object(SelectObject(resources.memory_dc, resources.previous)) {
            return Err(win32_error("SelectObject (restore)"));
        }
        resources.previous = null_mut();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Negative means top-down, not bottom-up.
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: buffer_len as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(buffer_len)
            .map_err(|error| format!("Cannot allocate capture buffer: {error}"))?;
        pixels.resize(buffer_len, 0);
        let rows = GetDIBits(
            resources.memory_dc,
            resources.bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        if rows != height {
            return Err(format!(
                "GetDIBits returned {rows} of {height} requested rows"
            ));
        }
        // Release native resources before allocating/copying the cropped image.
        drop(resources);
        let image = bgra_to_rgba(pixels, width, height)?;
        Ok(image::imageops::crop_imm(&image, x, y, crop_width, crop_height).to_image())
    }
}

struct CaptureResources {
    hwnd: HWND,
    window_dc: HDC,
    memory_dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        unsafe {
            if !self.memory_dc.is_null() {
                if !self.previous.is_null() {
                    SelectObject(self.memory_dc, self.previous);
                }
                // Destroy the memory DC before the bitmap, so even a failed
                // restore cannot leave that bitmap selected when it is deleted.
                DeleteDC(self.memory_dc);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.window_dc.is_null() {
                ReleaseDC(self.hwnd, self.window_dc);
            }
        }
    }
}

fn invalid_object(object: HGDIOBJ) -> bool {
    object.is_null() || object as isize == -1
}

fn win32_error(operation: &str) -> String {
    format!("{operation} failed: {}", std::io::Error::last_os_error())
}

fn rect_size(rect: &RECT) -> Result<(i32, i32), String> {
    let width = i64::from(rect.right) - i64::from(rect.left);
    let height = i64::from(rect.bottom) - i64::from(rect.top);
    if width <= 0 || height <= 0 || width > i64::from(i32::MAX) || height > i64::from(i32::MAX) {
        return Err("Invalid capture rectangle dimensions".into());
    }
    Ok((width as i32, height as i32))
}

fn pixel_buffer_len(width: i32, height: i32) -> Result<usize, String> {
    if width <= 0 || height <= 0 {
        return Err("Capture dimensions must be positive".into());
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        // BITMAPINFOHEADER::biSizeImage is a DWORD; Vec also needs <= isize::MAX.
        .filter(|&bytes| bytes <= u32::MAX as usize && bytes <= isize::MAX as usize)
        .ok_or_else(|| "Capture pixel buffer is too large".into())
}

/// Translate DWM screen coordinates into the full window bitmap. Intersect
/// first: maximized windows can have resize borders outside the visible frame.
fn visible_crop(window: &RECT, frame: &RECT) -> Result<(u32, u32, u32, u32), String> {
    rect_size(window)?;
    rect_size(frame)?;
    let visible = RECT {
        left: window.left.max(frame.left),
        top: window.top.max(frame.top),
        right: window.right.min(frame.right),
        bottom: window.bottom.min(frame.bottom),
    };
    let (width, height) = rect_size(&visible)?;
    Ok((
        (i64::from(visible.left) - i64::from(window.left)) as u32,
        (i64::from(visible.top) - i64::from(window.top)) as u32,
        width as u32,
        height as u32,
    ))
}

fn cropped_bounds(window: &RECT, frame: &RECT) -> Result<(i32, i32, u32, u32), String> {
    let (x, y, width, height) = visible_crop(window, frame)?;
    // visible_crop guarantees these sums stay inside the original i32 RECT.
    Ok((
        (i64::from(window.left) + i64::from(x)) as i32,
        (i64::from(window.top) + i64::from(y)) as i32,
        width,
        height,
    ))
}

fn bgra_to_rgba(mut pixels: Vec<u8>, width: i32, height: i32) -> Result<RgbaImage, String> {
    if pixels.len() != pixel_buffer_len(width, height)? {
        return Err("Capture pixel buffer length does not match dimensions".into());
    }
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
        // A 32-bit BI_RGB bitmap has B, G, R and an unused byte, not alpha.
        // Make the captured visible window opaque regardless of that byte.
        pixel[3] = 255;
    }
    RgbaImage::from_raw(width as u32, height as u32, pixels)
        .ok_or_else(|| "Cannot construct captured RGBA image".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn conversion_preserves_top_down_rows_and_makes_bgrx_opaque() {
        let image = bgra_to_rgba(vec![3, 2, 1, 0, 30, 20, 10, 127], 1, 2).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [1, 2, 3, 255]);
        assert_eq!(image.get_pixel(0, 1).0, [10, 20, 30, 255]);
        assert!(bgra_to_rgba(vec![0; 3], 1, 1).is_err());
    }

    #[test]
    fn crops_invisible_borders_on_a_negative_origin_monitor() {
        let window = rect(-108, -58, 108, 158);
        let frame = rect(-100, -50, 100, 150);
        assert_eq!(visible_crop(&window, &frame).unwrap(), (8, 8, 200, 200));

        let mut pixels = vec![0; 216 * 216 * 4];
        let first_visible = (8 * 216 + 8) * 4;
        pixels[first_visible..first_visible + 4].copy_from_slice(&[30, 20, 10, 0]);
        let image = bgra_to_rgba(pixels, 216, 216).unwrap();
        let (x, y, width, height) = visible_crop(&window, &frame).unwrap();
        let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
        assert_eq!(cropped.dimensions(), (200, 200));
        assert_eq!(cropped.get_pixel(0, 0).0, [10, 20, 30, 255]);
        assert_eq!(
            visible_crop(&window, &rect(-200, -100, 200, 200)).unwrap(),
            (0, 0, 216, 216)
        );
    }

    #[test]
    fn rejects_invalid_dimensions_overflow_and_disjoint_frames() {
        for (width, height) in [(0, 1), (1, 0), (-1, 1), (1, -1), (i32::MAX, i32::MAX)] {
            assert!(pixel_buffer_len(width, height).is_err());
        }
        assert!(rect_size(&rect(i32::MIN, 0, i32::MAX, 1)).is_err());
        assert!(visible_crop(&rect(0, 0, 10, 10), &rect(10, 0, 20, 10)).is_err());
        assert!(visible_crop(&rect(0, 0, 10, 10), &rect(1, 1, 1, 5)).is_err());
    }

    #[test]
    fn cursor_bounds_match_the_actual_crop_in_screen_coordinates() {
        let window = rect(-108, -58, 108, 158);
        assert_eq!(
            cropped_bounds(&window, &rect(-100, -50, 100, 150)).unwrap(),
            (-100, -50, 200, 200)
        );
        assert_eq!(
            cropped_bounds(&window, &rect(-200, -100, 200, 200)).unwrap(),
            (-108, -58, 216, 216)
        );
        assert_eq!(
            cropped_bounds(
                &rect(i32::MAX - 10, 0, i32::MAX, 10),
                &rect(i32::MAX - 5, 1, i32::MAX, 9)
            )
            .unwrap(),
            (i32::MAX - 5, 1, 5, 8)
        );
        assert!(cropped_bounds(&window, &rect(200, 200, 300, 300)).is_err());
    }

    #[cfg(windows)]
    mod synthetic_window {
        use super::*;
        use std::{
            sync::{
                atomic::{AtomicBool, Ordering},
                mpsc::{self, Receiver, Sender},
                Arc,
            },
            thread,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{
            Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM},
            Graphics::Gdi::{
                BeginPaint, CreateSolidBrush, EndPaint, FillRect, UpdateWindow, PAINTSTRUCT,
            },
            System::Threading::GetCurrentThreadId,
            UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
                IsWindow, IsWindowVisible, PeekMessageW, RegisterClassW, ShowWindow,
                TranslateMessage, UnregisterClassW, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, WM_PAINT,
                WM_PRINT, WM_PRINTCLIENT, WNDCLASSW, WS_POPUP,
            },
        };

        // LibraryLoader is not an enabled windows-sys feature either.
        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
        }

        #[link(name = "user32")]
        extern "system" {
            fn SetThreadDpiAwarenessContext(
                context: *mut std::ffi::c_void,
            ) -> *mut std::ffi::c_void;
        }

        // cargo's test executable need not have Tauri's DPI-aware manifest.
        // Change only the two participating threads, then restore their context.
        struct PhysicalPixels(*mut std::ffi::c_void);

        impl PhysicalPixels {
            fn enter() -> Result<Self, String> {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
                let previous =
                    unsafe { SetThreadDpiAwarenessContext(-4isize as *mut std::ffi::c_void) };
                if previous.is_null() {
                    return Err(win32_error("SetThreadDpiAwarenessContext"));
                }
                Ok(Self(previous))
            }
        }

        impl Drop for PhysicalPixels {
            fn drop(&mut self) {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }

        unsafe fn paint_colors(hwnd: HWND, dc: HDC) {
            let mut client = RECT::default();
            if dc.is_null() || GetClientRect(hwnd, &mut client) == 0 {
                return;
            }
            let mid_x = client.right / 2;
            let mid_y = client.bottom / 2;
            // COLORREF is 0x00BBGGRR. Every pixel originates in this test.
            for (area, color) in [
                (rect(0, 0, mid_x, mid_y), 0x000000ff),
                (rect(mid_x, 0, client.right, mid_y), 0x0000ff00),
                (rect(0, mid_y, mid_x, client.bottom), 0x00ff0000),
                (rect(mid_x, mid_y, client.right, client.bottom), 0x0000ffff),
            ] {
                let brush = CreateSolidBrush(color);
                if !brush.is_null() {
                    FillRect(dc, &area, brush);
                    DeleteObject(brush);
                }
            }
        }

        unsafe extern "system" fn window_proc(
            hwnd: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            match message {
                WM_PRINT | WM_PRINTCLIENT => {
                    paint_colors(hwnd, wparam as HDC);
                    0
                }
                WM_PAINT => {
                    let mut paint = PAINTSTRUCT::default();
                    let dc = BeginPaint(hwnd, &mut paint);
                    paint_colors(hwnd, dc);
                    EndPaint(hwnd, &paint);
                    0
                }
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            }
        }

        struct SyntheticWindow {
            hwnd: isize,
            stop: Arc<AtomicBool>,
            done: Receiver<Result<(), String>>,
            closed: bool,
        }

        impl SyntheticWindow {
            fn start() -> Result<Self, String> {
                let (ready_tx, ready_rx) = mpsc::channel();
                let (done_tx, done_rx) = mpsc::channel();
                let stop = Arc::new(AtomicBool::new(false));
                let thread_stop = stop.clone();
                thread::spawn(move || {
                    let result = run_window(ready_tx, thread_stop);
                    let _ = done_tx.send(result);
                });
                // Install cleanup before waiting, including the startup failure path.
                let mut window = Self {
                    hwnd: 0,
                    stop,
                    done: done_rx,
                    closed: false,
                };
                window.hwnd = ready_rx
                    .recv_timeout(Duration::from_secs(3))
                    .map_err(|error| format!("Synthetic window startup: {error}"))??;
                Ok(window)
            }

            fn shutdown(&mut self) -> Result<(), String> {
                if self.closed {
                    return Ok(());
                }
                self.closed = true;
                self.stop.store(true, Ordering::Release);
                // No synchronous window message or unbounded thread join.
                self.done
                    .recv_timeout(Duration::from_secs(2))
                    .map_err(|error| format!("Synthetic window cleanup: {error}"))?
            }
        }

        impl Drop for SyntheticWindow {
            fn drop(&mut self) {
                let _ = self.shutdown();
            }
        }

        fn run_window(
            ready: Sender<Result<isize, String>>,
            stop: Arc<AtomicBool>,
        ) -> Result<(), String> {
            let _dpi = match PhysicalPixels::enter() {
                Ok(context) => context,
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
            };
            unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                if instance.is_null() {
                    let error = win32_error("GetModuleHandleW");
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                let class: Vec<u16> = format!(
                    "SnapshotSyntheticCapture_{}_{}",
                    GetCurrentProcessId(),
                    GetCurrentThreadId()
                )
                .encode_utf16()
                .chain(Some(0))
                .collect();
                let definition = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..Default::default()
                };
                if RegisterClassW(&definition) == 0 {
                    let error = win32_error("RegisterClassW");
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                // Borderless top-level window: client and DWM frame coincide.
                // Showing it makes it an otherwise eligible xcap candidate.
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_POPUP,
                    32,
                    32,
                    64,
                    64,
                    null_mut(),
                    null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    let error = win32_error("CreateWindowExW");
                    UnregisterClassW(class.as_ptr(), instance);
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                UpdateWindow(hwnd);
                let sent = ready.send(Ok(hwnd as isize)).is_ok();
                let deadline = Instant::now() + Duration::from_secs(15);
                while sent
                    && !stop.load(Ordering::Acquire)
                    && Instant::now() < deadline
                    && IsWindow(hwnd) != 0
                {
                    let mut message = MSG::default();
                    // PeekMessage also services PrintWindow's sent messages.
                    for _ in 0..32 {
                        if PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) == 0 {
                            break;
                        }
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                let destroyed = IsWindow(hwnd) == 0 || DestroyWindow(hwnd) != 0;
                let unregistered = UnregisterClassW(class.as_ptr(), instance) != 0;
                if !destroyed || !unregistered {
                    return Err("Could not destroy synthetic window/class".into());
                }
                Ok(())
            }
        }

        #[test]
        #[ignore = "Requires an interactive Windows desktop; captures only its own synthetic window"]
        fn xcap_excludes_self_but_gdi_captures_synthetic_rgba() {
            let _dpi = PhysicalPixels::enter().unwrap();
            let mut window = SyntheticWindow::start().unwrap();
            assert_ne!(unsafe { IsWindowVisible(window.hwnd as HWND) }, 0);
            let mut pid = 0;
            assert_ne!(
                unsafe { GetWindowThreadProcessId(window.hwnd as HWND, &mut pid) },
                0
            );
            assert_eq!(pid, unsafe { GetCurrentProcessId() });
            // Enumeration reads metadata only; no other window is captured.
            for listed in xcap::Window::all().unwrap() {
                assert_ne!(listed.id().unwrap(), window.hwnd as u32);
            }
            let (_, _, width, height) = capture_own_window_bounds(window.hwnd).unwrap();
            let image = capture_own_window(window.hwnd).unwrap();
            assert_eq!(image.dimensions(), (width, height));
            assert!(width >= 4 && height >= 4);
            for (x, y, expected) in [
                (width / 4, height / 4, [255, 0, 0, 255]),
                (3 * width / 4, height / 4, [0, 255, 0, 255]),
                (width / 4, 3 * height / 4, [0, 0, 255, 255]),
                (3 * width / 4, 3 * height / 4, [255, 255, 0, 255]),
            ] {
                assert_eq!(image.get_pixel(x, y).0, expected, "pixel ({x}, {y})");
            }
            window.shutdown().unwrap();
        }
    }
}
