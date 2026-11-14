//! 窗口录制的共享部分：选目标、定落盘位置、记录状态。
//! 怎么录由各平台自己决定（WGC / ScreenCaptureKit / ffmpeg+portal），见 `os::start_recording`。

use super::*;

/// 录制选项，来自设置里的偏好
pub(crate) struct RecordOptions {
    pub(crate) include_cursor: bool,
    pub(crate) system_audio: bool,
    pub(crate) microphone: bool,
}

impl RecordOptions {
    /// A preference from another OS stays saved, but hidden, unsupported inputs
    /// must not be sent to this recorder (for example a macOS 15 microphone
    /// preference opened on macOS 14).
    fn supported(settings: &settings::Settings, caps: &capabilities::PlatformCapabilities) -> Self {
        Self {
            include_cursor: settings.include_cursor && caps.include_cursor.available,
            system_audio: settings.record_system_audio && caps.recording_system_audio.available,
            microphone: settings.record_microphone && caps.recording_microphone.available,
        }
    }
}

struct Active {
    session: os::Recording,
    target: String,
    /// 来源应用稳定标识，开录时取一次，停止时写进 recording-meta.json
    app_id: Option<String>,
    started_at: u64,
    output: PathBuf,
}

/// 录完的一段，用来写活动记录
pub(crate) struct Finished {
    pub(crate) target: String,
    pub(crate) app_id: Option<String>,
    pub(crate) duration_ms: u64,
    pub(crate) output: PathBuf,
}

#[derive(Default)]
pub(crate) struct Recorder {
    active: Option<Active>,
    /// 上一次录制异常结束的原因，在下一次状态查询里带给界面
    last_message: Option<String>,
}

impl Recorder {
    /// 正在写的那个文件：列表和媒体协议都要避开它，免得把半截录像当成品
    pub(crate) fn active_output(&self) -> Option<PathBuf> {
        self.active.as_ref().map(|active| active.output.clone())
    }

    fn status(&self, message: Option<String>) -> RecordingStatus {
        RecordingStatus {
            active: self.active.is_some(),
            target: self.active.as_ref().map(|active| active.target.clone()),
            started_at: self.active.as_ref().map(|active| active.started_at),
            message: message.or_else(|| self.last_message.clone()),
        }
    }

    /// 录制可能自己结束了（macOS 的录制组件崩溃等）：发现了就收尾并记下原因。
    fn refresh(&mut self) -> Option<String> {
        if let Some(reason) = self
            .active
            .as_mut()
            .and_then(|active| active.session.exit_reason())
        {
            self.active = None;
            self.last_message = Some(reason.clone());
            return Some(reason);
        }
        None
    }

    pub(crate) fn stop(&mut self) -> Option<Finished> {
        let active = self.active.take()?;
        let finished = Finished {
            target: active.target,
            app_id: active.app_id,
            duration_ms: now_millis().saturating_sub(active.started_at),
            output: active.output,
        };
        match active.session.stop() {
            Ok(()) => match validate_recording_output(&finished.output) {
                Ok(()) => Some(finished),
                Err(error) => {
                    self.last_message = Some(error);
                    None
                }
            },
            Err(message) => {
                self.last_message = Some(message);
                None
            }
        }
    }
}

fn validate_recording_output(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("录制文件不可用：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        let _ = fs::remove_file(path);
        return Err("录制没有生成有效文件".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingStatus {
    pub(crate) active: bool,
    pub(crate) target: Option<String>,
    pub(crate) started_at: Option<u64>,
    /// 启动时的 UI 提示（如 Linux portal 需重新选窗）；停止时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

#[tauri::command]
pub(crate) fn get_recording_status(app: AppHandle, state: State<'_, AppState>) -> RecordingStatus {
    let mut recorder = state.recorder.lock();
    let failure = recorder.refresh();
    let status = recorder.status(None);
    drop(recorder);
    if let Some(reason) = failure {
        activity::record_error(
            &app,
            ui_text("录制意外结束", "Recording stopped unexpectedly"),
            &reason,
        );
        let _ = app.emit("recording-changed", &status);
        let _ = app.emit("pet-event", "recording.failure");
    }
    status
}

/// 按窗口 id 取一份录制目标。窗口在点选之后、开录之前被关掉是常事，
/// 所以这里要报「已关闭」而不是沉默地退回「上一个应用」。
fn list_tracked_window(app: &AppHandle, id: u32) -> Result<tracker::TrackedWindow, String> {
    #[cfg(target_os = "windows")]
    if let Some(main) = tracker::own_main_window(app, id) {
        return Ok(tracker::TrackedWindow {
            id,
            pid: std::process::id(),
            app_name: "snapshot".into(),
            title: main.title().map_err(|error| error.to_string())?,
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    let window = Window::all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|window| window.id().ok() == Some(id))
        .ok_or_else(|| "目标窗口已关闭".to_string())?;
    Ok(tracker::TrackedWindow {
        id,
        pid: window.pid().unwrap_or_default(),
        app_name: window
            .app_name()
            .unwrap_or_else(|_| crate::ui_text("应用", "App").into()),
        title: window.title().unwrap_or_default(),
    })
}

/// 录制产物目录：优先 recording_dir，其次沿用截图的 save_dir，都没填就落到「下载」。
/// 保留 save_dir 这一层回退，是为了不改变升级前只设过 save_dir 的用户的去向。
fn resolve_recording_dir(settings: &settings::Settings) -> Result<PathBuf, String> {
    for candidate in [settings.recording_dir.trim(), settings.save_dir.trim()] {
        if !candidate.is_empty() {
            return Ok(PathBuf::from(snapshots::expand_user_path(candidate)));
        }
    }
    default_recording_dir().ok_or_else(|| "无法确定录制保存目录".to_string())
}

/// 系统「下载」目录。Linux 上 dirs 只认 ~/.config/user-dirs.dirs 里登记的 XDG_DOWNLOAD_DIR，
/// 精简桌面、容器、远程会话里常常没有这个文件；这时按惯例退回 ~/Downloads，不让录制直接失败。
/// Windows / macOS 上 download_dir 总有值。
fn default_recording_dir() -> Option<PathBuf> {
    dirs::download_dir().or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
}

/// 在系统文件管理器里打开录制目录。目录可能还没建过，先建出来再打开。
#[tauri::command]
pub(crate) fn open_recordings_dir(state: State<'_, AppState>) -> Result<String, String> {
    let path = resolve_recording_dir(&state.settings.lock())?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建录制目录：{error}"))?;
    os::open_folder(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn get_recording_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(resolve_recording_dir(&state.settings.lock())?
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub(crate) fn toggle_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: Option<u32>,
) -> Result<RecordingStatus, String> {
    let mut recorder = state.recorder.lock();
    if let Some(reason) = recorder.refresh() {
        let status = recorder.status(None);
        drop(recorder);
        activity::record_error(
            &app,
            ui_text("录制意外结束", "Recording stopped unexpectedly"),
            &reason,
        );
        let _ = app.emit("recording-changed", &status);
        let _ = app.emit("pet-event", "recording.failure");
        return Err(format!(
            "{}：{reason}",
            ui_text("录制意外结束", "Recording stopped unexpectedly")
        ));
    }
    if recorder.active.is_some() {
        let finished = recorder.stop();
        let status = recorder.status(None);
        drop(recorder);
        return match finished {
            Some(finished) => {
                activity::record(
                    &app,
                    activity::Activity::new("record", finished.target)
                        .meta(format_duration(finished.duration_ms))
                        .detail(finished.output.to_string_lossy().to_string()),
                );
                // 来源应用稳定标识单独落盘：活动流水只留最近 300 条，角标却要一直在
                if let Some(stem) = finished
                    .output
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(recording_stem)
                {
                    write_recording_meta_entry(&state.recording_meta_path, stem, finished.app_id);
                }
                let _ = app.emit("recording-changed", &status);
                // 录像在历史页有了固定的家：列表据此刷新，不再靠完成提示指路
                let _ = app.emit("recordings-changed", ());
                let _ = app.emit("pet-event", "recording.stopped");
                Ok(status)
            }
            None => {
                let reason = status
                    .message
                    .as_deref()
                    .unwrap_or("录制组件没有正常结束")
                    .to_string();
                activity::record_error(
                    &app,
                    ui_text("录制没能保存", "The recording wasn’t saved"),
                    &reason,
                );
                let _ = app.emit("recording-changed", &status);
                let _ = app.emit("pet-event", "recording.failure");
                Err(format!(
                    "{}：{reason}",
                    ui_text("录制没能保存", "The recording wasn’t saved")
                ))
            }
        };
    }

    // 指定了窗口就录它；没指定才回到「上一个应用」，与窗口快照的口径一致
    let target = match target_id {
        Some(id) => list_tracked_window(&app, id)?,
        None => state
            .tracker
            .lock()
            .previous
            .clone()
            .ok_or_else(|| "还没有上一个应用可录制".to_string())?,
    };
    let settings = state.settings.lock().clone();
    let output_dir = resolve_recording_dir(&settings)?;
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S");
    let output = output_dir.join(if interface_is_english() {
        format!("Snapshot-{timestamp}.mp4")
    } else {
        format!("应用快照-{timestamp}.mp4")
    });
    recorder.last_message = None;

    let options = RecordOptions::supported(&settings, &os::capabilities());
    let (session, message) = os::start_recording(target.id, &options, &output)?;
    // 录的是哪个窗口就记哪个应用的稳定标识（开录时取一次）；取不到就没有角标，不影响录制
    let app_id = os::app_stable_id(target.pid);
    recorder.active = Some(Active {
        session,
        target: target.app_name,
        app_id,
        started_at: now_millis(),
        output,
    });
    let status = recorder.status(message);
    let _ = app.emit("recording-changed", &status);
    let _ = app.emit("pet-event", "recording.started");
    Ok(status)
}

/// 03:07、1:02:03
pub(crate) fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

/// 历史页里的一段录像。不另建索引：目录就是事实来源，文件名里带着录制时间。
/// 时长和画面尺寸由前端用 video 元素量（preload=metadata），后端不引入解码依赖。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingRecord {
    /// 文件名去掉 .mp4，媒体协议按它取文件
    pub(crate) id: String,
    pub(crate) file_name: String,
    pub(crate) app_name: String,
    pub(crate) size_bytes: u64,
    pub(crate) created_at: u64,
    /// 来源应用稳定标识，来自 recording-meta.json。旧录像没有条目就是 None，不显示角标。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_id: Option<String>,
}

/// 只认本应用写出的录像：保存目录可能就是「下载」，不能把别人的视频列进来，更不能删。
const RECORDING_PREFIXES: [&str; 2] = ["应用快照-", "Snapshot-"];

fn recording_stem(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(".mp4")?;
    RECORDING_PREFIXES
        .iter()
        .any(|prefix| stem.starts_with(prefix))
        .then_some(stem)
}

/// 文件名里的本地时间（应用快照-2026-11-12_10-30-00.mp4）；解析不了就用文件修改时间
fn parse_recording_time(stem: &str) -> Option<u64> {
    use chrono::TimeZone;
    let stamp = RECORDING_PREFIXES
        .iter()
        .find_map(|prefix| stem.strip_prefix(prefix))?;
    let naive = chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d_%H-%M-%S").ok()?;
    let local = chrono::Local.from_local_datetime(&naive).earliest()?;
    Some(local.timestamp_millis().max(0) as u64)
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// 扫目录列出录像，新的在前；exclude 是正在录的那个文件。
fn scan_recordings(dir: &Path, exclude: Option<&Path>) -> Vec<RecordingRecord> {
    let mut records = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return records;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || exclude == Some(path.as_path()) {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(stem) = recording_stem(file_name) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        records.push(RecordingRecord {
            id: stem.to_string(),
            file_name: file_name.to_string(),
            app_name: String::new(),
            size_bytes: meta.len(),
            created_at: parse_recording_time(stem).unwrap_or_else(|| mtime_millis(&meta)),
            app_id: None,
        });
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    records
}

/// 目录解析不了（极端环境没有下载目录）时给空列表，与 list_snapshots 的口径一致
pub(crate) fn list_recordings_now(state: &AppState) -> Vec<RecordingRecord> {
    let Ok(dir) = resolve_recording_dir(&state.settings.lock()) else {
        return Vec::new();
    };
    let active = state.recorder.lock().active_output();
    let mut records = scan_recordings(&dir, active.as_deref());
    if !records.is_empty() {
        // 目标应用名记在活动流水里（detail 是落盘路径）；流水只留最近 300 条，
        // 更早的录像退回通用称呼，不影响播放和删除
        let activity = state.activity.lock();
        // 来源应用稳定标识单独存一份，不受流水 300 条上限影响；旧录像没有条目就没有角标
        let meta = read_recording_meta(&state.recording_meta_path);
        for record in &mut records {
            let path = dir.join(&record.file_name);
            record.app_name = activity
                .recording_target(&path.to_string_lossy())
                .unwrap_or_else(|| ui_text("录屏", "Recording").to_string());
            record.app_id = meta.get(&record.id).cloned();
        }
    }
    records
}

#[tauri::command]
pub(crate) fn list_recordings(state: State<'_, AppState>) -> Vec<RecordingRecord> {
    list_recordings_now(&state)
}

/// 录屏来源应用稳定标识索引：`{ 录像 id: appId }`。只存取得到标识的录像，
/// 取不到（进程已退出等）就不写条目，历史也就不显示角标。读不了/没有文件按空索引处理。
fn read_recording_meta(path: &Path) -> HashMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 停止录制时落一条来源标识。写失败不影响录像本身（角标只是锦上添花）。
fn write_recording_meta_entry(path: &Path, id: &str, app_id: Option<String>) {
    let Some(app_id) = app_id else { return };
    let mut meta = read_recording_meta(path);
    meta.insert(id.to_string(), app_id);
    if let Ok(text) = serde_json::to_string(&meta) {
        let _ = fs::write(path, text);
    }
}

/// 删掉选中的几段，返回删完后的列表。正在录的那段不删。
#[tauri::command]
pub(crate) async fn delete_recordings(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<RecordingRecord>, String> {
    on_worker(app, move |app, state| {
        let dir = resolve_recording_dir(&state.settings.lock())?;
        let active = state.recorder.lock().active_output();
        for id in &ids {
            // id 是文件名主干：先验明是本应用的命名，再拼路径，杜绝目录穿越
            if recording_stem(&format!("{id}.mp4")).is_none() {
                continue;
            }
            let path = dir.join(format!("{id}.mp4"));
            if active.as_deref() == Some(path.as_path()) {
                continue;
            }
            match fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(format!("删除录像失败：{error}"));
                }
                _ => {}
            }
        }
        let _ = app.emit("recordings-changed", ());
        Ok(list_recordings_now(state))
    })
    .await
}

/// 按 id 校验出录像的真实路径：只放行本应用命名、不带路径分隔符的 id
fn recording_path(state: &AppState, id: &str) -> Result<PathBuf, String> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("录像路径无效".into());
    }
    let file_name = format!("{id}.mp4");
    if recording_stem(&file_name).is_none() {
        return Err("只能读取本应用录制的视频".into());
    }
    let dir = resolve_recording_dir(&state.settings.lock())?;
    let path = dir.join(&file_name);
    if state.recorder.lock().active_output().as_deref() == Some(path.as_path()) {
        return Err("这段录像还在录制中".into());
    }
    Ok(path)
}

/// 解析单段 Range（bytes=start-end / bytes=start- / bytes=-N）；多段或非法时返回 None，整文件回 200
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        Some((len.saturating_sub(suffix), len - 1))
    } else {
        let start: u64 = start.parse().ok()?;
        let end: u64 = if end.is_empty() {
            len - 1
        } else {
            end.parse().ok()?
        };
        if start >= len || end < start {
            return None;
        }
        Some((start, end.min(len - 1)))
    }
}

/// 媒体协议返回的一段录像：(文件总长, 命中的字节区间, 字节)。区间为 None 表示整文件。
type RecordingBytes = (u64, Option<(u64, u64)>, Vec<u8>);

/// 读文件的一段（或全部）。返回 (总长, 区间, 字节)，媒体协议据此回 206/200。
fn read_file_range(path: &Path, range: Option<&str>) -> Result<RecordingBytes, String> {
    use std::io::{Seek, SeekFrom};
    let mut file = fs::File::open(path).map_err(|_| "录像文件已被移动或删除".to_string())?;
    let len = file
        .metadata()
        .map_err(|error| format!("读取录像信息失败：{error}"))?
        .len();
    if let Some((start, end)) = range.and_then(|header| parse_range(header, len)) {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("读取录像失败：{error}"))?;
        let mut bytes = vec![0; (end - start + 1) as usize];
        file.read_exact(&mut bytes)
            .map_err(|error| format!("读取录像失败：{error}"))?;
        Ok((len, Some((start, end)), bytes))
    } else {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("读取录像失败：{error}"))?;
        Ok((len, None, bytes))
    }
}

/// 媒体协议用：按 id 取录像字节，支持 Range，播放器才能拖动进度条
pub(crate) fn read_range(
    state: &AppState,
    id: &str,
    range: Option<&str>,
) -> Result<RecordingBytes, String> {
    let path = recording_path(state, id)?;
    read_file_range(&path, range)
}

#[cfg(test)]
mod tests {
    use super::{format_duration, now_millis};

    #[test]
    fn hidden_recording_inputs_do_not_leak_preferences_from_another_platform() {
        use crate::capabilities::{CapabilityStatus, PlatformCapabilities};

        let settings = crate::settings::Settings {
            include_cursor: true,
            record_system_audio: true,
            record_microphone: true,
            ..Default::default()
        };
        let mut caps = PlatformCapabilities {
            os: "test".into(),
            display_server: "test".into(),
            recording: CapabilityStatus::yes(),
            recording_system_audio: CapabilityStatus::yes(),
            recording_microphone: CapabilityStatus::no(),
            autostart: CapabilityStatus::yes(),
            scrolling: None,
            include_cursor: CapabilityStatus::no(),
        };
        let options = super::RecordOptions::supported(&settings, &caps);
        assert!(options.system_audio);
        assert!(!options.microphone);
        assert!(!options.include_cursor);
        // Restoring support reuses the preference; no hidden settings reset.
        caps.recording_microphone = CapabilityStatus::yes();
        caps.include_cursor = CapabilityStatus::yes();
        caps.recording_system_audio = CapabilityStatus::no();
        let options = super::RecordOptions::supported(&settings, &caps);
        assert!(options.microphone);
        assert!(options.include_cursor);
        assert!(!options.system_audio);
        assert!(
            settings.record_microphone && settings.record_system_audio && settings.include_cursor
        );
    }

    #[test]
    fn durations_read_like_a_clock() {
        assert_eq!(format_duration(0), "00:00");
        assert_eq!(format_duration(133_400), "02:13");
        assert_eq!(format_duration(3_723_000), "1:02:03");
    }

    #[test]
    fn recording_meta_round_trips_and_skips_missing_identity() {
        let path = std::env::temp_dir().join(format!(
            "snapshot-recording-meta-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        // 取得到标识就落盘，读得回来；旧录像没有条目就是 None
        super::write_recording_meta_entry(
            &path,
            "应用快照-2026-11-12_10-00-00",
            Some("/usr/bin/obs".into()),
        );
        let meta = super::read_recording_meta(&path);
        assert_eq!(
            meta.get("应用快照-2026-11-12_10-00-00").map(String::as_str),
            Some("/usr/bin/obs")
        );
        assert_eq!(meta.get("没有标识的旧录像"), None);
        // 取不到标识（None）不写条目，也不覆盖已有的
        super::write_recording_meta_entry(&path, "应用快照-2026-11-12_10-00-00", None);
        assert_eq!(
            super::read_recording_meta(&path)
                .get("应用快照-2026-11-12_10-00-00")
                .map(String::as_str),
            Some("/usr/bin/obs")
        );
        // 文件不存在按空索引处理，不报错
        let _ = std::fs::remove_file(&path);
        assert!(super::read_recording_meta(&path).is_empty());
    }

    #[test]
    fn empty_or_missing_recording_files_are_rejected() {
        let path = std::env::temp_dir().join(format!(
            "snapshot-recording-validation-{}-{}",
            std::process::id(),
            now_millis()
        ));
        assert!(super::validate_recording_output(&path).is_err());
        std::fs::write(&path, []).unwrap();
        assert!(super::validate_recording_output(&path).is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"mp4").unwrap();
        assert!(super::validate_recording_output(&path).is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn only_own_recordings_are_listed_and_deletable() {
        assert_eq!(
            super::recording_stem("应用快照-2026-11-12_10-30-00.mp4"),
            Some("应用快照-2026-11-12_10-30-00")
        );
        assert_eq!(
            super::recording_stem("Snapshot-2026-11-12_10-30-00.mp4"),
            Some("Snapshot-2026-11-12_10-30-00")
        );
        // 下载目录里别人的视频、改过扩展名的、带路径的都不认
        assert_eq!(super::recording_stem("movie.mp4"), None);
        assert_eq!(
            super::recording_stem("应用快照-2026-11-12_10-30-00.mkv"),
            None
        );
        assert_eq!(
            super::recording_stem("应用快照-x/../../etc.mp4"),
            Some("应用快照-x/../../etc")
        );
    }

    #[test]
    fn recording_time_comes_from_the_file_name() {
        use chrono::TimeZone;
        let local = chrono::Local
            .with_ymd_and_hms(2026, 11, 12, 10, 30, 0)
            .unwrap();
        let stem = format!("应用快照-{}", local.format("%Y-%m-%d_%H-%M-%S"));
        assert_eq!(
            super::parse_recording_time(&stem),
            Some(local.timestamp_millis() as u64)
        );
        assert_eq!(super::parse_recording_time("应用快照-不是时间"), None);
    }

    #[test]
    fn scan_skips_unrelated_files_and_the_active_recording() {
        let dir = std::env::temp_dir().join(format!(
            "snapshot-recording-scan-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let older = dir.join("应用快照-2026-11-11_09-00-00.mp4");
        let newer = dir.join("Snapshot-2026-11-12_10-30-00.mp4");
        let active = dir.join("应用快照-2026-11-12_11-00-00.mp4");
        std::fs::write(&older, b"old").unwrap();
        std::fs::write(&newer, b"newer-longer").unwrap();
        std::fs::write(&active, b"still-writing").unwrap();
        std::fs::write(dir.join("别人的视频.mp4"), b"not ours").unwrap();
        std::fs::write(dir.join("notes.txt"), b"text").unwrap();

        let records = super::scan_recordings(&dir, Some(&active));
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "Snapshot-2026-11-12_10-30-00");
        assert_eq!(records[0].size_bytes, 12);
        assert_eq!(records[1].id, "应用快照-2026-11-11_09-00-00");
        assert!(records[0].created_at > records[1].created_at);

        let all = super::scan_recordings(&dir, None);
        assert_eq!(all.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn range_headers_cover_the_shapes_players_send() {
        assert_eq!(super::parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(super::parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(super::parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(super::parse_range("bytes=95-500", 100), Some((95, 99)));
        // 越界、空段、多段、非法：退回整文件
        assert_eq!(super::parse_range("bytes=100-", 100), None);
        assert_eq!(super::parse_range("bytes=-0", 100), None);
        assert_eq!(super::parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(super::parse_range("items=0-1", 100), None);
        assert_eq!(super::parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn file_reads_return_the_requested_slice() {
        let path = std::env::temp_dir().join(format!(
            "snapshot-recording-range-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::write(&path, b"0123456789").unwrap();
        let (len, span, bytes) = super::read_file_range(&path, Some("bytes=2-5")).unwrap();
        assert_eq!(len, 10);
        assert_eq!(span, Some((2, 5)));
        assert_eq!(bytes, b"2345");
        let (len, span, bytes) = super::read_file_range(&path, Some("bytes=-3")).unwrap();
        assert_eq!(len, 10);
        assert_eq!(span, Some((7, 9)));
        assert_eq!(bytes, b"789");
        let (len, span, bytes) = super::read_file_range(&path, None).unwrap();
        assert_eq!(len, 10);
        assert_eq!(span, None);
        assert_eq!(bytes, b"0123456789");
        let _ = std::fs::remove_file(&path);
    }

    /// Linux 测试报告里的环境：没有 ~/.config/user-dirs.dirs，dirs 拿不到下载目录。
    /// 这时要退回 ~/Downloads，而不是报「无法确定录制保存目录」。
    #[cfg(target_os = "linux")]
    #[test]
    fn falls_back_to_home_downloads_without_xdg_user_dirs() {
        let config =
            std::env::temp_dir().join(format!("snapshot-no-user-dirs-{}", std::process::id()));
        std::fs::create_dir_all(&config).expect("建临时配置目录失败");
        let old = std::env::var_os("XDG_CONFIG_HOME");
        unsafe { std::env::set_var("XDG_CONFIG_HOME", &config) };
        let xdg_download = dirs::download_dir();
        let resolved = super::default_recording_dir();
        unsafe {
            match old {
                Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
        }
        let _ = std::fs::remove_dir_all(&config);

        assert_eq!(xdg_download, None, "临时配置目录里不该有 user-dirs.dirs");
        assert_eq!(
            resolved,
            dirs::home_dir().map(|home| home.join("Downloads"))
        );
    }
}
