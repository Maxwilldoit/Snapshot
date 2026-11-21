//! 系统剪贴板采样：NSPasteboard.changeCount 判断有没有新复制；
//! 未变化时立即返回 None（零解码、零分配），并包裹在 autoreleasepool 中防止后台线程泄漏临时对象。
//! 密码管理器写入的 Concealed / Transient 类型标记为敏感，跳过不读。

use crate::clipboard_history::{RawClipboardImage, Sample};
use objc2::rc::autoreleasepool;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
};
use objc2_foundation::NSString;

/// 原始图像字节保护上限（256 MB），防止异常超大剪贴板对象一次性拷入堆内存。
const MAX_RAW_IMAGE_BYTES: usize = 256 * 1024 * 1024;

pub(crate) fn supported() -> bool {
    true
}

pub(crate) fn current_marker() -> Option<String> {
    autoreleasepool(|_| Some(NSPasteboard::generalPasteboard().changeCount().to_string()))
}

pub(crate) fn sample(last_marker: &str) -> Option<Sample> {
    // 裸线程没有 CFRunLoop 自动清理池，每轮采样显式包裹 autoreleasepool 释放 AppKit 临时对象。
    autoreleasepool(|_| unsafe { read_sample(last_marker) })
}

unsafe fn read_sample(last_marker: &str) -> Option<Sample> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let marker = pasteboard.changeCount().to_string();
    if marker == last_marker {
        return None;
    }
    let types = pasteboard.types()?;
    let concealed = types.containsObject(&NSString::from_str("org.nspasteboard.ConcealedType"))
        || types.containsObject(&NSString::from_str("org.nspasteboard.TransientType"));
    if concealed {
        return Some(Sample {
            marker,
            concealed: true,
            text: None,
            image: None,
        });
    }
    if types.containsObject(NSPasteboardTypeString) {
        if let Some(raw) = pasteboard.stringForType(NSPasteboardTypeString) {
            let text = raw.to_string();
            if !text.trim().is_empty() {
                return Some(Sample {
                    marker,
                    concealed: false,
                    text: Some(text),
                    image: None,
                });
            }
        }
    }
    let encoded = if types.containsObject(NSPasteboardTypePNG) {
        let data = pasteboard.dataForType(NSPasteboardTypePNG)?;
        if data.len() > MAX_RAW_IMAGE_BYTES {
            return Some(Sample {
                marker,
                concealed: false,
                text: None,
                image: None,
            });
        }
        data.to_vec()
    } else if types.containsObject(NSPasteboardTypeTIFF) {
        let data = pasteboard.dataForType(NSPasteboardTypeTIFF)?;
        if data.len() > MAX_RAW_IMAGE_BYTES {
            return Some(Sample {
                marker,
                concealed: false,
                text: None,
                image: None,
            });
        }
        data.to_vec()
    } else {
        return Some(Sample {
            marker,
            concealed: false,
            text: None,
            image: None,
        });
    };
    Some(Sample {
        marker,
        concealed: false,
        text: None,
        image: Some(RawClipboardImage::Encoded(encoded)),
    })
}
