use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "record", rename_all = "lowercase")]
pub(crate) enum TrashMedia {
    Snapshot(snapshots::SnapshotRecord),
    Recording(recording::RecordingRecord),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashEntry {
    pub(crate) id: String,
    pub(crate) trashed_at: u64,
    #[serde(flatten)]
    pub(crate) media: TrashMedia,
}

pub(crate) fn checked_file(directory: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || !matches!(
            Path::new(name).components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err("历史文件名无效".into());
    }
    Ok(directory.join(name))
}

fn copy_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut input = fs::File::open(source)?;
    if !input.metadata()?.is_file() {
        return Err(std::io::Error::other("expected a regular file"));
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

pub(crate) fn archive(root: &Path, source: &Path, media: TrashMedia) -> Result<TrashEntry, String> {
    if !fs::symlink_metadata(source).is_ok_and(|meta| meta.is_file()) {
        return Err("历史文件已被移动或删除".into());
    }
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let trashed_at = now_millis();
    fs::create_dir_all(root).map_err(trash_error)?;
    let (id, directory) = loop {
        let id = format!(
            "{trashed_at}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let directory = root.join(&id);
        match fs::create_dir(&directory) {
            Ok(()) => break (id, directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(trash_error(error)),
        }
    };
    let entry = TrashEntry {
        id,
        trashed_at,
        media,
    };
    let metadata = directory.join("entry.json");
    let result = write_json_atomic(&metadata, &entry)
        .map_err(trash_error)
        .and_then(|_| {
            let payload = directory.join("file");
            match fs::rename(source, &payload) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                    let staging = directory.join("copying");
                    copy_new(source, &staging).map_err(trash_error)?;
                    if let Err(error) = fs::rename(&staging, &payload) {
                        let _ = fs::remove_file(staging);
                        return Err(trash_error(error));
                    }
                    if let Err(error) = fs::remove_file(source) {
                        let _ = fs::remove_file(payload);
                        return Err(trash_error(error));
                    }
                    Ok(())
                }
                Err(error) => Err(trash_error(error)),
            }
        });
    if result.is_err() {
        let _ = fs::remove_file(metadata);
        let _ = fs::remove_dir(directory);
    }
    result.map(|()| entry)
}

fn trash_error(error: impl std::fmt::Display) -> String {
    format!("无法操作回收站：{error}")
}

fn read_entry(root: &Path, id: &str) -> Option<TrashEntry> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-') {
        return None;
    }
    let directory = root.join(id);
    if !fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_dir())
        || !fs::symlink_metadata(directory.join("file")).is_ok_and(|meta| meta.is_file())
    {
        return None;
    }
    let entry: TrashEntry = read_json_with_backup(&directory.join("entry.json"))?;
    (entry.id == id).then_some(entry)
}

fn list(root: &Path) -> Result<Vec<TrashEntry>, String> {
    let directories = match fs::read_dir(root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(trash_error(error)),
    };
    let mut entries = Vec::new();
    for directory in directories {
        let directory = directory.map_err(trash_error)?;
        if let Some(entry) = directory
            .file_name()
            .to_str()
            .and_then(|id| read_entry(root, id))
        {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.trashed_at));
    Ok(entries)
}

pub(crate) fn copy_out(root: &Path, entry: &TrashEntry, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("历史文件名无效")?;
    fs::create_dir_all(parent).map_err(trash_error)?;
    let source = root.join(&entry.id).join("file");
    let result = fs::hard_link(&source, destination).or_else(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Err(error)
        } else {
            copy_new(&source, destination)
        }
    });
    result.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "目标文件已存在，无法恢复".into()
        } else {
            trash_error(error)
        }
    })
}

pub(crate) fn discard(root: &Path, entry: &TrashEntry) -> Result<(), String> {
    let directory = root.join(&entry.id);
    fs::remove_file(directory.join("file")).map_err(trash_error)?;
    let _ = fs::remove_file(directory.join("thumb.jpg"));
    let _ = fs::remove_file(directory.join("entry.json"));
    let _ = fs::remove_file(json_backup_path(&directory.join("entry.json")));
    let _ = fs::remove_dir(directory);
    Ok(())
}

pub(crate) fn read_thumbnail(state: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let (thumb_path, raw_bytes) = {
        let _guard = state.trash_lock.lock();
        let entry = read_entry(&state.trash_dir, id).ok_or("找不到这条回收站记录")?;
        if !matches!(entry.media, TrashMedia::Snapshot(_)) {
            return Err("找不到这条回收站记录".into());
        }
        let dir = state.trash_dir.join(&entry.id);
        let thumb_path = dir.join("thumb.jpg");
        if let Ok(cached) = fs::read(&thumb_path) {
            return Ok(cached);
        }
        let bytes = fs::read(dir.join("file")).map_err(trash_error)?;
        (thumb_path, bytes)
    };
    let image = image::load_from_memory(&raw_bytes)
        .map_err(trash_error)?
        .into_rgba8();
    let thumbnail = snapshots::make_thumbnail(&image);
    let encoded = snapshots::encode_thumbnail_jpeg(&thumbnail)?;
    if thumb_path.parent().is_some_and(|dir| dir.is_dir()) {
        let _ = write_cache_atomic(&thumb_path, &encoded);
    }
    Ok(encoded)
}

#[tauri::command]
pub(crate) async fn list_trash(app: AppHandle) -> Result<Vec<TrashEntry>, String> {
    on_worker(app, |_, state| {
        let _guard = state.trash_lock.lock();
        list(&state.trash_dir)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_trash(app: AppHandle, id: String) -> Result<(), String> {
    on_worker(app, move |app, state| {
        let _guard = state.trash_lock.lock();
        let entry = read_entry(&state.trash_dir, &id).ok_or("找不到这条回收站记录")?;
        match &entry.media {
            TrashMedia::Snapshot(record) => {
                snapshots::restore_snapshot(state, &entry, record)?;
                let _ = app.emit("snapshots-changed", ());
            }
            TrashMedia::Recording(record) => {
                recording::restore_recording(state, &entry, record)?;
                let _ = app.emit("recordings-changed", ());
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn purge_trash(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    on_worker(app, move |_, state| {
        let _guard = state.trash_lock.lock();
        for id in ids {
            if let Some(entry) = read_entry(&state.trash_dir, &id) {
                discard(&state.trash_dir, &entry)?;
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archived_bytes_survive_reopening_and_conflicting_restore() {
        let base = std::env::temp_dir().join(format!(
            "snapshot-trash-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&base).unwrap();
        let root = base.join("trash");
        let source = base.join("original.png");
        fs::write(&source, b"original").unwrap();
        let entry = archive(
            &root,
            &source,
            TrashMedia::Snapshot(snapshots::SnapshotRecord {
                id: "original".into(),
                file_name: "original.png".into(),
                app_name: "Snapshot".into(),
                width: 1,
                height: 1,
                size_bytes: 8,
                created_at: 1,
                app_id: None,
            }),
        )
        .unwrap();
        assert!(!source.exists());
        assert_eq!(list(&root).unwrap()[0].id, entry.id);
        assert!(read_entry(&root, "../bad").is_none());
        fs::write(&source, b"conflict").unwrap();
        assert!(copy_out(&root, &entry, &source).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"conflict");
        fs::remove_file(&source).unwrap();
        copy_out(&root, &entry, &source).unwrap();
        discard(&root, &entry).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert!(list(&root).unwrap().is_empty());
        fs::remove_dir_all(base).unwrap();
    }
}
