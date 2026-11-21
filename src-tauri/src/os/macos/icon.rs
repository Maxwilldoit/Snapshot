//! macOS：NSRunningApplication.icon → 指定边长的 PNG。
//! 拿到的直接就是 PNG 字节，不必像 Windows 那样走 RgbaImage。

use objc2::{rc::autoreleasepool, AnyThread};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSRunningApplication, NSWorkspace,
};
use objc2_foundation::{NSBundle, NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::OnceLock,
};

type ReconcileCache = HashMap<(String, String), Option<String>>;

const MAX_BUNDLE_CACHE_ENTRIES: usize = 256;

static ICON_DRAW_LOCK: Mutex<()> = Mutex::new(());
static APP_NAME_BUNDLE_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static RECONCILE_APP_ID_CACHE: OnceLock<Mutex<ReconcileCache>> = OnceLock::new();

pub fn frontmost_pid() -> Option<u32> {
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        let pid = app.processIdentifier();
        (pid > 0).then_some(pid as u32)
    })
}

pub fn png_for_pid(pid: u32, size: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| unsafe {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
        let icon = app.icon()?;
        downscale_to_png(&icon, size)
    })
}

/// 进程的稳定应用标识：优先 bundle id，没有就退回 .app 路径。
/// 应用退出后仍可据此取图标，不像 pid 那样进程一结束就失效。取不到返回 None，历史不显示角标。
pub fn stable_id_for_pid(pid: u32) -> Option<String> {
    autoreleasepool(|_| {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
        if let Some(bundle_id) = app.bundleIdentifier() {
            return Some(bundle_id.to_string());
        }
        let url = app.bundleURL()?;
        Some(url.path()?.to_string())
    })
}

/// 按稳定标识（bundle id 或 .app 路径）取图标 PNG。历史角标用，应用退出后仍有效。
/// bundle id 经 NSWorkspace 解析到 .app 路径再取图标；应用已卸载时返回 None，历史不显示角标。
pub fn png_for_app_id(id: &str, size: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| unsafe {
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
    })
}

fn strip_annotation_suffix(raw: &str) -> &str {
    let mut current = raw.trim();
    loop {
        if let Some(stripped) = current
            .strip_suffix(" · 标注")
            .or_else(|| current.strip_suffix(" · Markup"))
        {
            current = stripped.trim();
        } else {
            return current;
        }
    }
}

fn push_candidate(candidates: &mut HashSet<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    candidates.insert(trimmed.to_lowercase());
    if let Some(stem) = trimmed
        .strip_suffix(".app")
        .or_else(|| trimmed.strip_suffix(".APP"))
    {
        let stem = stem.trim();
        if !stem.is_empty() {
            candidates.insert(stem.to_lowercase());
        }
    }
}

fn bundle_path_for_id(id: &str) -> Option<String> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    if id.starts_with('/') {
        return Path::new(id).exists().then(|| id.to_string());
    }
    let workspace = NSWorkspace::sharedWorkspace();
    workspace
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(id))?
        .path()
        .map(|path| path.to_string())
}

fn bundle_candidate_names(bundle_path: &str, bundle_id: Option<&str>) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(stem) = Path::new(bundle_path)
        .file_stem()
        .and_then(|value| value.to_str())
    {
        push_candidate(&mut names, stem);
    }

    let ns_path = NSString::from_str(bundle_path);
    let display = NSFileManager::defaultManager().displayNameAtPath(&ns_path);
    push_candidate(&mut names, &display.to_string());

    if let Some(bundle) = NSBundle::bundleWithPath(&ns_path) {
        for key in ["CFBundleDisplayName", "CFBundleName", "CFBundleExecutable"] {
            let ns_key = NSString::from_str(key);
            if let Some(obj) = bundle.objectForInfoDictionaryKey(&ns_key) {
                if let Ok(text) = obj.downcast::<NSString>() {
                    push_candidate(&mut names, &text.to_string());
                }
            }
            if let Some(info) = bundle.infoDictionary() {
                if let Some(obj) = info.objectForKey(&ns_key) {
                    if let Ok(text) = obj.downcast::<NSString>() {
                        push_candidate(&mut names, &text.to_string());
                    }
                }
            }
        }
    }

    let workspace = NSWorkspace::sharedWorkspace();
    for app in workspace.runningApplications().iter() {
        let same_id = bundle_id.is_some_and(|target_id| {
            app.bundleIdentifier()
                .is_some_and(|bid| bid.to_string().eq_ignore_ascii_case(target_id))
        });
        let same_path = app
            .bundleURL()
            .and_then(|url| url.path())
            .is_some_and(|path| path.to_string() == bundle_path);
        if same_id || same_path {
            if let Some(label) = app.localizedName() {
                push_candidate(&mut names, &label.to_string());
            }
        }
    }

    names
}

fn resolve_bundle_path_for_app_name(raw_name: &str) -> Option<String> {
    let name = strip_annotation_suffix(raw_name);
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return None;
    }
    let cache_key = name.to_lowercase();
    let cache = APP_NAME_BUNDLE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().get(&cache_key).cloned() {
        if Path::new(&cached).exists() {
            return Some(cached);
        }
    }
    let record_hit = |key: String, path: String| -> Option<String> {
        let mut guard = cache.lock();
        if guard.len() >= MAX_BUNDLE_CACHE_ENTRIES {
            guard.clear();
        }
        guard.insert(key, path.clone());
        Some(path)
    };
    let workspace = NSWorkspace::sharedWorkspace();
    let running_paths: HashSet<_> = workspace
        .runningApplications()
        .iter()
        .filter(|app| {
            app.localizedName()
                .is_some_and(|label| label.to_string().eq_ignore_ascii_case(name))
        })
        .filter_map(|app| app.bundleURL()?.path().map(|path| path.to_string()))
        .collect();
    if running_paths.len() > 1 {
        return None;
    }
    if let Some(path) = running_paths.into_iter().next() {
        return record_hit(cache_key, path);
    }

    #[allow(deprecated)]
    if let Some(path) = workspace.fullPathForApplication(&NSString::from_str(name)) {
        return record_hit(cache_key, path.to_string());
    }

    // 兼容 CFBundleName 与包目录名不一致的应用（如 Visual Studio Code.app 的 CFBundleName 为 Code）
    let needle = cache_key.clone();
    let mut dirs = vec![
        Path::new("/Applications").to_path_buf(),
        Path::new("/System/Applications").to_path_buf(),
        Path::new("/System/Applications/Utilities").to_path_buf(),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
    }

    let mut matched = HashSet::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let Some(path_str) = path.to_str() else {
                continue;
            };
            if bundle_candidate_names(path_str, None).contains(&needle) {
                matched.insert(path_str.to_string());
            }
        }
    }
    if matched.len() == 1 {
        record_hit(cache_key, matched.into_iter().next().unwrap())
    } else {
        None
    }
}

fn stable_id_for_bundle_path(bundle_path: &str) -> String {
    NSBundle::bundleWithPath(&NSString::from_str(bundle_path))
        .and_then(|bundle| bundle.bundleIdentifier())
        .map(|id| id.to_string())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| bundle_path.to_string())
}

/// 校验并修正历史记录中的 `app_id`：
/// 早期版本在截取非前台窗口时误把「上一个前台应用」（如 Codex、Chrome）的 bundle id 写入了记录；
/// 若当前 `app_id` 指向的已安装应用与 `app_name` 完全不符，则按真实 `app_name` 重新解析稳定标识。
pub fn reconcile_app_id(app_name: &str, app_id: Option<&str>) -> Option<String> {
    autoreleasepool(|_| {
        let base = strip_annotation_suffix(app_name);
        if base.is_empty()
            || matches!(base, "应用" | "App" | "滚动长截图" | "Scrolling Screenshot")
            || base.starts_with("Display #")
            || base.starts_with("显示器")
        {
            return app_id.map(str::to_string);
        }
        let id = app_id.map(str::trim).filter(|value| !value.is_empty())?;
        let cache_key = (base.to_lowercase(), id.to_string());
        let cache = RECONCILE_APP_ID_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some(cached) = cache.lock().get(&cache_key).cloned() {
            return cached;
        }
        let resolved = match bundle_path_for_id(id) {
            None => {
                // 目标应用可能已被卸载，保留原标识（角标加载失败时前端自动收起）
                Some(id.to_string())
            }
            Some(bundle_path) => {
                if bundle_candidate_names(&bundle_path, Some(id)).contains(&cache_key.0) {
                    Some(id.to_string())
                } else {
                    resolve_bundle_path_for_app_name(base)
                        .map(|path| stable_id_for_bundle_path(&path))
                }
            }
        };
        let mut guard = cache.lock();
        if guard.len() >= MAX_BUNDLE_CACHE_ENTRIES {
            guard.clear();
        }
        guard.insert(cache_key, resolved.clone());
        resolved
    })
}

/// 兼容只有应用名的旧历史：优先匹配真实运行应用，再交给 LaunchServices 与已安装应用包解析。
/// 不拼接或猜测 bundle id；名称无法唯一解析时不返回替代图标。
pub fn png_for_app_name(name: &str, size: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| {
        let path = resolve_bundle_path_for_app_name(name)?;
        png_for_app_id(&path, size)
    })
}

/// 图标的 TIFF 里带全套尺寸（最大 1024×1024）；setSize 只改逻辑尺寸、
/// 动不了 TIFFRepresentation 里的像素。要真压到目标边长，得把它画进
/// 一个新的同尺寸 bitmap rep 再导出。
unsafe fn downscale_to_png(icon: &NSImage, size: u32) -> Option<Vec<u8>> {
    let _draw_guard = ICON_DRAW_LOCK.lock();
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
        assert!(super::png_for_app_name("Finder · 标注", 32).is_some());
        assert!(super::png_for_app_name("Snapshot Missing App 8d8ddc5e", 32).is_none());
        assert!(super::png_for_app_name("", 32).is_none());
        assert!(super::png_for_app_name("/tmp/not-an-application", 32).is_none());
    }

    #[test]
    fn mismatched_app_ids_are_reconciled_to_the_captured_app() {
        assert_eq!(
            super::reconcile_app_id("Finder", Some("com.apple.finder")).as_deref(),
            Some("com.apple.finder")
        );
        assert_eq!(
            super::reconcile_app_id("Finder · 标注", Some("com.apple.finder")).as_deref(),
            Some("com.apple.finder")
        );
        // 错标成 TextEdit 的 Finder 窗口截图应修正回 com.apple.finder
        assert_eq!(
            super::reconcile_app_id("Finder", Some("com.apple.TextEdit")).as_deref(),
            Some("com.apple.finder")
        );
        // 无法唯一识别的应用名称宁可清空错标的 bundle id，也不显示错误应用的图标
        assert_eq!(
            super::reconcile_app_id("Snapshot Missing App 8d8ddc5e", Some("com.apple.TextEdit")),
            None
        );
        // 已卸载应用的 bundle id 保持原样
        assert_eq!(
            super::reconcile_app_id("Finder", Some("com.nonexistent.uninstalled.8d8ddc5e"))
                .as_deref(),
            Some("com.nonexistent.uninstalled.8d8ddc5e")
        );
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
