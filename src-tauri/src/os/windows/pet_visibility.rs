//! Windows 全屏应用避让。只管理桌宠，用户主动呼出的快捷菜单仍可使用。

use std::{mem::size_of, thread, time::Duration};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    UI::WindowsAndMessaging::{
        GetClassNameW, GetClientRect, GetDesktopWindow, GetForegroundWindow, GetShellWindow,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    },
};

pub(crate) fn start(app: AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        // 桌宠只接收鼠标交互，输入由独立的快捷菜单窗口处理。
        // Windows 使用 WS_EX_NOACTIVATE，恢复显示、启动台调整置顶时都不抢焦点。
        let _ = pet.set_focusable(false);
    }
    refresh(&app);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        refresh(&app);
    });
}

/// 切换形象和自动检测都经过这里，避免形象更新把全屏时隐藏的桌宠重新弹出来。
/// 检测与显隐在 UI 线程顺序完成，也避免 show/hide 和窗口命令互相覆盖。
pub(crate) fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(pet) = handle.get_webview_window("pet") else {
            return;
        };
        let Some(covered) = fullscreen_covers_pet(&pet) else {
            // 切换焦点时前台句柄可能短暂为空，保留上一次状态，避免闪烁。
            return;
        };
        let Ok(visible) = pet.is_visible() else {
            return;
        };
        if covered && visible {
            let _ = pet.hide();
        } else if !covered && !visible {
            // start() 中设置了 focusable=false，恢复显示不抢前台应用的焦点。
            let _ = pet.show();
        }
    });
}

fn fullscreen_covers_pet(pet: &tauri::WebviewWindow) -> Option<bool> {
    let pet_hwnd = pet.hwnd().ok()?.0;
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return None;
        }
        let mut pid = 0;
        if GetWindowThreadProcessId(foreground, &mut pid) == 0 {
            return None;
        }
        if pid == std::process::id()
            || foreground == GetDesktopWindow()
            || foreground == GetShellWindow()
            || IsWindowVisible(foreground) == 0
            || IsIconic(foreground) != 0
        {
            return Some(false);
        }
        // Explorer 的桌面 WorkerW 也可能占满屏幕，但它不是全屏应用。
        let mut class = [0u16; 256];
        let len = GetClassNameW(foreground, class.as_mut_ptr(), class.len() as i32);
        if len == 0 {
            return None;
        }
        if matches!(
            String::from_utf16_lossy(&class[..len as usize]).as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ) {
            return Some(false);
        }

        let monitor = MonitorFromWindow(pet_hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let mut client = RECT::default();
        if GetClientRect(foreground, &mut client) == 0 {
            return None;
        }
        let mut origin = POINT {
            x: client.left,
            y: client.top,
        };
        let mut end = POINT {
            x: client.right,
            y: client.bottom,
        };
        if ClientToScreen(foreground, &mut origin) == 0 || ClientToScreen(foreground, &mut end) == 0
        {
            return None;
        }
        let client = RECT {
            left: origin.x,
            top: origin.y,
            right: end.x,
            bottom: end.y,
        };
        // 比较客户区与完整屏幕（不是扣掉任务栏的工作区），普通最大化不会命中。
        // 两者都是物理坐标，兼容负坐标副屏、不同 DPI 和跨屏无边框窗口。
        Some(covers_monitor(&client, &info.rcMonitor))
    }
}

fn covers_monitor(client: &RECT, monitor: &RECT) -> bool {
    monitor.right > monitor.left
        && monitor.bottom > monitor.top
        && client.left <= monitor.left
        && client.top <= monitor.top
        && client.right >= monitor.right
        && client.bottom >= monitor.bottom
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
    fn fullscreen_and_borderless_cover_the_whole_monitor() {
        let monitor = rect(0, 0, 2560, 1440);
        assert!(covers_monitor(&monitor, &monitor));
        assert!(covers_monitor(&rect(-8, -8, 2568, 1448), &monitor));
    }

    #[test]
    fn maximized_and_windowed_apps_leave_the_pet_visible() {
        let monitor = rect(0, 0, 1920, 1080);
        assert!(!covers_monitor(&rect(0, 0, 1920, 1040), &monitor));
        assert!(!covers_monitor(&rect(0, 31, 1920, 1080), &monitor));
        assert!(!covers_monitor(&rect(200, 100, 1480, 820), &monitor));
    }

    #[test]
    fn fullscreen_only_suppresses_pets_on_covered_monitors() {
        let left = rect(-2560, -360, 0, 1080);
        let right = rect(0, 0, 1920, 1080);
        assert!(covers_monitor(&left, &left));
        assert!(!covers_monitor(&left, &right));
        assert!(!covers_monitor(&right, &left));
        let spanning = rect(-2560, -360, 1920, 1080);
        assert!(covers_monitor(&spanning, &left));
        assert!(covers_monitor(&spanning, &right));
    }

    #[test]
    fn invalid_or_partial_bounds_are_not_fullscreen() {
        let monitor = rect(0, 0, 1920, 1080);
        assert!(!covers_monitor(&rect(0, 0, 0, 0), &monitor));
        assert!(!covers_monitor(&rect(1, 0, 1921, 1080), &monitor));
        assert!(!covers_monitor(&monitor, &rect(0, 0, 0, 1080)));
    }
}
