//! 压缩包根目录的可选 `pet.json`：每个 GIF/WebM 动作的脚底锚点，和整包共用的基准画布。
//!
//! 没有这份文件的包跟以前一样，整张媒体缩进同一个方窗。格式见 README。

use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetLayout {
    pub(crate) base_width: u32,
    pub(crate) base_height: u32,
    pub(crate) anchor_x: f64,
    pub(crate) anchor_y: f64,
    pub(crate) frames: Vec<PetFrame>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetFrame {
    pub(crate) entry: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) anchor_x: f64,
    pub(crate) anchor_y: f64,
}

#[derive(Deserialize)]
struct ManifestFile {
    version: u32,
    base: ManifestBase,
    #[serde(default)]
    animations: HashMap<String, ManifestAnimation>,
    #[serde(default)]
    events: HashMap<String, String>,
    #[serde(default)]
    states: HashMap<String, String>,
}

#[derive(Debug)]
pub(crate) struct PetManifest {
    pub(crate) layout: PetLayout,
    pub(crate) event_actions: HashMap<String, String>,
    pub(crate) state_actions: HashMap<String, String>,
}

#[derive(Deserialize)]
struct ManifestBase {
    width: f64,
    height: f64,
    anchor: [f64; 2],
}

#[derive(Deserialize)]
struct ManifestAnimation {
    anchor: [f64; 2],
}

/// GIF 逻辑画面的宽高。只看文件头，不解码。
pub(crate) fn gif_screen_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 10 || (&bytes[0..6] != b"GIF87a" && &bytes[0..6] != b"GIF89a") {
        return None;
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
    let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
    if width == 0 || height == 0 {
        None
    } else {
        Some((width, height))
    }
}

fn zip_path(name: &str) -> String {
    name.replace('\\', "/")
}

fn is_manifest(name: &str) -> bool {
    zip_path(name)
        .rsplit('/')
        .next()
        .unwrap_or(name)
        .eq_ignore_ascii_case("pet.json")
}

fn finite_anchor(anchor: [f64; 2]) -> Result<(f64, f64), String> {
    if !anchor[0].is_finite()
        || !anchor[1].is_finite()
        || anchor[0].abs() > 100_000.0
        || anchor[1].abs() > 100_000.0
    {
        return Err("锚点要是有限的数字".into());
    }
    Ok((anchor[0], anchor[1]))
}

fn canvas_size(value: f64) -> Result<u32, String> {
    if value.is_finite() && value >= 1.0 && value <= u16::MAX as f64 && value.fract() == 0.0 {
        Ok(value as u32)
    } else {
        Err("基准画布的宽高要是 1 到 65535 的整数".into())
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<ManifestFile, String> {
    if bytes.len() > 1024 * 1024 {
        return Err("pet.json 不能超过 1MB".into());
    }
    let manifest: ManifestFile =
        serde_json::from_slice(bytes).map_err(|_| "pet.json 解析不了".to_string())?;
    if manifest.version != 1 {
        return Err("pet.json 的 version 只支持 1".into());
    }
    Ok(manifest)
}

/// 读压缩包里的 `pet.json`。没有这份文件就是 Ok(None)，有但写错了则导入失败。
pub(crate) fn read_pet_layout(
    path: &Path,
    animations: &[String],
) -> Result<Option<PetManifest>, String> {
    let file = fs::File::open(path).map_err(|_| "无法读取桌宠压缩包".to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "桌宠压缩包已损坏".to_string())?;
    let mut manifests = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "无法读取桌宠压缩包目录".to_string())?;
        let entry_name = entry
            .name()
            .map_err(|_| "无法读取桌宠压缩包条目名".to_string())?;
        if entry.is_dir() || !is_manifest(&entry_name) {
            continue;
        }
        manifests.push(entry_name.into_owned());
    }
    manifests.sort_by_key(|name| {
        (
            zip_path(name).bytes().filter(|byte| *byte == b'/').count(),
            name.len(),
        )
    });
    let Some(manifest_name) = manifests.into_iter().next() else {
        return Ok(None);
    };

    let mut manifest_bytes = Vec::new();
    {
        let mut entry = archive
            .by_name(&manifest_name)
            .map_err(|_| "pet.json 读不出来".to_string())?;
        if entry.size() > 1024 * 1024 {
            return Err("pet.json 不能超过 1MB".into());
        }
        entry
            .by_ref()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut manifest_bytes)
            .map_err(|_| "pet.json 读不出来".to_string())?;
    }
    let manifest = parse_manifest(&manifest_bytes)?;
    let (anchor_x, anchor_y) = finite_anchor(manifest.base.anchor)?;
    let base_width = canvas_size(manifest.base.width)?;
    let base_height = canvas_size(manifest.base.height)?;

    // 键按压缩包里的路径对，反斜杠和正斜杠算同一个
    let mut by_entry = HashMap::new();
    for (name, animation) in manifest.animations {
        by_entry.insert(zip_path(&name), animation);
    }

    let mut frames = Vec::new();
    for entry in animations {
        let Some(animation) = by_entry.get(&zip_path(entry)) else {
            continue;
        };
        let (anchor_x, anchor_y) =
            finite_anchor(animation.anchor).map_err(|error| format!("{entry} 的{error}"))?;
        let webm = entry
            .rsplit('.')
            .next()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("webm"));
        // WebM 尺寸不在这里解 EBML：pet.json 的 base 就是所有动作共用的逻辑画布，
        // 作者可按该画布定锚点。GIF 仍读文件头，兼容旧素材。
        let (width, height) = if webm {
            (base_width, base_height)
        } else {
            let mut header = [0u8; 10];
            let mut gif = archive
                .by_name(entry)
                .map_err(|_| format!("压缩包里没有 {entry}"))?;
            gif.read_exact(&mut header)
                .map_err(|_| format!("{entry} 不是有效的 GIF"))?;
            gif_screen_size(&header).ok_or_else(|| format!("{entry} 不是有效的 GIF"))?
        };
        frames.push(PetFrame {
            entry: entry.clone(),
            width,
            height,
            anchor_x,
            anchor_y,
        });
    }

    let known_events = [
        "capture.success",
        "capture.failure",
        "recording.started",
        "recording.stopped",
        "recording.failure",
        "polish.success",
        "polish.failure",
        "shortcuts.paused",
        "shortcuts.resumed",
    ];
    let mut event_actions = HashMap::new();
    for (event, entry) in manifest.events {
        if !known_events.contains(&event.as_str()) {
            return Err(format!("pet.json 里有不支持的事件：{event}"));
        }
        if !animations
            .iter()
            .any(|candidate| zip_path(candidate) == zip_path(&entry))
        {
            return Err(format!("事件 {event} 指向的动画不存在：{entry}"));
        }
        event_actions.insert(event, entry);
    }
    let mut state_actions = HashMap::new();
    for (state, entry) in manifest.states {
        if !["recording", "shortcuts-paused"].contains(&state.as_str()) {
            return Err(format!("pet.json 里有不支持的持续状态：{state}"));
        }
        if !animations
            .iter()
            .any(|candidate| zip_path(candidate) == zip_path(&entry))
        {
            return Err(format!("持续状态 {state} 指向的动画不存在：{entry}"));
        }
        state_actions.insert(state, entry);
    }

    Ok(Some(PetManifest {
        layout: PetLayout {
            base_width,
            base_height,
            anchor_x,
            anchor_y,
            frames,
        },
        event_actions,
        state_actions,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gif_bytes(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0x3B]);
        bytes
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "snapshot-pet-layout-{}-{}.zip",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let file = fs::File::create(&path).expect("建测试包失败");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("写入条目失败");
            writer.write_all(bytes).expect("写入内容失败");
        }
        writer.finish().expect("收尾失败");
        path
    }

    #[test]
    fn gif_header_carries_the_canvas_size() {
        assert_eq!(gif_screen_size(&gif_bytes(320, 180)), Some((320, 180)));
        assert_eq!(gif_screen_size(b"GIF87a"), None);
        assert_eq!(gif_screen_size(b"not a gif!!"), None);
        assert_eq!(gif_screen_size(&gif_bytes(0, 10)), None);
    }

    #[test]
    fn a_zip_without_pet_json_has_no_layout() {
        let path = zip_with(&[("idle.gif", &gif_bytes(40, 40))]);
        let manifest = read_pet_layout(&path, &["idle.gif".into()]).expect("应当能读");
        assert!(manifest.is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pet_json_records_the_base_and_each_gif_anchor() {
        let manifest = br#"{
            "version": 1,
            "base": { "width": 100, "height": 100, "anchor": [50, 90] },
            "events": { "capture.success": "drive-dunk.gif" },
            "states": { "recording": "drive-dunk.gif" },
            "animations": {
                "idle.gif": { "anchor": [50, 90] },
                "drive-dunk.gif": { "anchor": [80, 240] },
                "missing.gif": { "anchor": [1, 1] }
            }
        }"#;
        let path = zip_with(&[
            ("notes.txt", b"skip"),
            ("pet.json", manifest),
            ("idle.gif", &gif_bytes(100, 100)),
            ("drive-dunk.gif", &gif_bytes(220, 260)),
        ]);
        let manifest = read_pet_layout(
            &path,
            &[
                "idle.gif".into(),
                "drive-dunk.gif".into(),
                "wave.gif".into(),
            ],
        )
        .expect("应当能读")
        .expect("有 pet.json 就该有布局");
        let layout = manifest.layout;
        assert_eq!(manifest.event_actions["capture.success"], "drive-dunk.gif");
        assert_eq!(manifest.state_actions["recording"], "drive-dunk.gif");
        assert_eq!(layout.base_width, 100);
        assert_eq!(layout.base_height, 100);
        assert_eq!(layout.anchor_x, 50.0);
        assert_eq!(layout.anchor_y, 90.0);
        assert_eq!(
            layout.frames,
            vec![
                PetFrame {
                    entry: "idle.gif".into(),
                    width: 100,
                    height: 100,
                    anchor_x: 50.0,
                    anchor_y: 90.0,
                },
                PetFrame {
                    entry: "drive-dunk.gif".into(),
                    width: 220,
                    height: 260,
                    anchor_x: 80.0,
                    anchor_y: 240.0,
                },
            ]
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn webm_manifest_uses_the_shared_base_canvas() {
        let manifest = br#"{
            "version": 1,
            "base": { "width": 640, "height": 360, "anchor": [320, 350] },
            "animations": {
                "idle.webm": { "anchor": [320, 350] }
            }
        }"#;
        let path = zip_with(&[("pet.json", manifest), ("idle.webm", b"fake-webm")]);
        let parsed = read_pet_layout(&path, &["idle.webm".into()])
            .expect("应当能读")
            .expect("有 pet.json 就该有布局");
        assert_eq!(parsed.layout.frames.len(), 1);
        assert_eq!(parsed.layout.frames[0].width, 640);
        assert_eq!(parsed.layout.frames[0].height, 360);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_broken_pet_json_rejects_the_import() {
        let path = zip_with(&[("pet.json", b"{not json"), ("idle.gif", &gif_bytes(10, 10))]);
        assert!(read_pet_layout(&path, &["idle.gif".into()]).is_err());
        let _ = fs::remove_file(&path);

        let path = zip_with(&[(
            "pet.json",
            br#"{"version":2,"base":{"width":10,"height":10,"anchor":[1,1]},"animations":{}}"#,
        )]);
        let error = read_pet_layout(&path, &[]).expect_err("只支持 version 1");
        assert!(error.contains("version"), "{error}");
        let _ = fs::remove_file(&path);

        let path = zip_with(&[(
            "pet.json",
            br#"{"version":1,"base":{"width":0,"height":10,"anchor":[1,1]},"animations":{}}"#,
        )]);
        assert!(read_pet_layout(&path, &[]).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_listed_gif_with_a_bad_header_is_an_error() {
        let path = zip_with(&[
            (
                "pet.json",
                br#"{"version":1,"base":{"width":10,"height":10,"anchor":[1,1]},"animations":{"idle.gif":{"anchor":[1,2]}}}"#,
            ),
            ("idle.gif", b"not-a-gif-header!!"),
        ]);
        assert!(read_pet_layout(&path, &["idle.gif".into()]).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn event_actions_must_name_known_events_and_existing_animations() {
        let base = r#""version":1,"base":{"width":10,"height":10,"anchor":[1,1]}"#;
        let valid = format!(r#"{{{base},"events":{{"capture.success":"effects/capture.gif"}}}}"#);
        let path = zip_with(&[
            ("pet.json", valid.as_bytes()),
            ("effects/capture.gif", &gif_bytes(10, 10)),
        ]);
        let manifest = read_pet_layout(&path, &["effects/capture.gif".into()])
            .expect("有效事件映射应通过")
            .expect("应读到清单");
        assert_eq!(
            manifest.event_actions["capture.success"],
            "effects/capture.gif"
        );
        let _ = fs::remove_file(&path);

        let missing = format!(r#"{{{base},"events":{{"capture.success":"missing.gif"}}}}"#);
        let path = zip_with(&[("pet.json", missing.as_bytes())]);
        assert!(read_pet_layout(&path, &["idle.gif".into()]).is_err());
        let _ = fs::remove_file(&path);

        let unknown = format!(r#"{{{base},"events":{{"capture.succeeded":"idle.gif"}}}}"#);
        let path = zip_with(&[("pet.json", unknown.as_bytes())]);
        assert!(read_pet_layout(&path, &["idle.gif".into()]).is_err());
        let _ = fs::remove_file(&path);
    }
}
