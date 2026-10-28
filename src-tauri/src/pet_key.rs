//! 把画进 GIF 里的纯色背景抠成真透明。
//!
//! 有的素材包把白底直接画进了每一帧，桌宠窗口就成了一个白方块。这里按帧处理：
//! 贴着画布边缘的背景连成一片挖掉；被人物圈住的背景（叉腰时胳膊和身体之间的缝）
//! 只有四周不是白色时才挖，人物身上的白（衬衫、领口）留下；边上和背景混在一起的
//! 像素按最近的纯色像素反解回原色，不然深色桌面上会留一圈浅色毛边。处理完重新编成
//! 带透明色的 GIF。已经透明的素材只检查轮廓上的白底混色；没有变化时原样返回。

use super::*;
use std::collections::{HashMap, HashSet, VecDeque};

/// 单通道差多少以内仍算背景
const FILL_TOL: f32 = 6.0;
/// 比这还小的封闭背景块当人物身上的细节留下
const HOLE_MIN: usize = 6;
/// 一个通道到多少算白色
const WHITE_MIN_CHANNEL: f32 = 200.0;
/// 封闭块四周的白色少于此比例才当背景挖掉
const HOLE_MAX_WHITE: f64 = 0.25;
/// 离被挖掉的地方这么近的像素算边缘
const BAND: i32 = 2;
/// 人物本身的颜色和背景差不到这个数就不反解，免得把浅色衣服洗花
const MIN_CONTRAST: f32 = 40.0;
/// 当前颜色必须确实接近「人物色 + 背景色」的混合，避免把彩色轮廓当成毛边。
const MAX_UNMIX_ERROR: f32 = 12.0;
/// 有些素材抠底时把轮廓染成了中性灰，允许这类白底毛边有少量色相误差。
const MAX_NEUTRAL_UNMIX_ERROR: f32 = 36.0;
/// 狭缝里的背景可能被抗锯齿染灰；只在连着透明区且两侧都是人物时使用。
const GAP_MIN_CHANNEL: f32 = 128.0;
const NEUTRAL_CHROMA: f32 = 8.0;
/// 先确认素材确有白底毛边，再补抠封闭缝隙，干净的像素素材不启用此规则。
const MIN_MATTE_PIXELS: usize = 8;
/// 反解时最多找这么远，再远就用一层层摊开的近似结果
const SEARCH_LIMIT: i32 = 8;
/// GIF 里留给透明的索引
const TRANSPARENT: u8 = 255;

/// 一个颜色和它在这一帧里出现的次数
type ColorCount = ([u8; 3], usize);

/// 一帧算到一半的样子。颜色用 f32 是为了反解边缘时中间值不丢精度。
struct Canvas {
    width: usize,
    height: usize,
    rgb: Vec<[f32; 3]>,
    removed: Vec<bool>,
}

#[derive(Clone, Copy)]
enum BackgroundRegion {
    Solid,
    OpenGap,
    EnclosedGap,
}

/// 四邻域下标，越界的位置是 `usize::MAX`
fn neighbours(index: usize, width: usize, height: usize) -> [usize; 4] {
    let (x, y) = (index % width, index / width);
    [
        if y > 0 { index - width } else { usize::MAX },
        if y + 1 < height {
            index + width
        } else {
            usize::MAX
        },
        if x > 0 { index - 1 } else { usize::MAX },
        if x + 1 < width { index + 1 } else { usize::MAX },
    ]
}

impl Canvas {
    /// 这个像素和背景色的最大单通道差
    fn diff(&self, index: usize, bg: [f32; 3]) -> f32 {
        let pixel = self.rgb[index];
        (0..3).fold(0.0, |worst, channel| {
            worst.max((pixel[channel] - bg[channel]).abs())
        })
    }

    /// 和背景色差得够近，算背景
    fn near(&self, index: usize, bg: [f32; 3]) -> bool {
        self.diff(index, bg) <= FILL_TOL
    }

    fn neutral(&self, index: usize) -> bool {
        let pixel = self.rgb[index];
        pixel.iter().copied().fold(f32::NEG_INFINITY, f32::max)
            - pixel.iter().copied().fold(f32::INFINITY, f32::min)
            <= NEUTRAL_CHROMA
    }

    fn light_neutral(&self, index: usize) -> bool {
        self.neutral(index)
            && self.rgb[index]
                .iter()
                .all(|&channel| channel >= GAP_MIN_CHANNEL)
    }
}

/// 贴着画布边缘的背景连成一片挖掉；人物圈在里面的（胳膊和身体之间的缝）留着后面再看
fn fill_from_border(canvas: &mut Canvas, bg: [f32; 3]) {
    let (width, height) = (canvas.width, canvas.height);
    let mut queue = VecDeque::new();
    for index in 0..canvas.rgb.len() {
        let (x, y) = (index % width, index / width);
        let on_edge = x == 0 || y == 0 || x + 1 == width || y + 1 == height;
        if on_edge && canvas.near(index, bg) {
            canvas.removed[index] = true;
            queue.push_back(index);
        }
    }
    while let Some(index) = queue.pop_front() {
        for neighbour in neighbours(index, width, height) {
            if neighbour != usize::MAX && !canvas.removed[neighbour] && canvas.near(neighbour, bg) {
                canvas.removed[neighbour] = true;
                queue.push_back(neighbour);
            }
        }
    }
}

/// 被人物圈住的背景再找一遍（上一步只挖了连着画布边缘的）。
///
/// 块四周三到五像素那一圈里白色占多数时留着：那是人物自己的白（衬衫、领口），
/// 挖了就成了窟窿；不然就是真的背景缝，挖掉。
fn enclosed_background(
    canvas: &mut Canvas,
    bg: [f32; 3],
    region: BackgroundRegion,
) -> Vec<Vec<usize>> {
    let (width, height) = (canvas.width, canvas.height);
    let is_background = |index: usize| match region {
        BackgroundRegion::OpenGap => canvas.light_neutral(index),
        BackgroundRegion::EnclosedGap => {
            canvas.neutral(index)
                && canvas.rgb[index]
                    .iter()
                    .all(|&channel| channel >= WHITE_MIN_CHANNEL)
        }
        BackgroundRegion::Solid => canvas.near(index, bg),
    };
    let max_white = if matches!(region, BackgroundRegion::EnclosedGap) {
        0.1
    } else {
        HOLE_MAX_WHITE
    };
    let mut seen = vec![false; canvas.rgb.len()];
    let mut holes = Vec::new();
    for start in 0..canvas.rgb.len() {
        if seen[start] || canvas.removed[start] || !is_background(start) {
            continue;
        }
        let mut block = vec![start];
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        while let Some(index) = queue.pop_front() {
            for neighbour in neighbours(index, width, height) {
                if neighbour != usize::MAX
                    && !seen[neighbour]
                    && !canvas.removed[neighbour]
                    && is_background(neighbour)
                {
                    seen[neighbour] = true;
                    block.push(neighbour);
                    queue.push_back(neighbour);
                }
            }
        }
        if block.len() >= HOLE_MIN
            && match region {
                BackgroundRegion::Solid => true,
                BackgroundRegion::OpenGap => is_open_gap(&block, canvas, bg),
                BackgroundRegion::EnclosedGap => is_enclosed_gap(&block, canvas),
            }
            && whitish_around(&block, canvas) < max_white
        {
            holes.push(block);
        }
    }
    // 先看完再一起挖：不然前一块挖掉的地方会影响后一块的四周
    for hole in &holes {
        for &index in hole {
            canvas.removed[index] = true;
        }
    }
    holes
}

/// 被头发、皮肤等有色轮廓围住的狭长白底（例如头发与脖子之间的缝）。
/// 白块要足够长、周边要有明显色彩；白眼睛、灰色物体上的高光及白衣服不满足条件。
fn is_enclosed_gap(block: &[usize], canvas: &Canvas) -> bool {
    let (mut left, mut top, mut right, mut bottom) = (usize::MAX, usize::MAX, 0, 0);
    for &index in block {
        let (x, y) = (index % canvas.width, index / canvas.width);
        left = left.min(x);
        right = right.max(x);
        top = top.min(y);
        bottom = bottom.max(y);
        for next in neighbours(index, canvas.width, canvas.height) {
            if next == usize::MAX || canvas.removed[next] {
                return false;
            }
        }
    }
    let (width, height) = (right - left + 1, bottom - top + 1);
    let (short, long) = (width.min(height), width.max(height));
    if short > 6 || long < 5 || long * 2 < short * 3 {
        return false;
    }
    // 封闭背景要有足够厚的轮廓包住；贴着外边缘的白袖口、肩膀和高光继续保留。
    for &index in block {
        let (x, y) = ((index % canvas.width) as i32, (index / canvas.width) as i32);
        for dy in -3..=3 {
            for dx in -3..=3 {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0
                    || ny < 0
                    || nx >= canvas.width as i32
                    || ny >= canvas.height as i32
                    || canvas.removed[ny as usize * canvas.width + nx as usize]
                {
                    return false;
                }
            }
        }
    }
    // 把一圈灰色抗锯齿也跨过去看，避免动画里白块变灰后认不出两侧的头发和皮肤。
    let mut seen: HashSet<usize> = block.iter().copied().collect();
    let mut queue: VecDeque<(usize, u8)> = block.iter().map(|&index| (index, 0)).collect();
    let (mut boundary, mut coloured) = (0usize, 0usize);
    while let Some((index, depth)) = queue.pop_front() {
        if depth == 2 {
            continue;
        }
        for next in neighbours(index, canvas.width, canvas.height) {
            if next == usize::MAX || !seen.insert(next) {
                continue;
            }
            queue.push_back((next, depth + 1));
            if canvas.removed[next] {
                continue;
            }
            boundary += 1;
            let pixel = canvas.rgb[next];
            if pixel.iter().copied().fold(f32::NEG_INFINITY, f32::max)
                - pixel.iter().copied().fold(f32::INFINITY, f32::min)
                >= 24.0
            {
                coloured += 1;
            }
        }
    }
    boundary > 0 && coloured * 3 >= boundary
}

/// 已透明素材里只补抠通向透明区的狭缝（例如两腿之间），闭合的白眼睛和高光原样保留。
/// 狭缝的大部分像素要在横向或纵向的两侧都能碰到人物，避免削掉外侧的白衣服。
fn is_open_gap(block: &[usize], canvas: &Canvas, bg: [f32; 3]) -> bool {
    let touches_clear = block.iter().any(|&index| {
        neighbours(index, canvas.width, canvas.height)
            .iter()
            .any(|&neighbour| neighbour != usize::MAX && canvas.removed[neighbour])
    });
    if !touches_clear {
        return false;
    }
    let figure_in_direction = |index: usize, dx: i32, dy: i32| {
        let (x, y) = ((index % canvas.width) as i32, (index / canvas.width) as i32);
        for step in 1..=3 {
            let (nx, ny) = (x + dx * step, y + dy * step);
            if nx < 0 || ny < 0 || nx >= canvas.width as i32 || ny >= canvas.height as i32 {
                return false;
            }
            let next = ny as usize * canvas.width + nx as usize;
            if canvas.removed[next] {
                return false;
            }
            if !canvas.light_neutral(next) && canvas.diff(next, bg) >= MIN_CONTRAST {
                return true;
            }
        }
        false
    };
    let narrow = block
        .iter()
        .filter(|&&index| {
            (figure_in_direction(index, -1, 0) && figure_in_direction(index, 1, 0))
                || (figure_in_direction(index, 0, -1) && figure_in_direction(index, 0, 1))
        })
        .count();
    narrow * 2 >= block.len()
}

/// 这一块四周三到五步（横竖走）能碰到的那一圈里白色的比例。圈上一个像素都没有算 0，
/// 也就是当背景挖掉。
fn whitish_around(block: &[usize], canvas: &Canvas) -> f64 {
    let (width, height) = (canvas.width, canvas.height);
    let mut depth = vec![u8::MAX; canvas.rgb.len()];
    let mut queue = VecDeque::new();
    for &index in block {
        depth[index] = 0;
        queue.push_back(index);
    }
    let (mut whitish, mut total) = (0usize, 0usize);
    while let Some(index) = queue.pop_front() {
        let level = depth[index];
        if level >= 5 {
            continue;
        }
        for neighbour in neighbours(index, width, height) {
            if neighbour == usize::MAX || depth[neighbour] != u8::MAX {
                continue;
            }
            depth[neighbour] = level + 1;
            queue.push_back(neighbour);
            if level + 1 >= 3 && !canvas.removed[neighbour] {
                total += 1;
                if canvas.rgb[neighbour]
                    .iter()
                    .copied()
                    .fold(f32::INFINITY, f32::min)
                    >= WHITE_MIN_CHANNEL
                {
                    whitish += 1;
                }
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        whitish as f64 / total as f64
    }
}

/// 紧挨着被挖掉的像素这一圈边缘（距离两步以内），和更里面的人物本体
fn edge_bands(canvas: &Canvas) -> (Vec<bool>, Vec<bool>) {
    // 距离 BAND 步以内的偏移都算边缘
    let offsets: Vec<(i32, i32)> = (-BAND..=BAND)
        .flat_map(|dy| (-BAND..=BAND).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| (dx != 0 || dy != 0) && dx * dx + dy * dy <= BAND * BAND)
        .collect();
    let (width, height) = (canvas.width, canvas.height);
    let mut band = vec![false; canvas.rgb.len()];
    let mut inner = vec![false; canvas.rgb.len()];
    for (index, removed) in canvas.removed.iter().copied().enumerate() {
        if removed {
            continue;
        }
        let (x, y) = ((index % width) as i32, (index / width) as i32);
        let touching = offsets.iter().any(|&(dx, dy)| {
            let (nx, ny) = (x + dx, y + dy);
            nx >= 0
                && ny >= 0
                && (nx as usize) < width
                && (ny as usize) < height
                && canvas.removed[ny as usize * width + nx as usize]
        });
        if touching {
            band[index] = true;
        } else {
            inner[index] = true;
        }
    }
    (band, inner)
}

/// 只有能沿白色像素连到透明区的白块才算白底残留。
/// 靠近轮廓、但被人物颜色围住的白眼睛和高光不会被当作背景反解。
fn connected_matte(canvas: &Canvas) -> Vec<bool> {
    let white = |index: usize| {
        canvas.neutral(index)
            && canvas.rgb[index]
                .iter()
                .all(|&channel| channel >= WHITE_MIN_CHANNEL)
    };
    let mut connected = vec![false; canvas.rgb.len()];
    let mut queue = VecDeque::new();
    for index in 0..canvas.rgb.len() {
        if canvas.removed[index] || !white(index) {
            continue;
        }
        if neighbours(index, canvas.width, canvas.height)
            .iter()
            .any(|&next| next != usize::MAX && canvas.removed[next])
        {
            connected[index] = true;
            queue.push_back(index);
        }
    }
    while let Some(index) = queue.pop_front() {
        for next in neighbours(index, canvas.width, canvas.height) {
            if next != usize::MAX && !connected[next] && !canvas.removed[next] && white(next) {
                connected[next] = true;
                queue.push_back(next);
            }
        }
    }
    connected
}

/// 边缘像素和背景混在一起了：按最近的纯色像素反解出没混之前的颜色；解出来一半以上
/// 还是背景的直接挖掉——GIF 的透明只有开和关，不这么做深色桌面上会留一圈浅边。
fn unmix_edges(canvas: &mut Canvas, bg: [f32; 3], focus: Option<&[bool]>) {
    let (band, inner) = edge_bands(canvas);
    if !inner.iter().any(|&inside| inside) {
        return;
    }
    let white_matte = bg.iter().all(|&channel| channel >= 240.0);
    let connected = white_matte.then(|| connected_matte(canvas));
    let mut spread = None;
    let mut updates = Vec::new();
    for (index, on_band) in band.iter().copied().enumerate() {
        if !on_band || focus.is_some_and(|focus| !focus[index]) {
            continue;
        }
        if connected.as_ref().is_some_and(|connected| {
            !connected[index]
                && canvas.neutral(index)
                && canvas.rgb[index]
                    .iter()
                    .all(|&channel| channel >= WHITE_MIN_CHANNEL)
        }) {
            continue;
        }
        let source = match nearest_within(canvas, &inner, index, SEARCH_LIMIT) {
            Some(source) => source,
            None => {
                let nearest = spread.get_or_insert_with(|| nearest_inner(canvas, &inner));
                nearest[index]
            }
        };
        if source == usize::MAX {
            continue;
        }
        let pixel = canvas.rgb[index];
        let solid = canvas.rgb[source];
        // 白底素材的浅色衣服不能拿阴影当原色反解，否则袖口会被削掉。
        if white_matte && solid.iter().all(|&channel| channel >= WHITE_MIN_CHANNEL) {
            continue;
        }
        let d = [0, 1, 2].map(|channel| solid[channel] - bg[channel]);
        let norm = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if norm.sqrt() < MIN_CONTRAST {
            continue;
        }
        let alpha = ([0, 1, 2]
            .map(|channel| (pixel[channel] - bg[channel]) * d[channel])
            .iter()
            .sum::<f32>()
            / norm)
            .clamp(0.0, 1.0);
        let error = (0..3).fold(0.0_f32, |worst, channel| {
            let mixed = alpha * solid[channel] + (1.0 - alpha) * bg[channel];
            worst.max((pixel[channel] - mixed).abs())
        });
        let max_error = if canvas.neutral(index) && white_matte {
            MAX_NEUTRAL_UNMIX_ERROR
        } else {
            MAX_UNMIX_ERROR
        };
        if error > max_error || alpha >= 1.0 {
            continue;
        }
        updates.push((
            index,
            if alpha < 0.5 {
                None
            } else {
                Some([0, 1, 2].map(|channel| {
                    ((pixel[channel] - (1.0 - alpha) * bg[channel]) / alpha).clamp(0.0, 255.0)
                }))
            },
        ));
    }
    // 都按解开之前的值算完了再改，免得后面的边缘拿前面改过的颜色当参考
    for (index, color) in updates {
        match color {
            Some(color) => canvas.rgb[index] = color,
            None => canvas.removed[index] = true,
        }
    }
}

/// 从 `index` 往外一圈圈找最近的「人物本体」像素，超过 `limit` 步就没找到
fn nearest_within(canvas: &Canvas, inner: &[bool], index: usize, limit: i32) -> Option<usize> {
    let (width, height) = (canvas.width as i32, canvas.height as i32);
    let (x, y) = ((index % canvas.width) as i32, (index / canvas.width) as i32);
    let mut best: Option<(i32, usize)> = None;
    for radius in 1..=limit {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs() != radius && dy.abs() != radius {
                    continue;
                }
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= width || ny >= height {
                    continue;
                }
                let candidate = ny as usize * canvas.width + nx as usize;
                if !inner[candidate] || !foreground_line(canvas, index, candidate) {
                    continue;
                }
                let squared = dx * dx + dy * dy;
                if best.is_none_or(|(current, _)| squared < current) {
                    best = Some((squared, candidate));
                }
            }
        }
        if best.is_some_and(|(squared, _)| squared <= radius * radius) {
            break;
        }
    }
    best.map(|(_, index)| index)
}

/// 参考色和边缘之间不能跨过透明区，避免细小独立部件借到另一块人物/道具的颜色。
fn foreground_line(canvas: &Canvas, from: usize, to: usize) -> bool {
    let (x, y) = ((from % canvas.width) as i32, (from / canvas.width) as i32);
    let (dx, dy) = (
        (to % canvas.width) as i32 - x,
        (to / canvas.width) as i32 - y,
    );
    let steps = dx.abs().max(dy.abs());
    (1..=steps).all(|step| {
        let nx = x + (dx as f32 * step as f32 / steps as f32).round() as i32;
        let ny = y + (dy as f32 * step as f32 / steps as f32).round() as i32;
        !canvas.removed[ny as usize * canvas.width + nx as usize]
    })
}

/// 每个像素最近的人物本体像素，一层层从本体往外摊开（细胳膊细腿那种边缘找不到
/// 本体才用得上，横竖摊开的结果够近）
fn nearest_inner(canvas: &Canvas, inner: &[bool]) -> Vec<usize> {
    let mut source = vec![usize::MAX; canvas.rgb.len()];
    let mut queue = VecDeque::new();
    for (index, &inside) in inner.iter().enumerate() {
        if inside {
            source[index] = index;
            queue.push_back(index);
        }
    }
    while let Some(index) = queue.pop_front() {
        for neighbour in neighbours(index, canvas.width, canvas.height) {
            if neighbour != usize::MAX
                && !canvas.removed[neighbour]
                && source[neighbour] == usize::MAX
            {
                source[neighbour] = source[index];
                queue.push_back(neighbour);
            }
        }
    }
    source
}

/// 抠一帧：先挖边缘连通的背景，再处理圈在里面的，最后把边缘混合色反解回原色。
fn key_frame(frame: &RgbaImage, bg: [f32; 3], solid_background: bool) -> Canvas {
    let (width, height) = (frame.width() as usize, frame.height() as usize);
    let mut canvas = Canvas {
        width,
        height,
        rgb: frame
            .pixels()
            .map(|pixel| [pixel[0] as f32, pixel[1] as f32, pixel[2] as f32])
            .collect(),
        removed: frame.pixels().map(|pixel| pixel[3] == 0).collect(),
    };
    // 已经透明的图沿用作者的轮廓，不重新按白色抠底（白衣服也可能直接贴着画布边缘）。
    if solid_background {
        fill_from_border(&mut canvas, bg);
    }
    let region = if solid_background {
        BackgroundRegion::Solid
    } else {
        BackgroundRegion::OpenGap
    };
    enclosed_background(&mut canvas, bg, region);
    unmix_edges(&mut canvas, bg, None);
    // 边缘反解掉以后，原本被浅色阴影围住的小块背景（鞋跟底下之类）会露出来，再来一轮
    enclosed_background(&mut canvas, bg, region);
    unmix_edges(&mut canvas, bg, None);
    if !solid_background
        && frame
            .pixels()
            .enumerate()
            .filter(|(index, pixel)| pixel[3] != 0 && canvas.removed[*index])
            .take(MIN_MATTE_PIXELS)
            .count()
            >= MIN_MATTE_PIXELS
    {
        let gaps = enclosed_background(&mut canvas, bg, BackgroundRegion::EnclosedGap);
        if !gaps.is_empty() {
            // 只修新挖出的缝周围，避免反复处理已经清理好的其他轮廓。
            let mut focus = vec![false; width * height];
            for &index in gaps.iter().flatten() {
                let (x, y) = ((index % width) as i32, (index / width) as i32);
                for dy in -BAND * 2..=BAND * 2 {
                    for dx in -BAND * 2..=BAND * 2 {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx >= 0 && ny >= 0 && nx < width as i32 && ny < height as i32 {
                            focus[ny as usize * width + nx as usize] = true;
                        }
                    }
                }
            }
            unmix_edges(&mut canvas, bg, Some(&focus));
            unmix_edges(&mut canvas, bg, Some(&focus));
        }
    }
    canvas
}

/// 把素材里画进去的纯色背景抠掉，编回一份带透明色的 GIF。
///
/// 透明素材也会清除轮廓混入的白色；一帧都没有变化时返回 None，调用方照原样用。
pub(crate) fn key_out(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let decoded = pet_walk::decode(bytes)?;
    if decoded.is_empty() {
        return Ok(None);
    }
    let delays: Vec<u16> = decoded.iter().map(|(_, delay)| *delay).collect();
    let frames: Vec<RgbaImage> = decoded.into_iter().map(|(image, _)| image).collect();
    let (bg, solid_background) = match pet_walk::Backdrop::of(&frames) {
        pet_walk::Backdrop::Transparent => ([255, 255, 255], false),
        pet_walk::Backdrop::Solid(color) => (color, true),
    };
    let (width, height) = frames[0].dimensions();
    if width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err("画布大得 GIF 存不下".into());
    }
    let background = [bg[0] as f32, bg[1] as f32, bg[2] as f32];
    encode(&frames, background, solid_background, &delays)
}

/// 逐帧处理并编回 GIF，只保留当前帧的浮点画布，避免把整段动画的中间结果全留在内存。
/// 每帧自带一张调色板，索引 255 留给透明；没有变化时仍由调用方复用原文件。
fn encode(
    frames: &[RgbaImage],
    background: [f32; 3],
    solid_background: bool,
    delays: &[u16],
) -> Result<Option<Vec<u8>>, String> {
    let (width, height) = frames[0].dimensions();
    let (width, height) = (width as u16, height as u16);
    let mut bytes = Vec::new();
    let mut changed = false;
    {
        let mut encoder =
            gif::Encoder::new(&mut bytes, width, height, &[]).map_err(|error| error.to_string())?;
        encoder
            .set_repeat(gif::Repeat::Infinite)
            .map_err(|error| error.to_string())?;
        for (position, original) in frames.iter().enumerate() {
            let canvas = key_frame(original, background, solid_background);
            changed |= original.pixels().enumerate().any(|(index, pixel)| {
                pixel[3] != 0
                    && (canvas.removed[index]
                        || rounded(&canvas.rgb[index]) != [pixel[0], pixel[1], pixel[2]])
            });
            let (pixels, palette) = index_frame(original, &canvas);
            let mut frame =
                gif::Frame::from_palette_pixels(width, height, pixels, palette, Some(TRANSPARENT));
            frame.delay = delays.get(position).copied().unwrap_or(10);
            // 每帧画完清成透明再画下一帧，不然手脚摆过的地方会留下残影
            frame.dispose = gif::DisposalMethod::Background;
            encoder
                .write_frame(&frame)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(changed.then_some(bytes))
}

/// 一帧编成「索引 + 调色板」：抠掉的地方走透明索引，其余按最近的颜色入索引。
fn index_frame(original: &RgbaImage, canvas: &Canvas) -> (Vec<u8>, Vec<u8>) {
    let mut counts = HashMap::<[u8; 3], usize>::new();
    for (index, color) in canvas.rgb.iter().enumerate() {
        if !canvas.removed[index] {
            *counts.entry(rounded(color)).or_default() += 1;
        }
    }
    let palette = palette_colors(&counts, original);
    let mut lookup = HashMap::<[u8; 3], u8>::new();
    let mut pixels = vec![TRANSPARENT; canvas.rgb.len()];
    for (index, color) in canvas.rgb.iter().enumerate() {
        if canvas.removed[index] {
            continue;
        }
        let color = rounded(color);
        let slot = *lookup
            .entry(color)
            .or_insert_with(|| nearest_slot(&palette, color));
        pixels[index] = slot;
    }
    let mut table = Vec::with_capacity(768);
    for color in &palette {
        table.extend_from_slice(color);
    }
    table.resize(768, 0);
    (pixels, table)
}

/// 这一帧的调色板：原素材里本来就有的颜色按出现次数优先占位，剩下的槽位给反解
/// 边缘时新出现的颜色（GIF 一帧最多 255 色，第 256 个索引留给透明）。
fn palette_colors(counts: &HashMap<[u8; 3], usize>, original: &RgbaImage) -> Vec<[u8; 3]> {
    let mut colors: Vec<ColorCount> = counts
        .iter()
        .map(|(&color, &count)| (color, count))
        .collect();
    // 次数相同的按颜色排队，同一份素材每次都编出一样的调色板
    colors.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    if colors.len() <= TRANSPARENT as usize {
        return colors.into_iter().map(|(color, _)| color).collect();
    }
    let known: HashSet<[u8; 3]> = original
        .pixels()
        .map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect();
    let (base, extra): (Vec<ColorCount>, Vec<ColorCount>) = colors
        .into_iter()
        .partition(|(color, _)| known.contains(color));
    base.into_iter()
        .chain(extra)
        .map(|(color, _)| color)
        .take(TRANSPARENT as usize)
        .collect()
}

/// 调色板里离这个颜色最近的一格
fn nearest_slot(palette: &[[u8; 3]], color: [u8; 3]) -> u8 {
    let mut best = (u32::MAX, 0);
    for (slot, entry) in palette.iter().enumerate() {
        let distance = (0..3).fold(0u32, |sum, channel| {
            let diff = entry[channel] as i32 - color[channel] as i32;
            sum + (diff * diff) as u32
        });
        if distance < best.0 {
            best = (distance, slot);
        }
    }
    best.1 as u8
}

/// 调色板里用的颜色，四舍五入到 0-255（和离线脚本的 np.rint 一样，.5 归到偶数）
fn rounded(color: &[f32; 3]) -> [u8; 3] {
    [0, 1, 2].map(|channel| color[channel].clamp(0.0, 255.0).round_ties_even() as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    const PAPER: Rgba<u8> = Rgba([254, 254, 254, 255]);
    const INK: Rgba<u8> = Rgba([30, 30, 40, 255]);
    const CLEAR: Rgba<u8> = Rgba([0, 0, 0, 0]);

    /// 在 `canvas` 大小的画布上铺一层 `background`，把 `blocks` 里的矩形一块块画上去
    fn painted(
        canvas: (u32, u32),
        background: Rgba<u8>,
        blocks: &[(Rgba<u8>, [u32; 4])],
        frames: usize,
    ) -> Vec<u8> {
        let images: Vec<(RgbaImage, u16)> = (0..frames)
            .map(|_| {
                let mut image = RgbaImage::from_pixel(canvas.0, canvas.1, background);
                for &(color, [left, top, right, bottom]) in blocks {
                    for y in top..bottom {
                        for x in left..right {
                            image.put_pixel(x, y, color);
                        }
                    }
                }
                (image, 10)
            })
            .collect();
        pet_walk::encode(images, canvas.0, canvas.1).expect("生成测试 GIF 失败")
    }

    /// 抠完以后每一帧的样子
    fn keyed_frames(bytes: &[u8]) -> Vec<(RgbaImage, u16)> {
        let keyed = key_out(bytes)
            .expect("抠背景失败")
            .expect("这份素材应当被抠过背景");
        pet_walk::decode(&keyed).expect("抠完的 GIF 解不开")
    }

    #[test]
    fn a_background_painted_into_the_gif_becomes_transparent() {
        let bytes = painted((60, 60), PAPER, &[(INK, [20, 20, 40, 40])], 2);
        let frames = keyed_frames(&bytes);
        assert_eq!(frames.len(), 2);
        for (image, delay) in &frames {
            assert_eq!(*delay, 10, "每帧的时长不能变");
            assert_eq!(image.get_pixel(0, 0)[3], 0, "画布角落的白底应当没了");
            assert_eq!(image.get_pixel(59, 59)[3], 0);
            assert_eq!(*image.get_pixel(30, 30), INK, "人物本体原样保留");
            assert_eq!(*image.get_pixel(20, 20), INK, "平涂的边不用反解");
        }
    }

    #[test]
    fn a_white_part_of_the_figure_keeps_its_colour() {
        // 深色轮廓里套一圈浅色阴影，最里面才是白衬衫：四周不是深色，得当人物自己的白留下
        let grey = Rgba([220, 220, 220, 255]);
        let bytes = painted(
            (80, 80),
            PAPER,
            &[
                (INK, [30, 30, 50, 50]),
                (grey, [33, 33, 47, 47]),
                (PAPER, [36, 36, 44, 44]),
            ],
            1,
        );
        let frames = keyed_frames(&bytes);
        let image = &frames[0].0;
        assert_eq!(*image.get_pixel(40, 40), PAPER, "衬衫应当留着");
        assert_eq!(*image.get_pixel(34, 34), grey, "浅色阴影原样保留");
        assert_eq!(*image.get_pixel(31, 31), INK);
        assert_eq!(image.get_pixel(0, 0)[3], 0);
    }

    #[test]
    fn a_gap_between_limbs_is_cut_out() {
        // 深色人物中间的缝是背景色，人物自己不是白，缝得挖掉
        let bytes = painted(
            (80, 80),
            PAPER,
            &[(INK, [20, 20, 60, 60]), (PAPER, [36, 36, 44, 44])],
            1,
        );
        let frames = keyed_frames(&bytes);
        let image = &frames[0].0;
        assert_eq!(image.get_pixel(40, 40)[3], 0, "缝里的背景应当挖掉");
        assert_eq!(*image.get_pixel(25, 25), INK, "人物本体不能被一起挖掉");
    }

    #[test]
    fn an_already_transparent_gif_is_left_alone() {
        let bytes = painted((60, 60), CLEAR, &[(INK, [20, 20, 40, 40])], 1);
        assert!(key_out(&bytes).expect("抠背景失败").is_none());
    }

    #[test]
    fn detached_thin_pixel_art_details_do_not_borrow_another_objects_colour() {
        let detail = Rgba([170, 170, 170, 255]);
        let bytes = painted(
            (60, 60),
            CLEAR,
            &[
                (INK, [20, 20, 40, 40]),
                (detail, [17, 20, 18, 40]),
                (PAPER, [43, 20, 45, 28]),
            ],
            1,
        );
        assert!(
            key_out(&bytes).expect("处理像素素材失败").is_none(),
            "独立细线不能被附近的深色物体染色或抹掉"
        );
    }

    #[test]
    fn a_clean_grey_pixel_sprite_keeps_its_body_and_white_edge_highlights() {
        let grey = Rgba([160, 160, 160, 255]);
        let bytes = painted(
            (32, 32),
            CLEAR,
            &[(grey, [6, 6, 26, 26]), (PAPER, [7, 10, 8, 11])],
            1,
        );
        assert!(
            key_out(&bytes).expect("处理灰色像素素材失败").is_none(),
            "灰色人物和贴近轮廓的闭合白色高光都应当保留"
        );
    }

    #[test]
    fn a_white_matte_on_a_transparent_gif_is_removed_and_unmixed() {
        let mixed = Rgba([86, 86, 94, 255]);
        let bytes = painted(
            (60, 60),
            CLEAR,
            &[
                (Rgba([255, 255, 255, 255]), [15, 15, 45, 45]),
                (mixed, [16, 16, 44, 44]),
                (INK, [17, 17, 43, 43]),
            ],
            2,
        );
        for (image, delay) in keyed_frames(&bytes) {
            assert_eq!(delay, 10);
            assert_eq!(image.get_pixel(0, 0)[3], 0);
            assert_eq!(image.get_pixel(15, 30)[3], 0, "外侧纯白毛边应当透明");
            let edge = image.get_pixel(16, 30);
            assert_eq!(edge[3], 255, "人物覆盖超过一半的边缘应当保留");
            for channel in 0..3 {
                assert!(
                    edge[channel].abs_diff(INK[channel]) <= 2,
                    "边缘应当恢复人物原色：{edge:?}"
                );
            }
            assert_eq!(*image.get_pixel(30, 30), INK);
        }
    }

    #[test]
    fn transparent_white_clothing_and_a_coloured_outline_are_left_alone() {
        let white = Rgba([245, 245, 245, 255]);
        let shaded_white = Rgba([215, 215, 215, 255]);
        let red = Rgba([220, 35, 40, 255]);
        let blue = Rgba([25, 45, 160, 255]);
        let bytes = painted(
            (80, 60),
            CLEAR,
            &[
                (white, [5, 10, 30, 50]),
                (shaded_white, [7, 12, 28, 48]),
                (red, [45, 10, 75, 50]),
                (blue, [47, 12, 73, 48]),
            ],
            1,
        );
        assert!(
            key_out(&bytes).expect("处理透明素材失败").is_none(),
            "白衣和有意绘制的彩色轮廓不能被当成白边"
        );
    }

    #[test]
    fn open_matte_gaps_are_cut_out_but_closed_white_details_are_preserved() {
        let white = Rgba([255, 255, 255, 255]);
        let bytes = painted(
            (70, 70),
            CLEAR,
            &[
                (INK, [10, 10, 60, 60]),
                (white, [33, 35, 35, 60]),
                (Rgba([190, 190, 190, 255]), [33, 55, 35, 60]),
                (white, [18, 18, 21, 21]),
            ],
            1,
        );
        let frames = keyed_frames(&bytes);
        let image = &frames[0].0;
        assert_eq!(
            image.get_pixel(34, 40)[3],
            0,
            "连向透明区的腿间白底应当清除"
        );
        assert_eq!(
            image.get_pixel(34, 57)[3],
            0,
            "狭缝出口的灰色过渡也应当清除"
        );
        assert_eq!(
            *image.get_pixel(19, 19),
            white,
            "闭合的白眼睛和高光应当保留"
        );
        assert_eq!(*image.get_pixel(30, 30), INK);
    }

    #[test]
    fn neutral_matte_on_coloured_hair_is_cleaned_without_washing_out_the_core() {
        let hair = Rgba([102, 41, 38, 255]);
        let fringe = Rgba([166, 167, 167, 255]);
        let bytes = painted(
            (60, 60),
            CLEAR,
            &[(fringe, [15, 15, 45, 45]), (hair, [16, 16, 44, 44])],
            1,
        );
        let frames = keyed_frames(&bytes);
        let image = &frames[0].0;
        assert_eq!(
            image.get_pixel(15, 30)[3],
            0,
            "灰白轮廓不能因轻微色相误差而漏掉"
        );
        assert_eq!(*image.get_pixel(30, 30), hair);
    }

    #[test]
    fn closed_background_pockets_need_matte_evidence_and_keep_white_details() {
        let hair = Rgba([102, 41, 38, 255]);
        let grey = Rgba([160, 160, 160, 255]);
        let white = Rgba([255, 255, 255, 255]);
        let collar = Rgba([245, 245, 245, 255]);
        let blocks = [
            (hair, [11, 11, 59, 59]),
            (white, [25, 25, 27, 32]),
            (white, [35, 20, 38, 23]),
            (grey, [40, 30, 55, 50]),
            (white, [44, 35, 46, 42]),
            (white, [13, 37, 15, 44]),
            (collar, [30, 52, 55, 57]),
        ];
        let clean = painted((70, 70), CLEAR, &blocks, 1);
        assert!(
            key_out(&clean).expect("处理干净素材失败").is_none(),
            "没有白底毛边的素材不应补抠封闭白块"
        );
        let matted: Vec<_> = std::iter::once((Rgba([166, 167, 167, 255]), [10, 10, 60, 60]))
            .chain(blocks)
            .collect();
        let frames = keyed_frames(&painted((70, 70), CLEAR, &matted, 1));
        let image = &frames[0].0;
        assert_eq!(
            image.get_pixel(25, 28)[3],
            0,
            "有色轮廓之间的狭长白底应当清除"
        );
        assert_eq!(*image.get_pixel(36, 21), white, "白眼睛应当保留");
        assert_eq!(
            *image.get_pixel(45, 38),
            white,
            "灰色物体上的狭长白色高光应当保留"
        );
        assert_eq!(*image.get_pixel(40, 54), collar, "白色衣领应当保留");
        assert_eq!(
            *image.get_pixel(13, 40),
            white,
            "贴近外轮廓的白色衣服和高光应当保留"
        );
        assert_eq!(
            *image.get_pixel(11, 40),
            hair,
            "补抠封闭白块不能重复清理其他轮廓"
        );
    }

    #[test]
    fn makima_fringe_is_cleaned_while_shirt_and_animation_timing_are_preserved() {
        let source = include_bytes!("../../docs/screenshots/makima/idle.gif");
        let original = pet_walk::decode(source).expect("Makima 样本解码失败");
        let frames = keyed_frames(source);
        assert_eq!(frames.len(), original.len());
        for ((image, delay), (before, before_delay)) in frames.iter().zip(&original) {
            assert_eq!(image.dimensions(), before.dimensions());
            assert_eq!(delay, before_delay);
            for (after, before) in image.pixels().zip(before.pixels()) {
                if before[3] == 0 {
                    assert_eq!(after[3], 0, "不能把透明区域重新染实");
                }
            }
        }
        let first = &frames[0].0;
        assert_eq!(first.get_pixel(95, 220)[3], 0, "裤腿外侧明显的白边应当清除");
        assert_eq!(
            first.get_pixel(114, 220)[3],
            0,
            "腿间残留的白底应当连同灰色出口清除"
        );
        assert_eq!(
            *first.get_pixel(100, 80),
            *original[0].0.get_pixel(100, 80),
            "白衬衫应当保留"
        );
        assert_eq!(
            first.get_pixel(104, 51)[3],
            0,
            "头发和脖子之间的封闭白底应当清除"
        );
        for (x, y) in [(110, 59), (109, 60)] {
            assert_eq!(
                *first.get_pixel(x, y),
                *original[0].0.get_pixel(x, y),
                "清除颈侧白底不能削掉衣领"
            );
        }
        let neck = [
            (104, 54),
            (107, 50),
            (107, 50),
            (107, 53),
            (107, 52),
            (107, 51),
            (107, 51),
            (107, 51),
            (107, 51),
            (107, 52),
            (107, 53),
            (107, 51),
        ];
        for (position, &(x, y)) in neck.iter().enumerate() {
            assert_eq!(original[position].0.get_pixel(x, y)[3], 255);
            assert_eq!(
                frames[position].0.get_pixel(x, y)[3],
                0,
                "待机第 {position} 帧的颈侧白底不应重新出现"
            );
        }
    }

    #[test]
    fn cleaning_closed_matte_pockets_preserves_makimas_white_shoulder() {
        let frames = keyed_frames(include_bytes!("../../docs/screenshots/makima/jump.gif"));
        assert_eq!(
            frames[11].0.get_pixel(136, 86)[3],
            255,
            "靠近辫子的白色肩膀不能被挖成透明"
        );
    }

    #[test]
    fn something_that_is_not_a_gif_is_an_error_not_a_panic() {
        assert!(key_out(b"not a gif").is_err());
    }
}
