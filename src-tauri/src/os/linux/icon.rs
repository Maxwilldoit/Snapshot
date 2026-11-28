//! 从进程可执行文件路径猜测桌面图标（best-effort）。

use image::{Rgba, RgbaImage};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

static DESKTOP_ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

/// 尝试为 pid 找一张不超过 `size` 像素边长的图标。失败返回 None，调用方显示占位即可。
pub fn icon_for_process(pid: u32, size: u32) -> Option<RgbaImage> {
    let exe = fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    icon_for_exe(&exe, size)
}

/// 按可执行文件路径找图标。pid 实时取图标与历史稳定标识取图标共用这一步：
///  exe 文件名 → 模糊匹配 .desktop → Icon= → 主题文件。应用退出后路径仍在，图标就还能取到。
pub fn icon_for_exe(exe: &Path, size: u32) -> Option<RgbaImage> {
    let name = exe.file_name()?.to_string_lossy().to_string();
    // 去掉常见后缀
    let stem = name
        .trim_end_matches("-bin")
        .trim_end_matches(".bin")
        .to_string();

    let icon_name = find_desktop_icon(&stem).unwrap_or(stem);
    resolve_icon_rgba(&icon_name, size)
}

/// 按 `.desktop` 里的 `Icon=` 值（绝对路径或主题图标名）解析并缩放到不超过 `size` 的 RGBA 图像。
/// 历史来源角标、进程图标与启动台共用这一份查找逻辑（含桌面主题与 `scalable/apps/*.svg`）。
pub(super) fn resolve_icon_rgba(icon: &str, size: u32) -> Option<RgbaImage> {
    let icon = icon.trim();
    if icon.is_empty() {
        return None;
    }
    let edge = size.max(16);
    if let Some(image) = load_icon_file(icon, edge) {
        return Some(fit(image, edge));
    }
    let stem = icon
        .trim_end_matches(".png")
        .trim_end_matches(".svg")
        .trim_end_matches(".xpm");
    load_named_icon(stem, edge).map(|image| fit(image, edge))
}

/// 比要的大就等比缩下来：窗口列表只显示 24px，没必要把 256px 的原图传给页面。
fn fit(image: RgbaImage, size: u32) -> RgbaImage {
    if image.width() <= size && image.height() <= size {
        return image;
    }
    image::DynamicImage::ImageRgba8(image)
        .resize(size, size, image::imageops::FilterType::Triangle)
        .into_rgba8()
}

/// 图标主题的位图尺寸目录，按「刚好够用」排序：先由小到大取不小于 `size` 的，
/// 都没有再由大到小取更小的。这样既不糊，也不白白读一张大图再缩。
fn size_dirs_for(size: u32) -> Vec<&'static str> {
    const AVAILABLE: [(u32, &str); 5] = [
        (32, "32x32"),
        (48, "48x48"),
        (64, "64x64"),
        (128, "128x128"),
        (256, "256x256"),
    ];
    let mut dirs: Vec<&str> = AVAILABLE
        .iter()
        .filter(|(edge, _)| *edge >= size)
        .map(|(_, dir)| *dir)
        .collect();
    dirs.extend(
        AVAILABLE
            .iter()
            .rev()
            .filter(|(edge, _)| *edge < size)
            .map(|(_, dir)| *dir),
    );
    dirs
}

fn xdg_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = std::env::var("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(home));
    } else if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share"));
    }
    if let Ok(data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for part in data_dirs.split(':').filter(|s| !s.is_empty()) {
            dirs.push(PathBuf::from(part));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/share"));
        dirs.push(PathBuf::from("/usr/share"));
    }
    dirs
}

fn icon_theme_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for data in xdg_data_dirs() {
        roots.push(data.join("icons"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".icons"));
    }
    let sys_icons = PathBuf::from("/usr/share/icons");
    if !roots.contains(&sys_icons) {
        roots.push(sys_icons);
    }
    roots
}

fn pixmap_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for data in xdg_data_dirs() {
        roots.push(data.join("pixmaps"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".icons"));
    }
    let sys_pixmaps = PathBuf::from("/usr/share/pixmaps");
    if !roots.contains(&sys_pixmaps) {
        roots.push(sys_pixmaps);
    }
    roots
}

fn find_desktop_icon(app: &str) -> Option<String> {
    let lower = app.to_ascii_lowercase();
    let cache = DESKTOP_ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().get(&lower).cloned() {
        return cached;
    }
    let store_cache = |key: String, value: Option<String>| -> Option<String> {
        let mut guard = cache.lock();
        if guard.len() >= 256 {
            guard.clear();
        }
        guard.insert(key, value.clone());
        value
    };
    for root in xdg_data_dirs() {
        let apps = root.join("applications");
        let Ok(entries) = fs::read_dir(&apps) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let matches_name = file_stem.eq_ignore_ascii_case(app)
                || file_stem.to_ascii_lowercase().contains(&lower);
            let matches_exec = text.lines().any(|line| {
                let line = line.trim();
                line.starts_with("Exec=") && line.to_ascii_lowercase().contains(&lower)
            });
            if !(matches_name || matches_exec) {
                continue;
            }
            for line in text.lines() {
                let line = line.trim();
                if let Some(icon) = line.strip_prefix("Icon=") {
                    let icon = icon.trim();
                    if !icon.is_empty() {
                        return store_cache(lower, Some(icon.to_string()));
                    }
                }
            }
        }
    }
    store_cache(lower, None)
}

fn load_candidate_path(path: &Path, edge: u32) -> Option<RgbaImage> {
    if !path.is_file() {
        return None;
    }
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return rasterize_svg(path, edge);
    }
    image::open(path).ok().map(|img| img.into_rgba8())
}

fn load_icon_file(icon: &str, edge: u32) -> Option<RgbaImage> {
    let path = Path::new(icon);
    if path.is_absolute() {
        return load_candidate_path(path, edge);
    }
    None
}

fn load_named_icon(name: &str, edge: u32) -> Option<RgbaImage> {
    load_named_icon_in_roots(name, edge, &icon_theme_roots(), &pixmap_roots())
}

fn load_named_icon_in_roots(
    name: &str,
    edge: u32,
    theme_roots: &[PathBuf],
    pixmaps: &[PathBuf],
) -> Option<RgbaImage> {
    // 覆盖常见桌面图标主题与 scalable 矢量目录，避免链 GTK 图标缓存。
    const THEMES: [&str; 5] = ["hicolor", "Yaru", "Adwaita", "Papirus", "breeze"];
    const EXTS: [&str; 2] = ["png", "svg"];

    let mut dirs = size_dirs_for(edge);
    dirs.push("96x96");
    dirs.push("scalable");

    for root in theme_roots {
        for theme in THEMES {
            let theme_dir = root.join(theme);
            if !theme_dir.is_dir() {
                continue;
            }
            for size_dir in &dirs {
                for ext in EXTS {
                    let candidate = theme_dir
                        .join(size_dir)
                        .join("apps")
                        .join(format!("{name}.{ext}"));
                    if let Some(img) = load_candidate_path(&candidate, edge) {
                        return Some(img);
                    }
                }
            }
        }
    }
    for root in pixmaps {
        for ext in EXTS {
            let candidate = root.join(format!("{name}.{ext}"));
            if let Some(img) = load_candidate_path(&candidate, edge) {
                return Some(img);
            }
        }
    }
    None
}

fn rasterize_svg(path: &Path, edge: u32) -> Option<RgbaImage> {
    // 可选：rsvg-convert；没有就跳过 SVG
    let edge = edge.to_string();
    let output = Command::new("rsvg-convert")
        .args(["-w", &edge, "-h", &edge])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    image::load_from_memory(&output.stdout)
        .ok()
        .map(|img| img.into_rgba8())
        .or_else(|| {
            // 有些环境输出到文件更稳，这里内存失败就放弃
            let _ = Rgba([0, 0, 0, 0]);
            None
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_smallest_size_that_is_big_enough_first() {
        assert_eq!(size_dirs_for(48)[0], "48x48");
        assert_eq!(size_dirs_for(50)[0], "64x64");
        assert_eq!(
            size_dirs_for(300),
            vec!["256x256", "128x128", "64x64", "48x48", "32x32"]
        );
        assert_eq!(
            size_dirs_for(20),
            vec!["32x32", "48x48", "64x64", "128x128", "256x256"]
        );
    }

    #[test]
    fn fit_shrinks_but_never_enlarges() {
        assert_eq!(fit(RgbaImage::new(256, 256), 64).dimensions(), (64, 64));
        assert_eq!(fit(RgbaImage::new(32, 32), 64).dimensions(), (32, 32));
    }

    #[test]
    fn resolves_desktop_theme_png_and_scalable_svg_icons() {
        let dir = std::env::temp_dir().join(format!("snapshot-icon-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let papirus_apps = dir.join("icons/Papirus/256x256/apps");
        let scalable_apps = dir.join("icons/hicolor/scalable/apps");
        fs::create_dir_all(&papirus_apps).unwrap();
        fs::create_dir_all(&scalable_apps).unwrap();

        let big = RgbaImage::from_pixel(256, 256, Rgba([20, 120, 220, 255]));
        big.save(papirus_apps.join("theme-only.png")).unwrap();
        let loaded = load_named_icon_in_roots("theme-only", 48, &[dir.join("icons")], &[])
            .map(|img| fit(img, 48))
            .expect("Papirus icon");
        assert_eq!(loaded.dimensions(), (48, 48));

        fs::write(
            scalable_apps.join("vector-only.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ff6600"/></svg>"##,
        )
        .unwrap();
        if Command::new("rsvg-convert")
            .arg("--version")
            .output()
            .is_ok()
        {
            let svg = load_named_icon_in_roots("vector-only", 64, &[dir.join("icons")], &[])
                .expect("scalable svg icon");
            assert_eq!(svg.dimensions(), (64, 64));
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
