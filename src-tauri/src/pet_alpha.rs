//! WebKit decodes WebM colour but ignores its BlockAdditional alpha plane.
//! Remux that plane into an ordinary, full-range grayscale WebM. The page can
//! combine two native video decoders without chroma-keying away dark details,
//! transcoding the pet, or requiring an external FFmpeg installation.

const SEGMENT: u32 = 0x1853_8067;
const TRACKS: u32 = 0x1654_AE6B;
const CLUSTER: u32 = 0x1F43_B675;

#[derive(Clone, Copy)]
struct Element<'a> {
    id: u32,
    raw: &'a [u8],
    data: &'a [u8],
}

fn vint(bytes: &[u8], keep_marker: bool) -> Result<(u64, usize), String> {
    let first = *bytes.first().ok_or("Incomplete WebM integer")?;
    let length = first.leading_zeros() as usize + 1;
    if length > 8 || bytes.len() < length {
        return Err("Invalid WebM integer".into());
    }
    let mut value = u64::from(if keep_marker {
        first
    } else {
        first & (0xffu16 >> length) as u8
    });
    for &byte in &bytes[1..length] {
        value = (value << 8) | u64::from(byte);
    }
    Ok((value, length))
}

fn elements(mut bytes: &[u8]) -> Result<Vec<Element<'_>>, String> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        if result.len() >= 100_000 {
            return Err("Too many WebM elements".into());
        }
        let (id, id_len) = vint(bytes, true)?;
        if id_len > 4 {
            return Err("Invalid WebM element ID".into());
        }
        let (size, size_len) = vint(&bytes[id_len..], false)?;
        let header = id_len + size_len;
        let unknown = size == (1u64 << (7 * size_len)) - 1;
        let size = if unknown && id == u64::from(SEGMENT) {
            bytes.len() - header
        } else if unknown {
            return Err("Unknown-sized WebM child element".into());
        } else {
            usize::try_from(size).map_err(|_| "WebM element is too large")?
        };
        let end = header
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .ok_or("Truncated WebM element")?;
        result.push(Element {
            id: id as u32,
            raw: &bytes[..end],
            data: &bytes[header..end],
        });
        bytes = &bytes[end..];
    }
    Ok(result)
}

fn uint(bytes: &[u8]) -> Result<u64, String> {
    if bytes.is_empty() || bytes.len() > 8 {
        return Err("Invalid WebM unsigned integer".into());
    }
    Ok(bytes.iter().fold(0, |n, &byte| (n << 8) | u64::from(byte)))
}

fn append(output: &mut Vec<u8>, id: u32, data: &[u8]) {
    let id_bytes = id.to_be_bytes();
    let start = id_bytes.iter().position(|&byte| byte != 0).unwrap_or(3);
    output.extend_from_slice(&id_bytes[start..]);
    let length = (1..=8)
        .find(|length| (data.len() as u64) < (1u64 << (7 * length)) - 1)
        .unwrap_or(8);
    let size = (data.len() as u64 | (1u64 << (7 * length))).to_be_bytes();
    output.extend_from_slice(&size[8 - length..]);
    output.extend_from_slice(data);
}

fn alpha_track(tracks: Element<'_>) -> Result<(u64, Vec<u8>, bool), String> {
    for entry in elements(tracks.data)?.into_iter().filter(|e| e.id == 0xAE) {
        let fields = elements(entry.data)?;
        let number = fields
            .iter()
            .find(|e| e.id == 0xD7)
            .ok_or("Missing WebM track number")?;
        let codec = fields.iter().find(|e| e.id == 0x86);
        if !codec.is_some_and(|e| e.data == b"V_VP9" || e.data == b"V_VP8") {
            continue;
        }
        let Some(video) = fields.iter().find(|e| e.id == 0xE0) else {
            continue;
        };
        let video_fields = elements(video.data)?;
        if !video_fields
            .iter()
            .any(|e| e.id == 0x53C0 && uint(e.data).ok() == Some(1))
        {
            continue;
        }
        let mut video_data = Vec::new();
        for field in video_fields {
            // Alpha is an independent grayscale picture, not an alpha-enabled
            // video. Full range prevents YUV conversion from clipping its edges.
            if !matches!(field.id, 0x53C0 | 0x55B0 | 0xBF) {
                video_data.extend_from_slice(field.raw);
            }
        }
        let mut colour = Vec::new();
        append(&mut colour, 0x55B9, &[2]);
        append(&mut video_data, 0x55B0, &colour);
        let mut track_data = Vec::new();
        for field in &fields {
            if field.id == 0xE0 {
                append(&mut track_data, 0xE0, &video_data);
            } else if !matches!(field.id, 0xBF | 0x6D80) {
                track_data.extend_from_slice(field.raw);
            }
        }
        let mut track = Vec::new();
        append(&mut track, 0xAE, &track_data);
        return Ok((
            uint(number.data)?,
            track,
            codec.is_some_and(|e| e.data == b"V_VP9"),
        ));
    }
    Err("This WebM has no VP8/VP9 alpha track".into())
}

fn alpha_block(group: Element<'_>, track: u64, vp9: bool) -> Result<Option<Vec<u8>>, String> {
    let fields = elements(group.data)?;
    let Some(block) = fields.iter().find(|e| e.id == 0xA1) else {
        return Ok(None);
    };
    let (number, number_len) = vint(block.data, false)?;
    if number != track {
        return Ok(None);
    }
    let header = number_len + 3;
    if block.data.len() < header || block.data[header - 1] & 0x06 != 0 {
        return Err("Laced or incomplete WebM alpha block".into());
    }
    let additions = fields
        .iter()
        .find(|e| e.id == 0x75A1)
        .ok_or("Missing WebM alpha data")?;
    let mut alpha = None;
    for more in elements(additions.data)?
        .into_iter()
        .filter(|e| e.id == 0xA6)
    {
        let additions = elements(more.data)?;
        let id = additions
            .iter()
            .find(|e| e.id == 0xEE)
            .map(|e| uint(e.data))
            .transpose()?
            .unwrap_or(1);
        if id == 1 {
            alpha = additions.iter().find(|e| e.id == 0xA5).map(|e| e.data);
        }
    }
    let alpha = alpha
        .filter(|data| !data.is_empty())
        .ok_or("Missing WebM alpha frame")?;
    let mut frame = block.data[..header].to_vec();
    frame.extend_from_slice(alpha);
    // The alpha codec stores literal 0..255 opacity in Y, but libvpx's VP9
    // profile-0 keyframe header can still mark it as limited-range video.
    // Native decoders prioritize that bit over the container's Colour/Range.
    // Only change the keyframe's range flag, never its compressed pixel data.
    if vp9 && alpha.len() >= 5 && alpha[0] & 0xfc == 0x80 && alpha[1..4] == [0x49, 0x83, 0x42] {
        frame[header + 4] |= 0x10;
    }
    let mut output = Vec::new();
    for field in fields {
        if field.id == 0xA1 {
            append(&mut output, 0xA1, &frame);
        } else if !matches!(field.id, 0x75A1 | 0xBF | 0xA4 | 0xFA | 0xFD) {
            output.extend_from_slice(field.raw);
        }
    }
    Ok(Some(output))
}

pub(crate) fn extract(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("WebM exceeds the pet media limit".into());
    }
    let root = elements(bytes)?;
    let header = root
        .iter()
        .find(|e| e.id == 0x1A45_DFA3)
        .ok_or("Missing EBML header")?;
    let segment = root
        .iter()
        .find(|e| e.id == SEGMENT)
        .ok_or("Missing WebM segment")?;
    let children = elements(segment.data)?;
    let tracks = children
        .iter()
        .find(|e| e.id == TRACKS)
        .ok_or("Missing WebM tracks")?;
    let (track, track_data, vp9) = alpha_track(*tracks)?;
    let mut body = Vec::new();
    let mut frames = 0;
    for element in children {
        match element.id {
            0x1549_A966 => body.extend_from_slice(element.raw), // TimecodeScale and Duration
            TRACKS => append(&mut body, TRACKS, &track_data),
            CLUSTER => {
                let mut cluster = Vec::new();
                for field in elements(element.data)? {
                    match field.id {
                        0xE7 => cluster.extend_from_slice(field.raw), // original timestamp
                        0xA0 => {
                            if let Some(block) = alpha_block(field, track, vp9)? {
                                append(&mut cluster, 0xA0, &block);
                                frames += 1;
                            }
                        }
                        _ => {} // old offsets, checksums and colour-only blocks do not apply
                    }
                }
                append(&mut body, CLUSTER, &cluster);
            }
            _ => {} // SeekHead/Cues contain obsolete byte offsets; sequential playback needs neither
        }
    }
    if frames == 0 {
        return Err("WebM has no alpha frames".into());
    }
    let mut output = header.raw.to_vec();
    append(&mut output, SEGMENT, &body);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(id: u32, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        append(&mut out, id, bytes);
        out
    }

    fn fixture() -> Vec<u8> {
        let video = [wrap(0xB0, &[2]), wrap(0xBA, &[2]), wrap(0x53C0, &[1])].concat();
        let track = [
            wrap(0xD7, &[1]),
            wrap(0x83, &[1]),
            wrap(0x86, b"V_VP9"),
            wrap(0xE0, &video),
        ]
        .concat();
        let additions = wrap(
            0xA6,
            &[wrap(0xEE, &[1]), wrap(0xA5, b"alpha-frame")].concat(),
        );
        let block = [
            wrap(0xA1, b"\x81\x00\x2a\x00colour-frame"),
            wrap(0x75A1, &additions),
            wrap(0x9B, &[42]),
        ]
        .concat();
        let cluster = [wrap(0xE7, &[10]), wrap(0xA0, &block)].concat();
        [
            wrap(0x1A45_DFA3, &[]),
            wrap(
                SEGMENT,
                &[wrap(TRACKS, &wrap(0xAE, &track)), wrap(CLUSTER, &cluster)].concat(),
            ),
        ]
        .concat()
    }

    #[test]
    fn remuxes_real_alpha_not_black_colour_and_preserves_timestamps() {
        let result = extract(&fixture()).unwrap();
        assert!(result.windows(11).any(|w| w == b"alpha-frame"));
        assert!(!result.windows(12).any(|w| w == b"colour-frame"));
        assert!(result.windows(4).any(|w| w == b"\x81\x00\x2a\x00"));
        assert!(result.windows(3).any(|w| w == [0x9B, 0x81, 42]));
        let root = elements(&result).unwrap();
        let children = elements(root[1].data).unwrap();
        assert!(alpha_track(*children.iter().find(|e| e.id == TRACKS).unwrap()).is_err());
    }

    #[test]
    fn rejects_truncated_and_non_alpha_files_without_panicking() {
        let source = fixture();
        for end in 0..source.len() {
            assert!(extract(&source[..end]).is_err());
        }
        let mut no_alpha = source.clone();
        let index = no_alpha
            .windows(4)
            .position(|w| w == [0x53, 0xC0, 0x81, 1])
            .unwrap();
        no_alpha[index + 3] = 0;
        assert!(extract(&no_alpha).is_err());
        for input in [&[0u8][..], &[0xff; 20][..], &[0x80; 30][..]] {
            assert!(extract(input).is_err());
        }
    }

    #[test]
    fn accepts_streaming_segment_sizes_and_multi_byte_element_sizes() {
        let source = fixture();
        let root = elements(&source).unwrap();
        let mut streaming = root[0].raw.to_vec();
        streaming.extend_from_slice(&[
            0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ]);
        streaming.extend_from_slice(root[1].data);
        assert!(extract(&streaming).is_ok());
        for size in [0, 126, 127, 16_383, 16_384] {
            let data = vec![9; size];
            assert_eq!(elements(&wrap(0xEC, &data)).unwrap()[0].data, data);
        }
    }

    #[test]
    fn fixes_only_vp9_profile_zero_keyframe_range_not_compressed_pixels() {
        for (vp9, source, expected) in [
            (
                true,
                vec![0x82, 0x49, 0x83, 0x42, 0x20, 7, 8],
                vec![0x82, 0x49, 0x83, 0x42, 0x30, 7, 8],
            ),
            (
                true,
                vec![0x86, 0x49, 0x83, 0x42, 0x20],
                vec![0x86, 0x49, 0x83, 0x42, 0x20],
            ),
            (
                false,
                vec![0x82, 0x49, 0x83, 0x42, 0x20],
                vec![0x82, 0x49, 0x83, 0x42, 0x20],
            ),
        ] {
            // BlockAddID defaults to 1 when absent.
            let group = [
                wrap(0xA1, b"\x81\x00\x2a\x00colour"),
                wrap(0x75A1, &wrap(0xA6, &wrap(0xA5, &source))),
            ]
            .concat();
            let group = Element {
                id: 0xA0,
                raw: &group,
                data: &group,
            };
            let output = alpha_block(group, 1, vp9).unwrap().unwrap();
            let fields = elements(&output).unwrap();
            let block = fields.iter().find(|e| e.id == 0xA1).unwrap();
            assert_eq!(&block.data[4..], expected);
            assert!(alpha_block(group, 2, vp9).unwrap().is_none());
        }
    }

    #[test]
    fn rejects_missing_or_laced_alpha_instead_of_using_colour_as_opacity() {
        for block in [
            b"\x81\x00\x00\x00colour".as_slice(),
            b"\x81\x00\x00\x02colour",
            b"\x81",
        ] {
            let group = wrap(0xA1, block);
            assert!(alpha_block(
                Element {
                    id: 0xA0,
                    raw: &group,
                    data: &group
                },
                1,
                true
            )
            .is_err());
        }
    }
}
