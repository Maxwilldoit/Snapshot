//! 关掉 WKWebView 的橡皮筋：macOS 上页面滚动到边缘后继续滚会弹性回弹，
//! 这里把 WebView 内部 NSScrollView 的横竖弹性都设为 None。
//! WebKit 可能重建内部滚动视图，所以窗口创建时设一次、获得焦点时再补一次。

use objc2::ClassType;
use objc2_app_kit::{NSScrollElasticity, NSScrollView, NSView};
use objc2_foundation::NSObjectProtocol;
use tauri::WebviewWindow;

/// 对窗口里已存在的 WKWebView 视图树生效；必须在主线程调用。
pub(crate) fn disable_scroll_bounce(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // SAFETY: with_webview 在主线程回调；inner() 是 Tauri 持有的 WKWebView。
        unsafe {
            let view = &*webview.inner().cast::<NSView>();
            disable_bounce_in(view);
        }
    });
}

/// 深度遍历视图树，把所有 NSScrollView（含 WebKit 内部的）弹性关掉。
///
/// SAFETY: 只能在主线程调用；view 必须是有效的 NSView。
unsafe fn disable_bounce_in(view: &NSView) {
    if view.isKindOfClass(NSScrollView::class()) {
        let scroll: &NSScrollView = &*(view as *const NSView).cast();
        scroll.setVerticalScrollElasticity(NSScrollElasticity::None);
        scroll.setHorizontalScrollElasticity(NSScrollElasticity::None);
    }
    for subview in view.subviews().iter() {
        disable_bounce_in(&subview);
    }
}

/// 窗口获得焦点时补设一次（WebKit 可能重建内部滚动视图）。
/// with_webview 自己会切到主线程；桌宠是透明覆盖层，不参与页面滚动。
pub(crate) fn refresh_scroll_bounce(window: &WebviewWindow) {
    if window.label() != "pet" {
        disable_scroll_bounce(window);
    }
}
