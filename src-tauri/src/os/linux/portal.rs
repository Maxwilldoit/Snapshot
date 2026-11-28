//! Wayland 录屏门户采集：直连 `org.freedesktop.portal.ScreenCast`（zbus）与 PipeWire，
//! 不经 `xcap::Monitor::all()` 绕道 XCB，从而在纯 Wayland（无 XWayland / 无 `$DISPLAY`）
//! 与混合 Wayland 会话下都能弹出系统选窗/选屏对话框并按 `include_cursor` 请求光标模式。

use std::collections::HashMap;
use std::io::Cursor;
use std::os::fd::OwnedFd as StdOwnedFd;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, Receiver},
    Arc,
};
use std::thread;

use pipewire::{
    channel as pw_channel,
    context::ContextRc,
    keys::{MEDIA_CATEGORY, MEDIA_ROLE, MEDIA_TYPE},
    main_loop::MainLoopRc,
    properties,
    spa::{
        param::{
            format::{FormatProperties, MediaSubtype, MediaType},
            format_utils,
            video::{VideoFormat, VideoInfoRaw},
            ParamType,
        },
        pod::{self, serialize::PodSerializer, Pod},
        utils::{Direction, Fraction, Rectangle, SpaTypes},
    },
    stream::{StreamFlags, StreamRc},
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::{DeserializeDict, OwnedFd as ZbusOwnedFd, OwnedObjectPath, Type, Value},
};

/// ScreenCast SourceTypes 位掩码：1 = Monitor，2 = Window。
const SOURCE_MONITOR: u32 = 1;
const SOURCE_WINDOW: u32 = 2;

/// ScreenCast CursorModes 位掩码：1 = Hidden，2 = Embedded。
const CURSOR_HIDDEN: u32 = 1;
const CURSOR_EMBEDDED: u32 = 2;

static TOKEN_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_token(prefix: &str) -> String {
    let seq = TOKEN_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("snapshot_{prefix}_{}_{seq}", std::process::id())
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct CreateSessionResults {
    session_handle: Option<String>,
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct EmptyResults {}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct StartStreamInfo {
    #[allow(dead_code)]
    source_type: Option<u32>,
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct StartResults {
    streams: Option<Vec<(u32, StartStreamInfo)>>,
}

pub(super) struct PortalFrame {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) raw: Vec<u8>,
}

pub(super) struct PortalRecorder {
    is_running: Arc<AtomicBool>,
    stop_tx: pw_channel::Sender<()>,
    conn: Connection,
    session_path: OwnedObjectPath,
}

impl PortalRecorder {
    pub(super) fn start(include_cursor: bool) -> Result<(Self, Receiver<PortalFrame>), String> {
        let conn = Connection::session()
            .map_err(|error| format!("无法连接 session D-Bus（ScreenCast 需要）：{error}"))?;
        let proxy = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
        )
        .map_err(|error| format!("xdg-desktop-portal 不可用：{error}"))?;

        let session_path = create_session(&conn, &proxy)?;
        if let Err(error) = select_sources(&conn, &proxy, &session_path, include_cursor) {
            close_portal_session(&conn, &session_path);
            return Err(error);
        }
        let stream_node_id = match start_session(&conn, &proxy, &session_path) {
            Ok(id) => id,
            Err(error) => {
                close_portal_session(&conn, &session_path);
                return Err(error);
            }
        };
        let pw_fd = open_pipewire_remote(&proxy, &session_path).ok();

        let (frame_tx, frame_rx) = mpsc::sync_channel::<PortalFrame>(4);
        let (stop_tx, stop_rx) = pw_channel::channel::<()>();
        let is_running = Arc::new(AtomicBool::new(true));
        let running_flag = Arc::clone(&is_running);

        let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();
        thread::spawn(move || {
            if let Err(error) = run_pipewire_stream(
                stream_node_id,
                pw_fd,
                running_flag,
                frame_tx,
                stop_rx,
                &init_tx,
            ) {
                let _ = init_tx.send(Err(error));
            }
        });

        match init_rx.recv() {
            Ok(Ok(())) => Ok((
                Self {
                    is_running,
                    stop_tx,
                    conn,
                    session_path,
                },
                frame_rx,
            )),
            Ok(Err(error)) => {
                close_portal_session(&conn, &session_path);
                Err(format!("ScreenCast start 失败：{error}"))
            }
            Err(_) => {
                close_portal_session(&conn, &session_path);
                Err("ScreenCast start 失败：PipeWire 采集线程意外退出".into())
            }
        }
    }

    pub(super) fn stop(&self) -> Result<(), String> {
        self.is_running.store(false, Ordering::SeqCst);
        let _ = self.stop_tx.send(());
        close_portal_session(&self.conn, &self.session_path);
        Ok(())
    }
}

fn portal_err(detail: impl std::fmt::Display) -> String {
    format!(
        "启动 xdg-desktop-portal ScreenCast 失败：{detail}。请在图形 Wayland 会话中允许屏幕共享，并确认已安装 xdg-desktop-portal 与桌面后端。"
    )
}

fn sender_token_dir(conn: &Connection) -> Result<String, String> {
    let unique = conn
        .unique_name()
        .ok_or_else(|| portal_err("无法读取 D-Bus unique name"))?;
    Ok(unique.as_str().trim_start_matches(':').replace('.', "_"))
}

fn subscribe_request<'a>(
    conn: &'a Connection,
    handle_token: &str,
) -> Result<(Proxy<'a>, zbus::blocking::proxy::SignalIterator<'a>), String> {
    let sender = sender_token_dir(conn)?;
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{handle_token}");
    let request = Proxy::new(
        conn,
        "org.freedesktop.portal.Desktop",
        path,
        "org.freedesktop.portal.Request",
    )
    .map_err(portal_err)?;
    // 必须在调用门户方法前先挂好信号订阅，避免快速响应早于订阅到达而永久挂起
    let signals = request.receive_signal("Response").map_err(portal_err)?;
    Ok((request, signals))
}

fn await_portal_response<T>(
    mut signals: zbus::blocking::proxy::SignalIterator<'_>,
) -> Result<T, String>
where
    T: for<'de> serde::Deserialize<'de> + Type,
{
    let message = signals
        .next()
        .ok_or_else(|| portal_err("门户请求连接已断开"))?;
    let (code, body): (u32, T) = message.body().deserialize().map_err(portal_err)?;
    match code {
        0 => Ok(body),
        1 => Err("已取消屏幕共享授权".into()),
        other => Err(portal_err(format!("门户拒绝了请求（状态码 {other}）"))),
    }
}

fn create_session(conn: &Connection, proxy: &Proxy<'_>) -> Result<OwnedObjectPath, String> {
    let handle_token = next_token("req");
    let session_token = next_token("ses");
    let (_req, signals) = subscribe_request(conn, &handle_token)?;

    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(handle_token.as_str()));
    options.insert("session_handle_token", Value::from(session_token.as_str()));

    proxy
        .call_method("CreateSession", &(options,))
        .map_err(portal_err)?;
    let results: CreateSessionResults = await_portal_response(signals)?;

    if let Some(handle) = results.session_handle {
        return OwnedObjectPath::try_from(handle).map_err(portal_err);
    }
    let sender = sender_token_dir(conn)?;
    OwnedObjectPath::try_from(format!(
        "/org/freedesktop/portal/desktop/session/{sender}/{session_token}"
    ))
    .map_err(portal_err)
}

fn select_sources(
    conn: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
    include_cursor: bool,
) -> Result<(), String> {
    let handle_token = next_token("sel");
    let (_req, signals) = subscribe_request(conn, &handle_token)?;

    let available_types = proxy
        .get_property::<u32>("AvailableSourceTypes")
        .unwrap_or(0);
    let available_cursors = proxy
        .get_property::<u32>("AvailableCursorModes")
        .unwrap_or(0);
    let types = choose_source_types(available_types);
    let cursor_mode = choose_cursor_mode(include_cursor, available_cursors);

    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(handle_token.as_str()));
    options.insert("types", Value::from(types));
    options.insert("multiple", Value::from(false));
    if let Some(mode) = cursor_mode {
        options.insert("cursor_mode", Value::from(mode));
    }

    proxy
        .call_method("SelectSources", &(session, options))
        .map_err(portal_err)?;
    let _: EmptyResults = await_portal_response(signals)?;
    Ok(())
}

fn start_session(
    conn: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
) -> Result<u32, String> {
    let handle_token = next_token("start");
    let (_req, signals) = subscribe_request(conn, &handle_token)?;

    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(handle_token.as_str()));

    proxy
        .call_method("Start", &(session, "", options))
        .map_err(portal_err)?;
    let results: StartResults = await_portal_response(signals)?;
    results
        .streams
        .and_then(|streams| streams.into_iter().next())
        .map(|(node_id, _)| node_id)
        .ok_or_else(|| portal_err("门户未返回可用的 PipeWire 视频流节点"))
}

fn open_pipewire_remote(
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
) -> Result<StdOwnedFd, String> {
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let fd: ZbusOwnedFd = proxy
        .call("OpenPipeWireRemote", &(session, options))
        .map_err(portal_err)?;
    Ok(StdOwnedFd::from(fd))
}

fn close_portal_session(conn: &Connection, session: &OwnedObjectPath) {
    if let Ok(session_proxy) = Proxy::new(
        conn,
        "org.freedesktop.portal.Desktop",
        session.clone(),
        "org.freedesktop.portal.Session",
    ) {
        let _ = session_proxy.call_method("Close", &());
    }
}

pub(super) fn choose_source_types(available: u32) -> u32 {
    let desired = SOURCE_MONITOR | SOURCE_WINDOW;
    let masked = desired & available;
    if masked != 0 {
        masked
    } else {
        desired
    }
}

pub(super) fn choose_cursor_mode(include_cursor: bool, available: u32) -> Option<u32> {
    let preferred = if include_cursor {
        CURSOR_EMBEDDED
    } else {
        CURSOR_HIDDEN
    };
    if available == 0 || (available & preferred) != 0 {
        return Some(preferred);
    }
    if (available & CURSOR_EMBEDDED) != 0 {
        return Some(CURSOR_EMBEDDED);
    }
    if (available & CURSOR_HIDDEN) != 0 {
        return Some(CURSOR_HIDDEN);
    }
    None
}

#[derive(Default)]
struct StreamState {
    format: VideoInfoRaw,
}

fn run_pipewire_stream(
    stream_id: u32,
    pw_fd: Option<StdOwnedFd>,
    is_running: Arc<AtomicBool>,
    frame_tx: mpsc::SyncSender<PortalFrame>,
    stop_rx: pw_channel::Receiver<()>,
    init_tx: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    pipewire::init();

    let main_loop = MainLoopRc::new(None).map_err(|e| e.to_string())?;
    let context = ContextRc::new(&main_loop, None).map_err(|e| e.to_string())?;
    let core = match pw_fd {
        Some(fd) => context
            .connect_fd_rc(fd, None)
            .or_else(|_| context.connect_rc(None))
            .map_err(|e| e.to_string())?,
        None => context.connect_rc(None).map_err(|e| e.to_string())?,
    };

    let stream = StreamRc::new(
        core,
        "Snapshot ScreenCast",
        properties::properties! {
            *MEDIA_TYPE => "Video",
            *MEDIA_CATEGORY => "Capture",
            *MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| e.to_string())?;

    let _listener = stream
        .add_local_listener_with_user_data(StreamState::default())
        .param_changed(|_, state, id, param| {
            let Some(param) = param else { return };
            if id != ParamType::Format.as_raw() {
                return;
            }
            if let Ok((MediaType::Video, MediaSubtype::Raw)) = format_utils::parse_format(param) {
                let _ = state.format.parse(param);
            }
        })
        .process(move |stream, state| {
            if !is_running.load(Ordering::Relaxed) {
                return;
            }
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let size = state.format.size();
            if size.width == 0 || size.height == 0 {
                return;
            }
            let stride = datas[0].chunk().stride().max(0) as usize;
            let offset = datas[0].chunk().offset() as usize;
            let Some(raw_slice) = datas[0].data() else {
                return;
            };
            if offset >= raw_slice.len() {
                return;
            }
            if let Some(rgba) = pixel_bytes_to_rgba(
                state.format.format(),
                &raw_slice[offset..],
                size.width,
                size.height,
                stride,
            ) {
                let _ = frame_tx.try_send(PortalFrame {
                    width: size.width,
                    height: size.height,
                    raw: rgba,
                });
            }
        })
        .register()
        .map_err(|e| e.to_string())?;

    let values = build_video_format_pod()?;
    let mut params =
        [Pod::from_bytes(&values).ok_or_else(|| "无法构造 PipeWire 格式参数".to_string())?];

    stream
        .connect(
            Direction::Input,
            Some(stream_id),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| e.to_string())?;

    let loop_ref = main_loop.clone();
    let stream_ref = stream.clone();
    let _attached = stop_rx.attach(main_loop.loop_(), move |()| {
        let _ = stream_ref.set_active(false);
        let _ = stream_ref.disconnect();
        loop_ref.quit();
    });

    let _ = init_tx.send(Ok(()));
    main_loop.run();
    Ok(())
}

/// 构造 PipeWire 视频格式协商 Pod。
/// 注意 `pod::property!(..., Choice, Enum, Id, default, alt1, alt2, ...)` 第一个值是 `default`，
/// 后续才是 `spa_pod_filter` 校验的候选列表，因此 `BGRx` 必须同时出现在默认项与候选列表中。
fn build_video_format_pod() -> Result<Vec<u8>, String> {
    let obj = pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA,
            VideoFormat::RGB
        ),
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 1920,
                height: 1080
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 30, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    Ok(
        PodSerializer::serialize(Cursor::new(Vec::new()), &pod::Value::Object(obj))
            .map_err(|e| e.to_string())?
            .0
            .into_inner(),
    )
}

/// 按行跨度（stride）把 PipeWire 帧转换成紧凑 RGBA 字节流，避免非对齐窗口宽度产生斜向错位。
fn pixel_bytes_to_rgba(
    format: VideoFormat,
    data: &[u8],
    width: u32,
    height: u32,
    stride: usize,
) -> Option<Vec<u8>> {
    let w = width as usize;
    let h = height as usize;
    let bpp = match format {
        VideoFormat::RGBA | VideoFormat::RGBx | VideoFormat::BGRx | VideoFormat::BGRA => 4,
        VideoFormat::RGB => 3,
        _ => return None,
    };
    let row_bytes = w.checked_mul(bpp)?;
    let actual_stride = if stride >= row_bytes {
        stride
    } else {
        row_bytes
    };
    let required = actual_stride
        .checked_mul(h.saturating_sub(1))?
        .checked_add(row_bytes)?;
    if data.len() < required {
        return None;
    }

    let mut out = vec![0u8; w.checked_mul(h)?.checked_mul(4)?];
    for y in 0..h {
        let src_row = &data[y * actual_stride..y * actual_stride + row_bytes];
        let dst_row = &mut out[y * w * 4..(y + 1) * w * 4];
        match format {
            VideoFormat::RGBA => dst_row.copy_from_slice(src_row),
            VideoFormat::RGBx => {
                dst_row.copy_from_slice(src_row);
                for px in dst_row.as_chunks_mut::<4>().0 {
                    px[3] = 255;
                }
            }
            VideoFormat::BGRA => {
                for (src, dst) in src_row
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(dst_row.as_chunks_mut::<4>().0)
                {
                    dst[0] = src[2];
                    dst[1] = src[1];
                    dst[2] = src[0];
                    dst[3] = src[3];
                }
            }
            VideoFormat::BGRx => {
                for (src, dst) in src_row
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(dst_row.as_chunks_mut::<4>().0)
                {
                    dst[0] = src[2];
                    dst[1] = src[1];
                    dst[2] = src[0];
                    dst[3] = 255;
                }
            }
            VideoFormat::RGB => {
                for (src, dst) in src_row
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .zip(dst_row.as_chunks_mut::<4>().0)
                {
                    dst[0] = src[0];
                    dst[1] = src[1];
                    dst[2] = src[2];
                    dst[3] = 255;
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipewire::spa::{
        pod::{deserialize::PodDeserializer, ChoiceValue},
        utils::ChoiceEnum,
    };

    #[test]
    fn source_types_requests_both_monitor_and_window_when_supported() {
        assert_eq!(choose_source_types(0), SOURCE_MONITOR | SOURCE_WINDOW);
        assert_eq!(choose_source_types(7), SOURCE_MONITOR | SOURCE_WINDOW);
        assert_eq!(choose_source_types(SOURCE_MONITOR), SOURCE_MONITOR);
    }

    #[test]
    fn cursor_mode_follows_include_cursor_and_falls_back_to_supported_bit() {
        assert_eq!(choose_cursor_mode(true, 0), Some(CURSOR_EMBEDDED));
        assert_eq!(choose_cursor_mode(false, 0), Some(CURSOR_HIDDEN));
        assert_eq!(
            choose_cursor_mode(true, CURSOR_HIDDEN | CURSOR_EMBEDDED),
            Some(CURSOR_EMBEDDED)
        );
        assert_eq!(
            choose_cursor_mode(false, CURSOR_HIDDEN | CURSOR_EMBEDDED),
            Some(CURSOR_HIDDEN)
        );
        // 门户只支持 Embedded 时回退到可用位，避免因参数不被接受而整次录制失败
        assert_eq!(
            choose_cursor_mode(false, CURSOR_EMBEDDED),
            Some(CURSOR_EMBEDDED)
        );
    }

    #[test]
    fn video_format_pod_includes_bgrx_in_enum_alternatives() {
        let bytes = build_video_format_pod().expect("pod bytes");
        let (_, value) = PodDeserializer::deserialize_any_from(&bytes).expect("valid pod");
        let pod::Value::Object(obj) = value else {
            panic!("expected Object pod");
        };
        let fmt_prop = obj
            .properties
            .iter()
            .find(|prop| prop.key == FormatProperties::VideoFormat.as_raw())
            .expect("VideoFormat property");
        let pod::Value::Choice(ChoiceValue::Id(choice)) = &fmt_prop.value else {
            panic!("expected ChoiceValue::Id");
        };
        let ChoiceEnum::Enum {
            default,
            alternatives,
        } = &choice.1
        else {
            panic!("expected ChoiceEnum::Enum");
        };
        assert_eq!(default.0, VideoFormat::BGRx.as_raw());
        let raw_alts: Vec<u32> = alternatives.iter().map(|id| id.0).collect();
        for expected in [
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA,
            VideoFormat::RGB,
        ] {
            assert!(
                raw_alts.contains(&expected.as_raw()),
                "missing format {:?} in {:?}",
                expected,
                raw_alts
            );
        }
    }

    #[test]
    fn pixel_conversion_respects_padded_pipewire_row_stride() {
        // 2×2 BGRx，每行填充到 12 字节 stride
        let padded = [
            10, 20, 30, 0, 40, 50, 60, 0, 99, 99, 99, 99, // row 0 + 4B pad
            70, 80, 90, 0, 11, 22, 33, 0, 88, 88, 88, 88, // row 1 + 4B pad
        ];
        let rgba = pixel_bytes_to_rgba(VideoFormat::BGRx, &padded, 2, 2, 12).expect("rgba");
        assert_eq!(
            rgba,
            vec![
                30, 20, 10, 255, 60, 50, 40, 255, // row 0
                90, 80, 70, 255, 33, 22, 11, 255, // row 1
            ]
        );
    }
}
