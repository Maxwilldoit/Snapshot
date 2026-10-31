//! 窗口操作：还原最小化的窗口。

use std::{
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Dwm::DwmFlush,
    Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn},
    UI::WindowsAndMessaging::{IsIconic, IsWindowVisible, ShowWindow, SW_RESTORE},
};

/// xcap 在 Windows 上的窗口 id 就是 HWND。
pub(crate) fn restore_minimized(id: u32) -> Result<(), String> {
    let handle: HWND = id as usize as *mut _;
    unsafe {
        // ShowWindow 的返回值是「调用前窗口是否可见」，不是成败，据此判断会误报成功。
        let _ = ShowWindow(handle, SW_RESTORE);
    }
    thread::sleep(Duration::from_millis(220));
    // 真正的成败只能事后问：仍是最小化就说明系统或目标应用没有接受这次还原。
    if unsafe { IsIconic(handle) } != 0 {
        return Err("目标窗口仍处于最小化，未能还原".into());
    }
    Ok(())
}

/// 快捷菜单隐藏后等到 DWM 完成一次合成。`ShowWindow(SW_HIDE)` 返回时窗口的
/// 可见位已经清掉，但桌面/屏幕抓取仍可能拿到上一帧，因此再用 DwmFlush 作为
/// 有明确系统同步点的栅栏。调用方在失败时保留短时安全回退。
pub(crate) fn wait_until_hidden(window: &tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?.0;

    // hide() 通常会同步清除 WS_VISIBLE。这里只做两次极短的有界确认，不轮询。
    for _ in 0..2 {
        if unsafe { IsWindowVisible(handle) } == 0 {
            // DwmFlush 没有超时参数。放到独立线程里等最多 64ms，避免显卡/DWM
            // 异常时截图命令无限期挂住；正常一次合成通常只需要一个刷新周期。
            let (sender, receiver) = mpsc::channel();
            thread::spawn(move || {
                let result = unsafe { DwmFlush() };
                let _ = sender.send(result);
            });
            return match receiver.recv_timeout(Duration::from_millis(64)) {
                Ok(result) if result >= 0 => Ok(()),
                Ok(result) => Err(format!("DwmFlush 失败：0x{result:08X}")),
                Err(RecvTimeoutError::Timeout) => Err("DwmFlush 超时".into()),
                Err(RecvTimeoutError::Disconnected) => Err("DwmFlush 线程退出".into()),
            };
        }
        thread::sleep(Duration::from_millis(8));
    }

    Err("快捷菜单仍被 Windows 标记为可见".into())
}

/// 原生矩形窗口仍可透明；把窗口区域收成桌宠画面实际占用的一块，
/// 区域外的点击会直接落到下面的应用。全零表示恢复完整窗口。
pub(crate) fn set_window_region(
    hwnd: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let handle: HWND = hwnd as usize as *mut _;
    if width <= 0 || height <= 0 {
        let ok = unsafe { SetWindowRgn(handle, std::ptr::null_mut(), 1) };
        return if ok != 0 {
            Ok(())
        } else {
            Err("恢复桌宠窗口区域失败".into())
        };
    }

    let region = unsafe { CreateRectRgn(x, y, x.saturating_add(width), y.saturating_add(height)) };
    if region.is_null() {
        return Err("创建桌宠点击区域失败".into());
    }
    let ok = unsafe { SetWindowRgn(handle, region, 1) };
    if ok == 0 {
        // SetWindowRgn 成功时由系统接管区域；失败时仍由调用方释放。
        unsafe { DeleteObject(region) };
        return Err("设置桌宠点击区域失败".into());
    }
    Ok(())
}
