//! 系统剪贴板采样：arboard 读文字或图片；X11 没有全局变更计数，
//! 用内容哈希当 marker。Wayland 会话下 arboard 走 wlr-data-control，
//! 不支持的合成器读不到内容时返回 None，历史只是记不到，不报错。

use crate::clipboard_history::{hash_bytes, Sample};
use arboard::Clipboard;

pub(crate) fn sample() -> Option<Sample> {
    let mut clipboard = Clipboard::new().ok()?;
    if let Ok(text) = clipboard.get_text() {
        let marker = hash_bytes(text.as_bytes());
        return Some(Sample {
            marker,
            concealed: false,
            text: Some(text),
            png: None,
        });
    }
    if let Ok(image) = clipboard.get_image() {
        let marker = hash_bytes(&image.bytes);
        let rgba = image::RgbaImage::from_raw(
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )?;
        let png = crate::capture::encode_png(&rgba).ok()?;
        return Some(Sample {
            marker,
            concealed: false,
            text: None,
            png: Some(png),
        });
    }
    None
}
