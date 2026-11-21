//! 系统剪贴板采样：复用线程局部 arboard 实例读取文字或图片；X11 没有全局变更计数，
//! 先用轻量内容哈希对比 last_marker，仅在剪贴板确实变化后才检测敏感标记并返回负载。

use crate::clipboard_history::{hash_bytes, RawClipboardImage, Sample};
use arboard::Clipboard;
use std::{cell::RefCell, process::Command};

thread_local! {
    static THREAD_CLIPBOARD: RefCell<Option<Clipboard>> = const { RefCell::new(None) };
}

/// 当前构建未启用 wayland-data-control，仅在存在 X11 / XWayland DISPLAY 时可用。
pub(crate) fn supported() -> bool {
    super::session::x11_display().is_some()
}

/// Linux X11 无全局变更计数；写回剪贴板后依赖表头哈希跳过重复采集，无需额外读取剪贴板。
pub(crate) fn current_marker() -> Option<String> {
    None
}

fn contains_secret_mime(list: &str) -> bool {
    list.lines().any(|line| {
        let mime = line.trim();
        mime.eq_ignore_ascii_case("x-kde-passwordManagerHint")
            || mime.eq_ignore_ascii_case("application/x-kde-passwordManagerHint")
            || mime.eq_ignore_ascii_case("org.nspasteboard.ConcealedType")
            || mime.eq_ignore_ascii_case("x-gnome-privacy")
    })
}

/// 仅在检测到新复制内容（marker 变化）时执行一次：查询剪贴板 TARGETS / MIME 列表，
/// 识别 1Password / KeePassXC / Bitwarden 等密码管理器写入的敏感标记。
fn is_selection_concealed() -> bool {
    if super::session::is_wayland_session() {
        if let Ok(output) = Command::new("wl-paste").arg("--list-types").output() {
            if output.status.success()
                && contains_secret_mime(&String::from_utf8_lossy(&output.stdout))
            {
                return true;
            }
        }
    }
    if let Ok(output) = Command::new("xclip")
        .args(["-selection", "clipboard", "-t", "TARGETS", "-o"])
        .output()
    {
        if output.status.success() && contains_secret_mime(&String::from_utf8_lossy(&output.stdout))
        {
            return true;
        }
    }
    false
}

pub(crate) fn sample(last_marker: &str) -> Option<Sample> {
    if !supported() {
        return None;
    }
    THREAD_CLIPBOARD.with(|slot| {
        let mut borrow = slot.borrow_mut();
        if borrow.is_none() {
            *borrow = Clipboard::new().ok();
        }
        let clipboard = borrow.as_mut()?;

        if let Ok(text) = clipboard.get_text() {
            if !text.trim().is_empty() {
                let marker = format!("t:{}", hash_bytes(text.as_bytes()));
                if marker == last_marker {
                    return None;
                }
                if is_selection_concealed() {
                    return Some(Sample {
                        marker,
                        concealed: true,
                        text: None,
                        image: None,
                    });
                }
                return Some(Sample {
                    marker,
                    concealed: false,
                    text: Some(text),
                    image: None,
                });
            }
        }

        if let Ok(image) = clipboard.get_image() {
            let width = u32::try_from(image.width).ok()?;
            let height = u32::try_from(image.height).ok()?;
            let marker = format!("i:{}", hash_bytes(&image.bytes));
            if marker == last_marker {
                return None;
            }
            if is_selection_concealed() {
                return Some(Sample {
                    marker,
                    concealed: true,
                    text: None,
                    image: None,
                });
            }
            return Some(Sample {
                marker,
                concealed: false,
                text: None,
                image: Some(RawClipboardImage::Rgba {
                    width,
                    height,
                    bytes: image.bytes.into_owned(),
                }),
            });
        }

        None
    })
}
