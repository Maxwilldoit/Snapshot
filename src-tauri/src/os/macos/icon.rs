//! macOS：NSRunningApplication.icon → 指定边长的 PNG。
//! 拿到的直接就是 PNG 字节，不必像 Windows 那样走 RgbaImage。

use objc2::AnyThread;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSRunningApplication, NSWorkspace,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

pub fn png_for_pid(pid: u32, size: u32) -> Option<Vec<u8>> {
    unsafe {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
        let icon = app.icon()?;
        downscale_to_png(&icon, size)
    }
}

/// 进程的稳定应用标识：优先 bundle id，没有就退回 .app 路径。
/// 应用退出后仍可据此取图标，不像 pid 那样进程一结束就失效。取不到返回 None，历史不显示角标。
pub fn stable_id_for_pid(pid: u32) -> Option<String> {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
    if let Some(bundle_id) = app.bundleIdentifier() {
        return Some(bundle_id.to_string());
    }
    let url = app.bundleURL()?;
    Some(url.path()?.to_string())
}

/// 按稳定标识（bundle id 或 .app 路径）取图标 PNG。历史角标用，应用退出后仍有效。
/// bundle id 经 NSWorkspace 解析到 .app 路径再取图标；应用已卸载时返回 None，历史不显示角标。
pub fn png_for_app_id(id: &str, size: u32) -> Option<Vec<u8>> {
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_id = NSString::from_str(id);
        // 以 / 开头的是 .app 路径，直接取；否则当 bundle id 解析到安装路径
        let path = if id.starts_with('/') {
            ns_id
        } else {
            workspace
                .URLForApplicationWithBundleIdentifier(&ns_id)?
                .path()?
        };
        let icon = workspace.iconForFile(&path);
        downscale_to_png(&icon, size)
    }
}

/// 兼容只有应用名的旧历史：优先匹配真实运行应用，再交给 LaunchServices 按名称解析。
/// 不拼接或猜测 bundle id；名称无法解析时不返回替代图标。
pub fn png_for_app_name(name: &str, size: u32) -> Option<Vec<u8>> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return None;
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let paths: std::collections::HashSet<_> = workspace
        .runningApplications()
        .iter()
        .filter(|app| {
            app.localizedName()
                .is_some_and(|label| label.to_string().eq_ignore_ascii_case(name))
        })
        .filter_map(|app| app.bundleURL()?.path().map(|path| path.to_string()))
        .collect();
    if paths.len() > 1 {
        return None;
    }
    if let Some(path) = paths.into_iter().next() {
        return png_for_app_id(&path, size);
    }
    // 旧记录没有 bundle id，仍需系统提供的名称解析兼容接口。
    #[allow(deprecated)]
    let path = workspace.fullPathForApplication(&NSString::from_str(name))?;
    png_for_app_id(&path.to_string(), size)
}

/// 图标的 TIFF 里带全套尺寸（最大 1024×1024）；setSize 只改逻辑尺寸、
/// 动不了 TIFFRepresentation 里的像素。要真压到目标边长，得把它画进
/// 一个新的同尺寸 bitmap rep 再导出。
unsafe fn downscale_to_png(icon: &NSImage, size: u32) -> Option<Vec<u8>> {
    let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
        NSBitmapImageRep::alloc(),
        std::ptr::null_mut(),
        size as isize,
        size as isize,
        8,
        4,
        true,
        false,
        NSDeviceRGBColorSpace,
        0,
        0,
    )?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    let edge = f64::from(size);
    icon.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(edge, edge)));
    NSGraphicsContext::restoreGraphicsState_class();
    let png =
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
    Some(png.to_vec())
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_app_names_resolve_real_icons_without_guessing_missing_apps() {
        let png = super::png_for_app_name("Finder", 32).expect("Finder 名称应可解析");
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 32));
        assert!(super::png_for_app_name("Snapshot Missing App 8d8ddc5e", 32).is_none());
        assert!(super::png_for_app_name("", 32).is_none());
        assert!(super::png_for_app_name("/tmp/not-an-application", 32).is_none());
    }

    #[test]
    fn finder_icon_encodes_as_64px_png() {
        let Ok(output) = std::process::Command::new("pgrep")
            .args(["-x", "Finder"])
            .output()
        else {
            return;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(pid) = text
            .lines()
            .next()
            .and_then(|line| line.trim().parse::<u32>().ok())
        else {
            return;
        };
        let png = super::png_for_pid(pid, 64).expect("Finder 应当能取到图标");
        // 图标 TIFF 里有 1024×1024 原图；不真压尺寸的话这里会得到六百 KB 的大图
        let decoded = image::load_from_memory(&png).expect("导出的应为合法 PNG");
        assert_eq!(
            (decoded.width(), decoded.height()),
            (64, 64),
            "图标应压到 64×64"
        );
        assert!(
            png.len() < 20 * 1024,
            "64×64 图标 PNG 应远小于 20KB，实际 {} 字节",
            png.len()
        );
        // drawInRect 必须真的把图标画进去，而不是导出一张空白图
        let opaque = decoded
            .to_rgba8()
            .pixels()
            .filter(|pixel| pixel[3] > 0)
            .count();
        assert!(
            opaque > 64,
            "64×64 图标应有可见内容，实际只有 {opaque} 个非透明像素"
        );
    }
}
