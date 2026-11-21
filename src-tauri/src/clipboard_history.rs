//! 剪贴板历史：macOS / Linux 上始终开启，后台每秒看一眼系统剪贴板，把新复制的文字和图片
//! 存进应用数据目录（索引 clipboard-history.json + 图片 clipboard-history/<id>.png）。
//! 密码管理器标记为敏感的内容（Concealed / transient / x-kde-passwordManagerHint）跳过。
//! 删除单条或清空都立即原子落盘；不支持的平台不启动后台轮询线程。

use super::*;
use image::ImageReader;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{io::Cursor, sync::OnceLock};

/// 最多保留的条数；超出后从最旧的一端连同图片文件一起删。
const MAX_ENTRIES: usize = 500;
/// 单条文字上限（字符数）；再长的复制多半是数据导出，不适合当历史条目。
const MAX_TEXT_CHARS: usize = 100_000;
/// 单张图片像素上限（宽 × 高），约 8K 截图；解码前先按文件头尺寸拦截，避免占满内存。
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// 剪贴板列表缩略图尺寸上限（列表显示 max 200×64 CSS，按 2× Retina 留足清晰度）
const CLIP_THUMB_MAX_WIDTH: u32 = 420;
const CLIP_THUMB_MAX_HEIGHT: u32 = 144;
const CLIP_THUMB_JPEG_QUALITY: u8 = 88;
const POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipboardHistoryEntry {
    pub(crate) id: String,
    pub(crate) created_at: u64,
    /// "text" | "image"
    pub(crate) kind: String,
    /// 文字全文；图片条目为空
    pub(crate) text: String,
    /// 图片原始宽高；文字条目为 0
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// 内容哈希：文字按 UTF-8 字节，图片按标准 RGBA 像素与尺寸计算，跨 PNG/TIFF 编码一致
    pub(crate) hash: String,
}

pub(crate) struct ClipboardHistory {
    path: PathBuf,
    dir: PathBuf,
    entries: Vec<ClipboardHistoryEntry>,
    counter: u64,
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) enum RawClipboardImage {
    /// PNG / TIFF 等编码字节（仅在剪贴板变化后由 macOS 平台层读取）
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Encoded(Vec<u8>),
    /// 已解码的原始 RGBA 像素（Linux X11 arboard 返回值）
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Rgba {
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    },
}

/// 平台采样结果。marker 相同时平台层直接返回 None，不做任何内存拷贝或图像编解码。
pub(crate) struct Sample {
    pub(crate) marker: String,
    /// 密码管理器等标记的敏感内容：跳过，不读也不存
    pub(crate) concealed: bool,
    pub(crate) text: Option<String>,
    pub(crate) image: Option<RawClipboardImage>,
}

impl ClipboardHistory {
    pub(crate) fn load(path: PathBuf, dir: PathBuf) -> Self {
        let entries =
            read_json_with_backup::<Vec<ClipboardHistoryEntry>>(&path).unwrap_or_default();
        Self {
            path,
            dir,
            entries,
            counter: 0,
        }
    }

    fn is_head_hash(&self, hash: &str) -> bool {
        self.entries.first().is_some_and(|head| head.hash == hash)
    }

    fn push(
        &mut self,
        kind: &str,
        text: String,
        width: u32,
        height: u32,
        hash: String,
        image: Option<(&[u8], Option<&[u8]>)>,
    ) -> Result<ClipboardHistoryEntry, String> {
        self.counter += 1;
        let created_at = now_millis();
        let entry = ClipboardHistoryEntry {
            id: format!("clip-{created_at}-{}", self.counter),
            created_at,
            kind: kind.into(),
            text,
            width,
            height,
            hash,
        };
        if let Some((bytes, thumb)) = image {
            fs::create_dir_all(&self.dir).map_err(|error| error.to_string())?;
            fs::write(self.dir.join(format!("{}.png", entry.id)), bytes)
                .map_err(|error| error.to_string())?;
            if let Some(thumb_bytes) = thumb {
                let _ = fs::write(thumb_path(&self.dir, &entry.id), thumb_bytes);
            }
        }

        let mut next = Vec::with_capacity(self.entries.len().min(MAX_ENTRIES) + 1);
        next.push(entry.clone());
        next.extend(self.entries.iter().cloned());
        let evicted: Vec<_> = if next.len() > MAX_ENTRIES {
            next.drain(MAX_ENTRIES..).collect()
        } else {
            Vec::new()
        };

        if let Err(error) = write_json_atomic(&self.path, &next) {
            if image.is_some() {
                remove_image_files(&self.dir, &entry.id);
            }
            return Err(error);
        }

        self.entries = next;
        for old in evicted {
            if old.kind == "image" {
                remove_image_files(&self.dir, &old.id);
            }
        }
        Ok(entry)
    }

    fn remove(&mut self, ids: &[String]) -> Result<(), String> {
        let (removed, kept): (Vec<_>, Vec<_>) = self
            .entries
            .iter()
            .cloned()
            .partition(|item| ids.contains(&item.id));
        if removed.is_empty() {
            return Ok(());
        }
        // 先写新索引，成功后再提交内存并清理旧图片文件，保证写盘失败时内存与磁盘一致。
        write_json_atomic(&self.path, &kept)?;
        self.entries = kept;
        for item in &removed {
            if item.kind == "image" {
                remove_image_files(&self.dir, &item.id);
            }
        }
        Ok(())
    }
}

fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.thumb.jpg"))
}

fn remove_image_files(dir: &Path, id: &str) {
    let _ = fs::remove_file(dir.join(format!("{id}.png")));
    let _ = fs::remove_file(thumb_path(dir, id));
}

fn clipboard_thumb_size(width: u32, height: u32) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    if width <= CLIP_THUMB_MAX_WIDTH && height <= CLIP_THUMB_MAX_HEIGHT {
        return (width, height);
    }
    let scale = (CLIP_THUMB_MAX_WIDTH as f64 / width as f64)
        .min(CLIP_THUMB_MAX_HEIGHT as f64 / height as f64);
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

/// 生成剪贴板列表专用轻量缩略图：透明像素压到白底避免黑块，再以 JPEG 编码。
fn encode_thumbnail(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let (tw, th) = clipboard_thumb_size(image.width(), image.height());
    let resized = image::imageops::thumbnail(image, tw, th);
    let rgb = image::RgbImage::from_fn(tw, th, |x, y| {
        let [r, g, b, a] = resized.get_pixel(x, y).0;
        let alpha = u16::from(a);
        let inv = 255 - alpha;
        image::Rgb([
            ((u16::from(r) * alpha + 255 * inv) / 255) as u8,
            ((u16::from(g) * alpha + 255 * inv) / 255) as u8,
            ((u16::from(b) * alpha + 255 * inv) / 255) as u8,
        ])
    });
    let mut bytes = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, CLIP_THUMB_JPEG_QUALITY);
    encoder
        .encode_image(&rgb)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 图片统一按原始 RGBA 像素与宽高计算哈希，保证 PNG（带色彩配置元数据）与 arboard TIFF 重编码后哈希一致。
pub(crate) fn hash_rgba(width: u32, height: u32, rgba: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_bounded_image(raw: &RawClipboardImage) -> Option<RgbaImage> {
    match raw {
        RawClipboardImage::Encoded(bytes) => {
            let reader = ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .ok()?;
            let (width, height) = reader.into_dimensions().ok()?;
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
            {
                return None;
            }
            image::load_from_memory(bytes)
                .ok()
                .map(|img| img.to_rgba8())
        }
        RawClipboardImage::Rgba {
            width,
            height,
            bytes,
        } => {
            if *width == 0
                || *height == 0
                || u64::from(*width) * u64::from(*height) > MAX_IMAGE_PIXELS
            {
                return None;
            }
            RgbaImage::from_raw(*width, *height, bytes.clone())
        }
    }
}

/// 串行化后台轮询与「放回剪贴板」：放回后同步推进 marker，避免轮询再重复采集或立即推送事件。
fn poll_marker() -> &'static Mutex<String> {
    static MARKER: OnceLock<Mutex<String>> = OnceLock::new();
    MARKER.get_or_init(|| Mutex::new(String::new()))
}

/// 后台轮询：不支持剪贴板历史的平台直接退出，不创建空转线程；支持平台在内容未变时零拷贝返回。
pub(crate) fn start(app: AppHandle) {
    if !os::clipboard_history_supported() {
        return;
    }
    thread::spawn(move || loop {
        thread::sleep(POLL_INTERVAL);
        let Some(state) = app.try_state::<AppState>() else {
            continue;
        };
        let captured = {
            let mut last_marker = poll_marker().lock();
            let Some(sample) = os::clipboard_sample(&last_marker) else {
                continue;
            };
            if sample.marker == *last_marker {
                continue;
            }
            *last_marker = sample.marker.clone();
            if sample.concealed {
                continue;
            }
            capture_sample(&state, &sample)
        };
        if let Ok(Some(entry)) = captured {
            let _ = app.emit("clipboard-history-changed", &entry);
        }
    });
}

fn capture_sample(
    state: &AppState,
    sample: &Sample,
) -> Result<Option<ClipboardHistoryEntry>, String> {
    if let Some(text) = sample.text.as_deref() {
        let trimmed = text.trim();
        if trimmed.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
            return Ok(None);
        }
        let hash = hash_bytes(text.as_bytes());
        let mut history = state.clipboard_history.lock();
        if history.is_head_hash(&hash) {
            return Ok(None);
        }
        return history
            .push("text", text.to_string(), 0, 0, hash, None)
            .map(Some);
    }

    if let Some(raw_image) = sample.image.as_ref() {
        // 解码与 PNG/缩略图压缩全部放在互斥锁之外，避免阻塞主线程列表读取与 media:// 图片加载。
        let Some(rgba) = decode_bounded_image(raw_image) else {
            return Ok(None);
        };
        let (width, height) = (rgba.width(), rgba.height());
        let hash = hash_rgba(width, height, rgba.as_raw());
        if state.clipboard_history.lock().is_head_hash(&hash) {
            return Ok(None);
        }
        let png = crate::capture::encode_png(&rgba)?;
        let thumb = encode_thumbnail(&rgba).ok();
        let mut history = state.clipboard_history.lock();
        if history.is_head_hash(&hash) {
            return Ok(None);
        }
        return history
            .push(
                "image",
                String::new(),
                width,
                height,
                hash,
                Some((&png, thumb.as_deref())),
            )
            .map(Some);
    }

    Ok(None)
}

#[tauri::command]
pub(crate) fn list_clipboard_history(state: State<'_, AppState>) -> Vec<ClipboardHistoryEntry> {
    state.clipboard_history.lock().entries.clone()
}

#[tauri::command]
pub(crate) async fn delete_clipboard_history(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    on_worker(app, move |app, state| {
        let entries = {
            let mut history = state.clipboard_history.lock();
            history.remove(&ids)?;
            history.entries.clone()
        };
        let _ = app.emit("clipboard-history-changed", ());
        Ok(entries)
    })
    .await
}

/// 把一条历史重新放回剪贴板，同时以当前时间追加一条新记录（不清理旧条目，保持时间线分明）。
/// 不主动推送 `clipboard-history-changed`，等用户离开剪贴板页再次进入时自然看到新条目。
#[tauri::command]
pub(crate) async fn copy_clipboard_history(
    app: AppHandle,
    id: String,
) -> Result<ClipboardHistoryEntry, String> {
    on_worker(app, move |_app, state| {
        let (entry, dir) = {
            let history = state.clipboard_history.lock();
            (
                history.entries.iter().find(|item| item.id == id).cloned(),
                history.dir.clone(),
            )
        };
        let entry = entry.ok_or("这条剪贴板记录已被删除")?;
        if entry.kind == "image" {
            let path = dir.join(format!("{}.png", entry.id));
            let bytes = fs::read(&path).map_err(|_| "记录的图片文件已丢失".to_string())?;
            let image = image::load_from_memory(&bytes)
                .map_err(|error| format!("无法读取记录的图片：{error}"))?
                .to_rgba8();
            let thumb = fs::read(thumb_path(&dir, &entry.id))
                .ok()
                .or_else(|| encode_thumbnail(&image).ok());
            let mut last_marker = poll_marker().lock();
            clipboard::copy_image(image)?;
            let created = state.clipboard_history.lock().push(
                "image",
                String::new(),
                entry.width,
                entry.height,
                entry.hash,
                Some((&bytes, thumb.as_deref())),
            )?;
            if let Some(marker) = os::clipboard_marker() {
                *last_marker = marker;
            }
            Ok(created)
        } else {
            let mut last_marker = poll_marker().lock();
            Clipboard::new()
                .and_then(|mut clipboard| clipboard.set_text(entry.text.clone()))
                .map_err(|error| format!("写入剪贴板失败：{error}"))?;
            let created = state
                .clipboard_history
                .lock()
                .push("text", entry.text, 0, 0, entry.hash, None)?;
            if let Some(marker) = os::clipboard_marker() {
                *last_marker = marker;
            }
            Ok(created)
        }
    })
    .await
}

/// media:// 协议取历史图片：先在锁内定位路径，释放锁后再读磁盘文件。
pub(crate) fn read_image(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let path = {
        let history = state.clipboard_history.lock();
        let entry = history
            .entries
            .iter()
            .find(|item| item.id == id && item.kind == "image")
            .ok_or("记录不存在")?;
        history.dir.join(format!("{}.png", entry.id))
    };
    fs::read(path).map_err(|_| "记录的图片文件已丢失".to_string())
}

/// media:// 协议取剪贴板列表缩略图：命中磁盘缓存直接返回；旧记录缺缩略图时按原图现做并落盘缓存。
pub(crate) fn read_thumbnail(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let (thumb, original) = {
        let history = state.clipboard_history.lock();
        let entry = history
            .entries
            .iter()
            .find(|item| item.id == id && item.kind == "image")
            .ok_or("记录不存在")?;
        (
            thumb_path(&history.dir, &entry.id),
            history.dir.join(format!("{}.png", entry.id)),
        )
    };
    if let Ok(bytes) = fs::read(&thumb) {
        return Ok(bytes);
    }
    let bytes = fs::read(&original).map_err(|_| "记录的图片文件已丢失".to_string())?;
    let image = image::load_from_memory(&bytes)
        .map_err(|error| format!("无法读取记录的图片：{error}"))?
        .to_rgba8();
    let encoded = encode_thumbnail(&image)?;
    let _ = fs::write(&thumb, &encoded);
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    use std::sync::atomic::AtomicUsize;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
            Self(std::env::temp_dir().join(format!(
                "snapshot-clip-history-{}-{}-{}",
                std::process::id(),
                now_millis(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            )))
        }
        fn history(&self) -> ClipboardHistory {
            ClipboardHistory::load(self.0.join("index.json"), self.0.join("images"))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn repeated_push_keeps_previous_entry_with_distinct_id_and_order() {
        let dir = TestDir::new();
        let mut history = dir.history();
        let h1 = hash_bytes(b"one");
        let first = history
            .push("text", "one".into(), 0, 0, h1.clone(), None)
            .unwrap();
        let second = history
            .push("text", "two".into(), 0, 0, hash_bytes(b"two"), None)
            .unwrap();
        let recopied = history
            .push("text", "one".into(), 0, 0, h1.clone(), None)
            .unwrap();
        assert_eq!(history.entries.len(), 3);
        assert_ne!(recopied.id, first.id);
        assert_eq!(history.entries[0].id, recopied.id);
        assert_eq!(history.entries[1].id, second.id);
        assert_eq!(history.entries[2].id, first.id);
        assert!(history.is_head_hash(&h1));

        let reloaded = dir.history();
        assert_eq!(reloaded.entries.len(), 3);
        assert_eq!(reloaded.entries[0].id, recopied.id);
        assert_eq!(reloaded.entries[2].id, first.id);
    }

    #[test]
    fn recopied_image_owns_independent_files_when_original_is_removed() {
        let dir = TestDir::new();
        let mut history = dir.history();
        let img = RgbaImage::from_pixel(4, 4, image::Rgba([10, 20, 30, 255]));
        let png = crate::capture::encode_png(&img).unwrap();
        let thumb = encode_thumbnail(&img).unwrap();
        let hash = hash_rgba(4, 4, img.as_raw());
        let first = history
            .push(
                "image",
                String::new(),
                4,
                4,
                hash.clone(),
                Some((&png, Some(&thumb))),
            )
            .unwrap();
        let recopied = history
            .push(
                "image",
                String::new(),
                4,
                4,
                hash,
                Some((&png, Some(&thumb))),
            )
            .unwrap();
        assert_eq!(history.entries.len(), 2);
        assert_ne!(first.id, recopied.id);

        history.remove(std::slice::from_ref(&first.id)).unwrap();
        assert!(!history.dir.join(format!("{}.png", first.id)).exists());
        assert!(!thumb_path(&history.dir, &first.id).exists());
        assert!(history.dir.join(format!("{}.png", recopied.id)).exists());
        assert!(thumb_path(&history.dir, &recopied.id).exists());
    }

    #[test]
    fn canonical_pixel_hash_matches_across_png_and_tiff_encodings() {
        let original = RgbaImage::from_fn(4, 3, |x, y| {
            image::Rgba([x as u8 * 40, y as u8 * 60, 128, 255])
        });
        let png = crate::capture::encode_png(&original).unwrap();
        let mut tiff = Vec::new();
        image::codecs::tiff::TiffEncoder::new(Cursor::new(&mut tiff))
            .write_image(
                original.as_raw(),
                original.width(),
                original.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        assert_ne!(hash_bytes(&png), hash_bytes(&tiff));
        let from_png = decode_bounded_image(&RawClipboardImage::Encoded(png)).unwrap();
        let from_tiff = decode_bounded_image(&RawClipboardImage::Encoded(tiff)).unwrap();
        assert_eq!(
            hash_rgba(from_png.width(), from_png.height(), from_png.as_raw()),
            hash_rgba(from_tiff.width(), from_tiff.height(), from_tiff.as_raw()),
        );
    }

    #[test]
    fn oversized_dimensions_are_rejected_without_panicking() {
        let rejected = decode_bounded_image(&RawClipboardImage::Rgba {
            width: 10_000,
            height: 5_000,
            bytes: Vec::new(),
        });
        assert!(rejected.is_none());
    }

    #[test]
    fn remove_deletes_image_files_and_keeps_the_rest() {
        let dir = TestDir::new();
        let mut history = dir.history();
        let img = RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]));
        let png = crate::capture::encode_png(&img).unwrap();
        let thumb = encode_thumbnail(&img).unwrap();
        let image_entry = history
            .push(
                "image",
                String::new(),
                2,
                2,
                hash_rgba(2, 2, img.as_raw()),
                Some((&png, Some(&thumb))),
            )
            .unwrap();
        let text_entry = history
            .push("text", "keep".into(), 0, 0, hash_bytes(b"keep"), None)
            .unwrap();
        let image_path = history.dir.join(format!("{}.png", image_entry.id));
        let thumb_file = thumb_path(&history.dir, &image_entry.id);
        assert!(image_path.exists());
        assert!(thumb_file.exists());
        history
            .remove(std::slice::from_ref(&image_entry.id))
            .unwrap();
        assert!(!image_path.exists());
        assert!(!thumb_file.exists());
        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].id, text_entry.id);
    }

    #[test]
    fn failed_remove_preserves_memory_entries_and_image_file() {
        let dir = TestDir::new();
        let mut history = dir.history();
        let img = RgbaImage::from_pixel(2, 2, image::Rgba([9, 8, 7, 255]));
        let png = crate::capture::encode_png(&img).unwrap();
        let image_entry = history
            .push(
                "image",
                String::new(),
                2,
                2,
                hash_rgba(2, 2, img.as_raw()),
                Some((&png, None)),
            )
            .unwrap();
        let image_path = history.dir.join(format!("{}.png", image_entry.id));
        // 把索引路径指向一个已存在的目录，强制原子写盘失败
        let bad_dir = dir.0.join("unwritable-index-dir");
        fs::create_dir_all(&bad_dir).unwrap();
        history.path = bad_dir;

        assert!(history
            .remove(std::slice::from_ref(&image_entry.id))
            .is_err());
        assert_eq!(history.entries.len(), 1);
        assert!(image_path.exists());
    }

    #[test]
    fn cap_evicts_oldest_entries_with_their_files() {
        let dir = TestDir::new();
        let mut history = dir.history();
        for index in 0..(MAX_ENTRIES + 3) {
            let text = format!("entry-{index}");
            history
                .push(
                    "text",
                    text.clone(),
                    0,
                    0,
                    hash_bytes(text.as_bytes()),
                    None,
                )
                .unwrap();
        }
        assert_eq!(history.entries.len(), MAX_ENTRIES);
        assert_eq!(
            history.entries[0].text,
            format!("entry-{}", MAX_ENTRIES + 2)
        );
        assert!(!history.entries.iter().any(|item| item.text == "entry-0"));
    }

    #[test]
    fn clipboard_thumbnails_bound_dimensions_and_encode_valid_jpeg() {
        assert_eq!(clipboard_thumb_size(2560, 1440), (256, 144));
        assert_eq!(clipboard_thumb_size(2400, 300), (420, 53));
        assert_eq!(clipboard_thumb_size(100, 80), (100, 80));

        let sample = RgbaImage::from_pixel(320, 200, image::Rgba([20, 120, 210, 128]));
        let bytes = encode_thumbnail(&sample).unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (230, 144));
    }

    #[test]
    fn hash_is_stable_and_content_sensitive() {
        assert_eq!(hash_bytes(b"abc"), hash_bytes(b"abc"));
        assert_ne!(hash_bytes(b"abc"), hash_bytes(b"abd"));
    }
}
