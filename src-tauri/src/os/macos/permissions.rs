//! 未授权时 CoreGraphics 会隐藏其它应用的窗口标题，xcap 因而返回空列表。
//! 枚举只检查权限；只有用户按授权按钮时才请求权限、打开系统设置。

use std::process::Command;

const PERMISSION_REQUIRED: &str = "需要「屏幕录制」权限才能读取和截取窗口";

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn check_access(granted: bool) -> Result<(), String> {
    if granted {
        Ok(())
    } else {
        Err(PERMISSION_REQUIRED.into())
    }
}

pub(crate) fn require_screen_capture_access() -> Result<(), String> {
    // SAFETY: CoreGraphics permission probes take no pointers or owned resources.
    check_access(unsafe { CGPreflightScreenCaptureAccess() })
}

#[tauri::command]
pub(crate) fn authorize_screen_capture() -> Result<bool, String> {
    // 不在启动或后台追踪时弹权限请求；这条命令只由用户的授权按钮调用。
    if require_screen_capture_access().is_ok() || unsafe { CGRequestScreenCaptureAccess() } {
        return Ok(true);
    }
    let status = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status()
        .map_err(|error| format!("无法打开系统设置：{error}"))?;
    if !status.success() {
        return Err("无法打开系统设置，请手动打开「屏幕录制」设置".into());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_permission_is_an_error_not_an_empty_window_list() {
        assert_eq!(check_access(false), Err(PERMISSION_REQUIRED.into()));
    }

    #[test]
    fn granted_permission_can_be_rechecked_without_cached_denial() {
        assert!(check_access(false).is_err());
        assert!(check_access(true).is_ok());
    }
}
