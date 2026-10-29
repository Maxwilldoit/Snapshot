//! 窗口操作：还原最小化的窗口。

use std::{
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Dwm::DwmFlush,
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
