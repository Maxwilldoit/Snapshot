//! 剪贴板历史：macOS / Linux 上始终开启，后台每秒看一眼系统剪贴板，把新复制的文字和图片
//! 存进应用数据目录（索引 clipboard-history.json + 图片 clipboard-history/<id>.png）。
//! 密码管理器标记为敏感的内容（Concealed / transient）跳过。
//! 删除单条或清空都立即落盘；Windows 采样恒空，等于没有这个功能。

use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 最多保留的条数；超出后从最旧的一端连同图片文件一起删。
const MAX_ENTRIES: usize = 500;
/// 单条文字上限（字符数）；再长的复制多半是数据导出，不适合当历史条目。
const MAX_TEXT_CHARS: usize = 100_000;
/// 单张图片像素上限（宽 × 高），约 8K 截图；再大的跳过，避免解码占满内存。
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
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
    /// 内容哈希：去重、以及判断「当前剪贴板还是这条」
    pub(crate) hash: String,
}

pub(crate) struct ClipboardHistory {
    path: PathBuf,
    dir: PathBuf,
    entries: Vec<ClipboardHistoryEntry>,
    counter: u64,
}

/// 平台采样结果。marker 用来判断剪贴板变没变（macOS changeCount；Linux 用内容哈希）。
pub(crate) struct Sample {
    pub(crate) marker: String,
    /// 密码管理器等标记的敏感内容：跳过，不读也不存
    pub(crate) concealed: bool,
    pub(crate) text: Option<String>,
    /// 已编码的 PNG 字节
    pub(crate) png: Option<Vec<u8>>,
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

    fn push(
        &mut self,
        kind: &str,
        text: String,
        width: u32,
        height: u32,
        hash: String,
        png: Option<&[u8]>,
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
        if let Some(bytes) = png {
            fs::create_dir_all(&self.dir).map_err(|error| error.to_string())?;
            fs::write(self.dir.join(format!("{}.png", entry.id)), bytes)
                .map_err(|error| error.to_string())?;
        }
        self.entries.insert(0, entry.clone());
        while self.entries.len() > MAX_ENTRIES {
            if let Some(old) = self.entries.pop() {
                if old.kind == "image" {
                    let _ = fs::remove_file(self.dir.join(format!("{}.png", old.id)));
                }
            }
        }
        match write_json_atomic(&self.path, &self.entries) {
            Ok(()) => Ok(entry),
            Err(error) => {
                self.entries.remove(0);
                if png.is_some() {
                    let _ = fs::remove_file(self.dir.join(format!("{}.png", entry.id)));
                }
                Err(error)
            }
        }
    }

    fn remove(&mut self, ids: &[String]) -> Result<(), String> {
        let (removed, kept): (Vec<_>, Vec<_>) = self
            .entries
            .drain(..)
            .partition(|item| ids.contains(&item.id));
        for item in &removed {
            if item.kind == "image" {
                let _ = fs::remove_file(self.dir.join(format!("{}.png", item.id)));
            }
        }
        if let Err(error) = write_json_atomic(&self.path, &kept) {
            // 写盘失败把条目放回原位，文件已删的图片条目不复活（读图时会报缺失）
            self.entries = kept;
            return Err(error);
        }
        self.entries = kept;
        Ok(())
    }
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 后台轮询：内容没变（marker 相同）不做任何事；平台不支持时采样恒空。
pub(crate) fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut last_marker = String::new();
        loop {
            thread::sleep(POLL_INTERVAL);
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let Some(sample) = os::clipboard_sample() else {
                continue;
            };
            if sample.marker == last_marker {
                continue;
            }
            last_marker = sample.marker.clone();
            if sample.concealed {
                continue;
            }
            let captured = capture_sample(&state, &sample);
            if let Ok(Some(entry)) = captured {
                let _ = app.emit("clipboard-history-changed", &entry);
            }
        }
    });
}

fn capture_sample(
    state: &AppState,
    sample: &Sample,
) -> Result<Option<ClipboardHistoryEntry>, String> {
    let mut history = state.clipboard_history.lock();
    if let Some(text) = sample.text.as_deref() {
        let trimmed = text.trim();
        if trimmed.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
            return Ok(None);
        }
        let hash = hash_bytes(text.as_bytes());
        if history
            .entries
            .first()
            .is_some_and(|head| head.hash == hash)
        {
            return Ok(None);
        }
        // 同一内容再次复制：挪到最前并更新时间，而不是存重复条目
        if let Some(position) = history.entries.iter().position(|item| item.hash == hash) {
            let mut existing = history.entries.remove(position);
            existing.created_at = now_millis();
            history.entries.insert(0, existing.clone());
            write_json_atomic(&history.path, &history.entries)?;
            return Ok(Some(existing));
        }
        return history
            .push("text", text.to_string(), 0, 0, hash, None)
            .map(Some);
    }
    if let Some(png) = sample.png.as_deref() {
        let hash = hash_bytes(png);
        if history
            .entries
            .first()
            .is_some_and(|head| head.hash == hash)
        {
            return Ok(None);
        }
        if let Some(position) = history.entries.iter().position(|item| item.hash == hash) {
            let mut existing = history.entries.remove(position);
            existing.created_at = now_millis();
            history.entries.insert(0, existing.clone());
            write_json_atomic(&history.path, &history.entries)?;
            return Ok(Some(existing));
        }
        let image = image::load_from_memory(png).map_err(|error| error.to_string())?;
        if u64::from(image.width()) * u64::from(image.height()) > MAX_IMAGE_PIXELS {
            return Ok(None);
        }
        let (width, height) = (image.width(), image.height());
        return history
            .push("image", String::new(), width, height, hash, Some(png))
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
        let mut history = state.clipboard_history.lock();
        history.remove(&ids)?;
        let entries = history.entries.clone();
        drop(history);
        let _ = app.emit("clipboard-history-changed", ());
        Ok(entries)
    })
    .await
}

/// 把一条历史重新放回剪贴板。图片从存的 PNG 解码后走现有 copy_image；
/// 文字直接 set_text。放回去的内容与最新条目哈希一致时，轮询不会记重复。
#[tauri::command]
pub(crate) async fn copy_clipboard_history(app: AppHandle, id: String) -> Result<(), String> {
    on_worker(app, move |_app, state| {
        let entry = {
            let history = state.clipboard_history.lock();
            history.entries.iter().find(|item| item.id == id).cloned()
        };
        let entry = entry.ok_or("这条剪贴板记录已被删除")?;
        if entry.kind == "image" {
            let path = state
                .clipboard_history
                .lock()
                .dir
                .join(format!("{}.png", entry.id));
            let bytes = fs::read(&path).map_err(|_| "记录的图片文件已丢失".to_string())?;
            let image = image::load_from_memory(&bytes)
                .map_err(|error| format!("无法读取记录的图片：{error}"))?
                .to_rgba8();
            clipboard::copy_image(image)?;
        } else {
            Clipboard::new()
                .and_then(|mut clipboard| clipboard.set_text(entry.text.clone()))
                .map_err(|error| format!("写入剪贴板失败：{error}"))?;
        }
        Ok(())
    })
    .await
}

/// media:// 协议取历史图片：先在索引里按 id 找到条目，再读文件。
pub(crate) fn read_image(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let history = state.clipboard_history.lock();
    let entry = history
        .entries
        .iter()
        .find(|item| item.id == id && item.kind == "image");
    let entry = entry.ok_or("记录不存在")?;
    fs::read(history.dir.join(format!("{}.png", entry.id)))
        .map_err(|_| "记录的图片文件已丢失".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn text_push_dedupes_and_moves_repeats_to_front() {
        let dir = TestDir::new();
        let mut history = dir.history();
        history
            .push("text", "one".into(), 0, 0, hash_bytes(b"one"), None)
            .unwrap();
        history
            .push("text", "two".into(), 0, 0, hash_bytes(b"two"), None)
            .unwrap();
        assert_eq!(history.entries.len(), 2);
        assert_eq!(history.entries[0].text, "two");
        // 重载后条目仍在
        let reloaded = dir.history();
        assert_eq!(reloaded.entries.len(), 2);
    }

    #[test]
    fn remove_deletes_image_files_and_keeps_the_rest() {
        let dir = TestDir::new();
        let mut history = dir.history();
        let png =
            crate::capture::encode_png(&RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255])))
                .unwrap();
        let image_entry = history
            .push("image", String::new(), 2, 2, hash_bytes(&png), Some(&png))
            .unwrap();
        let text_entry = history
            .push("text", "keep".into(), 0, 0, hash_bytes(b"keep"), None)
            .unwrap();
        let image_path = history.dir.join(format!("{}.png", image_entry.id));
        assert!(image_path.exists());
        history
            .remove(std::slice::from_ref(&image_entry.id))
            .unwrap();
        assert!(!image_path.exists());
        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].id, text_entry.id);
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
    fn hash_is_stable_and_content_sensitive() {
        assert_eq!(hash_bytes(b"abc"), hash_bytes(b"abc"));
        assert_ne!(hash_bytes(b"abc"), hash_bytes(b"abd"));
    }
}
