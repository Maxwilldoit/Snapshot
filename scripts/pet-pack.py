#!/usr/bin/env python3
"""把共用一张大画布的桌宠 GIF 包裁成「平时一个基准画布，不够再单独放大」。

适用的包：每个动作本来画在同一张坐标系里（为了迁就固定方窗，透明边补到一样大），
人物的脚在每张图的同一个像素上。篮球扣篮包 hoop-23 就是这样：篮筐把画布撑到
569×569，人只占下半截。

脚本会：

1. 用名字里带 idle 的那张当基准姿势（没有就用第一张）。
2. 取它不透明区域的外框，按 --fill（默认 0.93，和其他桌宠差不多）留一圈边，
   得到正方形基准画布。脚底锚点是这张图最下面一行不透明像素的中点、再往下 1 像素。
3. 每张 GIF 的新画布 = 基准画布 ∪（这张图的不透明区域向外扩 --pad 像素）。
   落在基准里的动作画布不变，窗口不放大；扣篮这类会高出、宽出基准，窗口才会变大。
4. 像素索引原样裁切（不重新量化颜色），写出 pet.json。锚点是同一个人脚在新画布里的位置。

用法：

    python3 scripts/pet-pack.py hoop-23-gifs.zip hoop-23-fitted.zip
    python3 scripts/pet-pack.py --self-test

只依赖 Python 3 标准库。已经是各自动画自己的画布、只是要手写锚点的，不必跑这个脚本，
直接按 README 写 pet.json。
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
import zipfile
from dataclasses import dataclass, field


# --- GIF 读写：按索引裁，颜色表原样保留 ------------------------------------


@dataclass
class GifFrame:
    left: int
    top: int
    width: int
    height: int
    indices: bytes
    palette: bytes | None
    delay: int
    disposal: int
    transparent: int | None
    min_code_size: int


@dataclass
class GifImage:
    width: int
    height: int
    background: int
    global_palette: bytes | None
    loop: int | None
    frames: list[GifFrame] = field(default_factory=list)


def _subblocks(data: bytes, offset: int) -> tuple[bytes, int]:
    chunks = []
    while True:
        if offset >= len(data):
            raise ValueError("GIF 子块没收尾")
        size = data[offset]
        offset += 1
        if size == 0:
            return b"".join(chunks), offset
        chunks.append(data[offset : offset + size])
        offset += size


def _skip_subblocks(data: bytes, offset: int) -> int:
    _, offset = _subblocks(data, offset)
    return offset


class _Bits:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self.bits = 0
        self.n = 0

    def read(self, size: int) -> int:
        while self.n < size:
            if self.pos >= len(self.data):
                raise ValueError("GIF 的 LZW 数据断了")
            self.bits |= self.data[self.pos] << self.n
            self.pos += 1
            self.n += 8
        value = self.bits & ((1 << size) - 1)
        self.bits >>= size
        self.n -= size
        return value


def lzw_decode(min_code_size: int, data: bytes) -> bytes:
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    reader = _Bits(data)
    table = {index: bytes([index]) for index in range(clear)}
    next_code = eoi + 1
    out = bytearray()
    prev: int | None = None
    while True:
        code = reader.read(code_size)
        if code == clear:
            table = {index: bytes([index]) for index in range(clear)}
            next_code = eoi + 1
            code_size = min_code_size + 1
            prev = None
            continue
        if code == eoi:
            break
        if code in table:
            entry = table[code]
        elif prev is not None and code == next_code:
            entry = table[prev] + table[prev][:1]
        else:
            raise ValueError(f"GIF 的 LZW 码 {code} 不认识")
        out += entry
        if prev is not None and next_code < 4096:
            table[next_code] = table[prev] + entry[:1]
            next_code += 1
            if code_size < 12 and next_code == 1 << code_size:
                code_size += 1
        prev = code
    return bytes(out)


def lzw_encode(min_code_size: int, indices: bytes) -> bytes:
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    next_code = eoi + 1
    table = {bytes([index]): index for index in range(clear)}
    packed = bytearray()
    bits = 0
    nbits = 0

    def write(code: int, size: int) -> None:
        nonlocal bits, nbits
        bits |= code << nbits
        nbits += size
        while nbits >= 8:
            packed.append(bits & 255)
            bits >>= 8
            nbits -= 8

    def reset() -> None:
        nonlocal code_size, next_code, table
        code_size = min_code_size + 1
        next_code = eoi + 1
        table = {bytes([index]): index for index in range(clear)}

    write(clear, code_size)
    prefix = b""
    for byte in indices:
        candidate = prefix + bytes([byte])
        if candidate in table:
            prefix = candidate
            continue
        write(table[prefix], code_size)
        # 码表满了就发 Clear。位数在「刚写下的码还用旧位数、下一个码才用新位数」这个点加，
        # 和 GIF 的解码器对齐（加到 2^n 这个码时再加一位）。
        if next_code > 4095:
            write(clear, code_size)
            reset()
        else:
            table[candidate] = next_code
            if code_size < 12 and next_code == 1 << code_size:
                code_size += 1
            next_code += 1
        prefix = bytes([byte])
    if prefix:
        write(table[prefix], code_size)
    write(eoi, code_size)
    if nbits:
        packed.append(bits & 255)
    return bytes(packed)


def _pack_subblocks(data: bytes) -> bytes:
    out = bytearray()
    for offset in range(0, len(data), 255):
        chunk = data[offset : offset + 255]
        out.append(len(chunk))
        out += chunk
    out.append(0)
    return bytes(out)


def read_gif(data: bytes) -> GifImage:
    if data[:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError("不是 GIF")
    width, height, packed, background, _aspect = struct.unpack_from("<HHBBB", data, 6)
    offset = 13
    global_palette = None
    if packed & 0x80:
        count = 1 << ((packed & 7) + 1)
        global_palette = data[offset : offset + count * 3]
        offset += count * 3
    image = GifImage(width, height, background, global_palette, loop=None)
    delay = 10
    disposal = 0
    transparent: int | None = None
    pending = False
    while offset < len(data):
        kind = data[offset]
        if kind == 0x3B:
            break
        if kind == 0x21:
            label = data[offset + 1]
            offset += 2
            if label == 0xF9:
                block = data[offset + 1 : offset + 1 + data[offset]]
                flags = block[0]
                delay = struct.unpack_from("<H", block, 1)[0]
                disposal = (flags >> 2) & 7
                transparent = block[3] if flags & 1 else None
                pending = True
                offset = _skip_subblocks(data, offset)
                continue
            if label == 0xFF:
                app, offset = _subblocks(data, offset)
                if app.startswith(b"NETSCAPE2.0") and len(app) >= 14 and app[11] == 1:
                    image.loop = struct.unpack_from("<H", app, 12)[0]
                continue
            offset = _skip_subblocks(data, offset)
            continue
        if kind != 0x2C:
            raise ValueError(f"GIF 里有不认识的块 {kind:#x}")
        left, top, frame_w, frame_h, frame_packed = struct.unpack_from("<HHHHB", data, offset + 1)
        offset += 10
        palette = global_palette
        if frame_packed & 0x80:
            count = 1 << ((frame_packed & 7) + 1)
            palette = data[offset : offset + count * 3]
            offset += count * 3
        min_code_size = data[offset]
        offset += 1
        compressed, offset = _subblocks(data, offset)
        indices = lzw_decode(min_code_size, compressed)
        expected = frame_w * frame_h
        if len(indices) < expected:
            raise ValueError("GIF 帧比画布短")
        image.frames.append(
            GifFrame(
                left,
                top,
                frame_w,
                frame_h,
                indices[:expected],
                palette,
                delay if pending else 10,
                disposal if pending else 0,
                transparent if pending else None,
                min_code_size,
            )
        )
        pending = False
    if not image.frames:
        raise ValueError("GIF 里没有帧")
    return image


def _palette_fields(palette: bytes) -> tuple[int, bytes]:
    """调色板个数必须是 2 的幂。返回 (packed 的低位已含 0x80, 补齐后的字节)。"""
    colors = max(2, len(palette) // 3)
    depth = max(0, (colors - 1).bit_length() - 1)
    declared = 1 << (depth + 1)
    raw = palette[: colors * 3]
    if len(raw) < declared * 3:
        raw += bytes(declared * 3 - len(raw))
    return 0x80 | depth, raw


def write_gif(image: GifImage) -> bytes:
    out = bytearray(b"GIF89a")
    palette = image.global_palette or b""
    packed = 0
    stored_palette = b""
    if palette:
        packed, stored_palette = _palette_fields(palette)
    out += struct.pack("<HHBBB", image.width, image.height, packed, image.background & 255, 0)
    if stored_palette:
        out += stored_palette
    out += b"!\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    global_palette = image.global_palette
    for frame in image.frames:
        flags = ((frame.disposal & 7) << 2) | (1 if frame.transparent is not None else 0)
        out += b"!\xF9\x04"
        out += bytes([flags])
        out += struct.pack("<H", frame.delay & 0xFFFF)
        out += bytes([0 if frame.transparent is None else frame.transparent & 255, 0])
        local = frame.palette if frame.palette and frame.palette != global_palette else None
        frame_packed = 0
        stored_local = b""
        if local:
            frame_packed, stored_local = _palette_fields(local)
        out += b","
        out += struct.pack("<HHHHB", frame.left, frame.top, frame.width, frame.height, frame_packed)
        if stored_local:
            out += stored_local
        out.append(frame.min_code_size & 255)
        out += _pack_subblocks(lzw_encode(frame.min_code_size, frame.indices))
    out += b";"
    return bytes(out)


# --- 裁切与 pet.json --------------------------------------------------------


def _opaque_box(image: GifImage) -> tuple[int, int, int, int] | None:
    """所有帧叠完之后，不透明像素的外框 (左, 上, 右, 下)，右下是开区间。"""
    width, height = image.width, image.height
    canvas = bytearray(width * height)  # 0 透明，1 不透明
    saved: bytearray | None = None
    previous = 0
    box: tuple[int, int, int, int] | None = None
    for frame in image.frames:
        if previous == 2:
            canvas = bytearray(width * height)
        elif previous == 3 and saved is not None:
            canvas = saved
        if frame.disposal == 3:
            saved = bytearray(canvas)
        transparent = frame.transparent
        for y in range(frame.height):
            for x in range(frame.width):
                index = frame.indices[y * frame.width + x]
                if transparent is not None and index == transparent:
                    continue
                px = frame.left + x
                py = frame.top + y
                if 0 <= px < width and 0 <= py < height:
                    canvas[py * width + px] = 1
        min_x, min_y, max_x, max_y = width, height, 0, 0
        found = False
        for y in range(height):
            row = canvas[y * width : (y + 1) * width]
            if 1 not in row:
                continue
            found = True
            left = row.index(1)
            right = width - row[::-1].index(1)
            min_x = min(min_x, left)
            max_x = max(max_x, right)
            min_y = min(min_y, y)
            max_y = max(max_y, y + 1)
        if found:
            box = (min_x, min_y, max_x, max_y) if box is None else (
                min(box[0], min_x),
                min(box[1], min_y),
                max(box[2], max_x),
                max(box[3], max_y),
            )
        previous = frame.disposal
    return box


def _foot(image: GifImage, box: tuple[int, int, int, int]) -> tuple[float, float]:
    """基准姿势最下面一行不透明像素的中点，y 取这行的下沿（脚底）。"""
    bottom = box[3] - 1
    xs: list[int] = []
    for frame in image.frames:
        local_y = bottom - frame.top
        if local_y < 0 or local_y >= frame.height:
            continue
        transparent = frame.transparent
        row = frame.indices[local_y * frame.width : (local_y + 1) * frame.width]
        for x, index in enumerate(row):
            if transparent is not None and index == transparent:
                continue
            xs.append(frame.left + x)
    if not xs:
        xs = [box[0], box[2] - 1]
    return ((min(xs) + max(xs)) / 2, float(box[3]))


def _crop_frame(frame: GifFrame, crop: tuple[int, int, int, int]) -> GifFrame:
    left, top, right, bottom = crop
    width = right - left
    height = bottom - top
    transparent = 0 if frame.transparent is None else frame.transparent
    indices = bytearray([transparent]) * (width * height)
    for y in range(frame.height):
        for x in range(frame.width):
            dx = frame.left + x - left
            dy = frame.top + y - top
            if 0 <= dx < width and 0 <= dy < height:
                indices[dy * width + dx] = frame.indices[y * frame.width + x]
    return GifFrame(
        0,
        0,
        width,
        height,
        bytes(indices),
        frame.palette,
        frame.delay,
        2,
        frame.transparent,
        frame.min_code_size,
    )


def _crop_gif(image: GifImage, crop: tuple[int, int, int, int]) -> bytes:
    cropped = GifImage(
        crop[2] - crop[0],
        crop[3] - crop[1],
        image.background,
        image.global_palette,
        0,
        [_crop_frame(frame, crop) for frame in image.frames],
    )
    return write_gif(cropped)


def _is_gif(name: str) -> bool:
    return name.lower().endswith(".gif") and not name.endswith("/")


def _reference_name(names: list[str]) -> str:
    idle = [name for name in names if "idle" in name.lower().rsplit("/", 1)[-1]]
    if idle:
        return sorted(idle, key=lambda name: (len(name), name))[0]
    return sorted(names)[0]


def convert(source: bytes, fill: float, pad: int) -> tuple[bytes, str]:
    if not 0.5 <= fill <= 1:
        raise SystemExit("--fill 要在 0.5 和 1 之间")
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        gifs = [info.filename for info in archive.infolist() if _is_gif(info.filename)]
        if not gifs:
            raise SystemExit("压缩包里没有 GIF")
        decoded = {name: read_gif(archive.read(name)) for name in gifs}
    boxes = {}
    for name, image in decoded.items():
        box = _opaque_box(image)
        if box is None:
            raise SystemExit(f"{name} 里没有不透明像素，没法对齐")
        boxes[name] = box

    reference = _reference_name(gifs)
    ref_box = boxes[reference]
    ref_height = ref_box[3] - ref_box[1]
    side = max(ref_height, round(ref_height / fill))
    center_x = (ref_box[0] + ref_box[2]) / 2
    center_y = (ref_box[1] + ref_box[3]) / 2
    base_left = round(center_x - side / 2)
    base_top = round(center_y - side / 2)
    base = (base_left, base_top, base_left + side, base_top + side)
    anchor_x, anchor_y = _foot(decoded[reference], ref_box)

    crops: dict[str, tuple[int, int, int, int]] = {}
    for name, box in boxes.items():
        # 人还在基准画布里时，外扩的那一圈不要把画布顶出基准，否则窗口会为了一两个像素跳一下。
        # 只有真的画出基准的边（挥手、起跳、扣篮）才向外长，并在那一侧留 pad。
        left, top, right, bottom = base
        if box[0] < base[0]:
            left = box[0] - pad
        if box[1] < base[1]:
            top = box[1] - pad
        if box[2] > base[2]:
            right = box[2] + pad
        if box[3] > base[3]:
            bottom = box[3] + pad
        crops[name] = (left, top, right, bottom)

    lines = [
        "{",
        '  "version": 1,',
        '  "base": {',
        f'    "width": {side},',
        f'    "height": {side},',
        f'    "anchor": [{anchor_x - base_left:g}, {anchor_y - base_top:g}]',
        "  },",
        '  "animations": {',
    ]
    summary = [f"基准 {reference}：{side}×{side}，脚底 ({anchor_x - base_left:g}, {anchor_y - base_top:g})"]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        names = sorted(gifs)
        for index, name in enumerate(names):
            crop = crops[name]
            archive.writestr(name, _crop_gif(decoded[name], crop))
            ax = anchor_x - crop[0]
            ay = anchor_y - crop[1]
            comma = "," if index + 1 < len(names) else ""
            lines.append(f'    "{name}": {{ "anchor": [{ax:g}, {ay:g}] }}{comma}')
            grown = crop != base
            summary.append(
                f"  {'放大' if grown else '方窗'}  {name}  {crop[2] - crop[0]}×{crop[3] - crop[1]}"
                f"  锚点 ({ax:g}, {ay:g})"
            )
        lines += ["  }", "}", ""]
        manifest = "\n".join(lines)
        archive.writestr("pet.json", manifest)
    print("\n".join(summary))
    return out.getvalue(), manifest


def self_test() -> None:
    # 8×8 画布，(2,3) 起一个 2×3 的色块。透明索引 0，颜色索引 1。
    palette = bytes([0, 0, 0, 10, 20, 30]) + bytes(254 * 3)
    indices = bytearray(64)
    for y in range(3, 6):
        indices[y * 8 + 2] = 1
        indices[y * 8 + 3] = 1
    frame = GifFrame(0, 0, 8, 8, bytes(indices), palette, 5, 2, 0, 8)
    image = GifImage(8, 8, 0, palette, 0, [frame])
    raw = write_gif(image)
    decoded = read_gif(raw)
    assert decoded.frames[0].indices == bytes(indices), "编解码之后像素变了"
    box = _opaque_box(decoded)
    assert box == (2, 3, 4, 6), box
    cropped = read_gif(_crop_gif(decoded, (1, 2, 5, 7)))
    frame = cropped.frames[0]
    assert (frame.width, frame.height) == (4, 5)
    opaque = [
        (x, y)
        for y in range(frame.height)
        for x in range(frame.width)
        if frame.indices[y * frame.width + x] != 0
    ]
    # 原 (2,3)-(3,5) 落在裁切 (1,2) 里，变成 (1,1)-(2,3)
    assert opaque == [(1, 1), (2, 1), (1, 2), (2, 2), (1, 3), (2, 3)], opaque
    # 再编一次再解，确认写出的文件能被自己读回来
    assert read_gif(write_gif(cropped)).frames[0].indices == frame.indices
    # 码表长过 9 位、12 位时也要和自己的解码器对得上
    sample = bytes((index * 17 + (index >> 3)) & 255 for index in range(8000))
    assert lzw_decode(8, lzw_encode(8, sample)) == sample
    print("self-test ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
        return
    parser = argparse.ArgumentParser(description="把共用画布的桌宠 GIF 包裁成带 pet.json 的包")
    parser.add_argument("source", help="原来的 zip")
    parser.add_argument("dest", help="写出去的 zip")
    parser.add_argument("--fill", type=float, default=0.93, help="基准姿势的身高占基准画布的比例，默认 0.93")
    parser.add_argument("--pad", type=int, default=8, help="每张图不透明区域外再留的像素，默认 8")
    args = parser.parse_args()
    with open(args.source, "rb") as source:
        packed, _manifest = convert(source.read(), args.fill, args.pad)
    with open(args.dest, "wb") as dest:
        dest.write(packed)


if __name__ == "__main__":
    main()
