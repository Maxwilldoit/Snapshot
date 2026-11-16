//! 把截图写进系统剪贴板，以及 Prompt 相关的文字读写。复制的内容一直保留，
//! 由用户自己决定何时覆盖；应用不做任何自动清空。

use super::*;

/// Linux（X11/XWayland）上剪贴板内容由写入它的进程自己提供：arboard 在最后一个
/// `Clipboard` 释放时只给剪贴板管理器 100ms 接手，没装管理器、或整张截图来不及交出去时，
/// 刚复制的图（标注图、截图、润色文字）一粘贴就是空的。启动时常驻一个实例，应用活着内容就在。
#[cfg(target_os = "linux")]
pub(crate) fn keep_alive() {
    static KEPT: AtomicBool = AtomicBool::new(false);
    if KEPT.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(clipboard) = Clipboard::new() {
        // 故意不释放：它在，arboard 的剪贴板服务线程就一直在
        std::mem::forget(clipboard);
        KEPT.store(true, Ordering::SeqCst);
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn keep_alive() {}

/// 把图放进剪贴板。内容一直保留到用户复制别的东西。
pub(crate) fn copy_image(image: RgbaImage) -> Result<(), String> {
    keep_alive(); // 启动时没连上显示服务的话，这里再补一次
    let width = image.width() as usize;
    let height = image.height() as usize;
    let bytes = image.into_raw();
    // arboard 自身会短暂重试打开剪贴板；Windows 剪贴板历史或其它应用可能在
    // 一次完整的 16MB 图片写入后仍占着它。再给一次短退避，避免连续截图偶发失败。
    fn set_image(width: usize, height: usize, bytes: &[u8]) -> Result<(), arboard::Error> {
        Clipboard::new().and_then(|mut clipboard| {
            clipboard.set_image(ImageData {
                width,
                height,
                bytes: Cow::Borrowed(bytes),
            })
        })
    }
    match set_image(width, height, &bytes) {
        Ok(()) => {}
        Err(arboard::Error::ClipboardOccupied) => {
            thread::sleep(Duration::from_millis(40));
            set_image(width, height, &bytes).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

/// 输入框「复制并关闭」：润色结果写进剪贴板。
#[tauri::command]
pub(crate) fn copy_text(text: String) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| format!("写入剪贴板失败：{error}"))
}

/// 输入框「润色剪贴板里的文字」：先把文字读出来放进润色视图，用户看过结果再决定要不要复制
#[tauri::command]
pub(crate) fn read_clipboard_text() -> Result<String, String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|_| "剪贴板里没有文字".to_string())
}
