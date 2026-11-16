//! 系统剪贴板采样：NSPasteboard.changeCount 判断有没有新复制；
//! 密码管理器写入的 Concealed / Transient 类型标记为敏感，跳过不读。

use crate::clipboard_history::Sample;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
};
use objc2_foundation::NSString;

pub(crate) fn sample() -> Option<Sample> {
    // NSPasteboard 的读取线程安全（AppKit 文档明确允许后台读）；
    // 类型常量是 extern static，Rust 侧按约定用 unsafe 取用。
    unsafe { read_sample() }
}

unsafe fn read_sample() -> Option<Sample> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let marker = pasteboard.changeCount().to_string();
    let types = pasteboard.types()?;
    let concealed = types.containsObject(&NSString::from_str("org.nspasteboard.ConcealedType"))
        || types.containsObject(&NSString::from_str("org.nspasteboard.TransientType"));
    if concealed {
        return Some(Sample {
            marker,
            concealed: true,
            text: None,
            png: None,
        });
    }
    if types.containsObject(NSPasteboardTypeString) {
        let text = pasteboard
            .stringForType(NSPasteboardTypeString)?
            .to_string();
        return Some(Sample {
            marker,
            concealed: false,
            text: Some(text),
            png: None,
        });
    }
    let png = if types.containsObject(NSPasteboardTypePNG) {
        pasteboard.dataForType(NSPasteboardTypePNG)?.to_vec()
    } else if types.containsObject(NSPasteboardTypeTIFF) {
        let tiff = pasteboard.dataForType(NSPasteboardTypeTIFF)?.to_vec();
        let image = image::load_from_memory(&tiff).ok()?.to_rgba8();
        crate::capture::encode_png(&image).ok()?
    } else {
        return Some(Sample {
            marker,
            concealed: false,
            text: None,
            png: None,
        });
    };
    Some(Sample {
        marker,
        concealed: false,
        text: None,
        png: Some(png),
    })
}
