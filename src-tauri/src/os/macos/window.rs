//! 无感窗口截图：ScreenCaptureKit 经现有 Swift sidecar 采集，不激活或还原目标窗口。

use super::recorder::recorder_program;
use image::{ImageFormat, RgbaImage};
use serde::Deserialize;
use std::{
    io::Read,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const CAPTURE_TIMEOUT: &str = "无感窗口采集超时，请检查屏幕录制权限或先还原最小化窗口";
const INVALID_RESPONSE: &str = "无感窗口采集组件返回了无效图像";
const MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureMetadata {
    app_name: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListedWindow {
    pub(crate) id: u32,
    pub(crate) pid: u32,
    pub(crate) app_name: String,
    pub(crate) title: String,
    pub(crate) area: u64,
}

/// 与截图使用同一份 ScreenCaptureKit 窗口列表，包括台前调度侧栏、其它空间的窗口。
pub(crate) fn list_windows() -> Result<Vec<ListedWindow>, String> {
    let mut command = Command::new(recorder_program());
    command.arg("--list-windows");
    let output = run_helper(command, Duration::from_secs(15))?;
    decode_window_list_output(output)
}

fn decode_window_list_output(output: Output) -> Result<Vec<ListedWindow>, String> {
    check_helper_status(&output)?;
    serde_json::from_slice(&output.stdout).map_err(|_| "无感窗口采集组件返回了无效窗口列表".into())
}

pub(crate) fn capture_window_image(
    id: u32,
    include_cursor: bool,
) -> Result<(RgbaImage, String), String> {
    let mut command = Command::new(recorder_program());
    command
        .arg("--screenshot")
        .arg("--window-id")
        .arg(id.to_string());
    if include_cursor {
        command.arg("--include-cursor");
    }
    let output = run_helper(command, Duration::from_secs(15))?;
    decode_capture_output(output)
}

fn run_helper(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动无感窗口采集组件：{error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // PNG 可能超过管道容量，必须在等退出的同时排空；两路输出都有内存上限。
    let stdout = thread::spawn(move || read_bounded(stdout, MAX_OUTPUT_BYTES));
    let stderr = thread::spawn(move || read_bounded(stderr, 64 * 1024));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(match result {
                    Err(error) => format!("等待无感窗口采集失败：{error}"),
                    _ => CAPTURE_TIMEOUT.into(),
                });
            }
        }
    };
    let stdout = stdout.join().map_err(|_| INVALID_RESPONSE.to_string())?;
    let stderr = stderr.join().map_err(|_| INVALID_RESPONSE.to_string())?;
    Ok(Output {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取无感窗口采集结果失败：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(INVALID_RESPONSE.into());
    }
    Ok(bytes)
}

fn check_helper_status(output: &Output) -> Result<(), String> {
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(message) = stdout.lines().find_map(|line| line.strip_prefix("ERROR ")) {
            return Err(message.to_string());
        }
        return Err("无感窗口采集失败，请检查屏幕录制权限后重试".into());
    }
    Ok(())
}

fn decode_capture_output(output: Output) -> Result<(RgbaImage, String), String> {
    check_helper_status(&output)?;
    let newline = output
        .stdout
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or(INVALID_RESPONSE)?;
    let metadata: CaptureMetadata =
        serde_json::from_slice(&output.stdout[..newline]).map_err(|_| INVALID_RESPONSE)?;
    if metadata.width == 0
        || metadata.height == 0
        || metadata.width > 16_384
        || metadata.height > 16_384
        || u64::from(metadata.width) * u64::from(metadata.height) > 100_000_000
    {
        return Err(INVALID_RESPONSE.into());
    }
    let image =
        image::load_from_memory_with_format(&output.stdout[newline + 1..], ImageFormat::Png)
            .map_err(|_| INVALID_RESPONSE)?
            .to_rgba8();
    if image.dimensions() != (metadata.width, metadata.height)
        || !image.pixels().any(|pixel| pixel.0[3] > 0)
    {
        // 全透明结果不是成功截图；纯黑但不透明的正常窗口则允许保存。
        return Err(INVALID_RESPONSE.into());
    }
    Ok((image, metadata.app_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::{io::Cursor, os::unix::process::ExitStatusExt, process::ExitStatus};

    fn output(image: RgbaImage, width: u32, height: u32) -> Output {
        let mut stdout = serde_json::to_vec(&serde_json::json!({
            "appName": "Code\n测试", "width": width, "height": height,
        }))
        .unwrap();
        stdout.push(b'\n');
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, ImageFormat::Png).unwrap();
        stdout.extend(png.into_inner());
        Output {
            status: ExitStatus::from_raw(0),
            stdout,
            stderr: Vec::new(),
        }
    }

    #[test]
    fn background_window_list_preserves_native_identifiers_and_metadata() {
        let output = Output {
            status: ExitStatus::from_raw(0),
            stdout: serde_json::to_vec(&serde_json::json!([{
                "id": 7046, "pid": 59230, "appName": "Code",
                "title": "测试\n— experiment5", "area": 23_345,
            }]))
            .unwrap(),
            stderr: Vec::new(),
        };
        let windows = decode_window_list_output(output).unwrap();
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!((window.id, window.pid, window.area), (7046, 59230, 23_345));
        assert_eq!(window.app_name, "Code");
        assert_eq!(window.title, "测试\n— experiment5");
    }

    #[test]
    fn empty_window_lists_are_valid_but_errors_and_invalid_lists_are_not_empty_successes() {
        let output = |success, stdout: &[u8]| Output {
            status: ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        };
        assert!(decode_window_list_output(output(true, b"[]"))
            .unwrap()
            .is_empty());
        for invalid in [b"".as_slice(), b"{}", b"[{}]", b"[", b"ERROR failed\n"] {
            assert!(decode_window_list_output(output(true, invalid)).is_err());
        }
        assert_eq!(
            decode_window_list_output(output(false, "ERROR 需要屏幕录制权限\n".as_bytes()))
                .unwrap_err(),
            "需要屏幕录制权限"
        );
    }

    #[test]
    fn png_and_metadata_round_trip_without_temporary_files() {
        let image = RgbaImage::from_pixel(12, 8, Rgba([7, 11, 23, 255]));
        let (decoded, name) = decode_capture_output(output(image.clone(), 12, 8)).unwrap();
        assert_eq!(image, decoded);
        assert_eq!(name, "Code\n测试");
    }

    #[test]
    fn transparent_captures_are_errors_but_opaque_black_windows_are_valid() {
        for (alpha, valid) in [(0, false), (255, true)] {
            let image = RgbaImage::from_pixel(4, 3, Rgba([0, 0, 0, alpha]));
            assert_eq!(decode_capture_output(output(image, 4, 3)).is_ok(), valid);
        }
    }

    #[test]
    fn incomplete_and_mismatched_responses_are_not_successful_captures() {
        let image = RgbaImage::from_pixel(4, 3, Rgba([0, 0, 0, 255]));
        for (width, height) in [(0, 3), (5, 3), (20_000, 3), (16_384, 16_384)] {
            assert!(decode_capture_output(output(image.clone(), width, height)).is_err());
        }
        let mut bad = output(image, 4, 3);
        bad.stdout.truncate(8);
        assert!(decode_capture_output(bad).is_err());
    }

    #[test]
    fn actionable_sidecar_errors_are_preserved() {
        let result = decode_capture_output(Output {
            status: ExitStatus::from_raw(256),
            stdout: "ERROR 目标窗口已经关闭\n".as_bytes().to_vec(),
            stderr: Vec::new(),
        });
        assert_eq!(result.unwrap_err(), "目标窗口已经关闭");
    }

    #[test]
    fn helper_pipes_are_drained_while_waiting_for_exit() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "head -c 200000 /dev/zero; head -c 60000 /dev/zero >&2",
        ]);
        let output = run_helper(command, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 200_000);
        assert_eq!(output.stderr.len(), 60_000);
    }

    #[test]
    fn stalled_helpers_are_killed_and_reaped_without_activating_any_window() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 20"]);
        let start = Instant::now();
        assert_eq!(
            run_helper(command, Duration::from_millis(40)).unwrap_err(),
            CAPTURE_TIMEOUT
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn helper_output_is_bounded() {
        assert_eq!(read_bounded(Cursor::new(b"12345"), 5).unwrap(), b"12345");
        assert!(read_bounded(Cursor::new(b"123456"), 5).is_err());
    }
}
