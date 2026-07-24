#!/usr/bin/env python3
"""OpenCV 本地抹字 inpaint：base 圖＋文字遮罩 → 去字背景圖。

用法：local_inpaint.py BASE_PNG MASK_PNG OUTPUT_PNG
機器輸出走「輸出檔案 + exit code」，stdout 不做協定；診斷訊息一律進 stderr。

演算法三步（見下方常數的實驗依據）：
  1. 背景蔓延：從遮罩框外取種子做容差 flood，凡顏色能連續走進框內的都是背景。
  2. 墨 = 遮罩內走不到的像素，小幅膨脹蓋反鋸齒，並夾回遮罩內（框外零改動）。
  3. 修補：Telea inpaint，再對兩端同色的抹除帶做軸向橋接，接回被文字蓋住的線。
"""
import os
import sys

# 與 paddle_ocr.py 同一套 fd 紀律：OpenCV 原生層可能直接對 OS fd 1 printf
# （sys.stdout 層攔不到），在 import cv2 之前就把 fd 1 改道到 stderr，
# 保證任何原生輸出都不會污染呼叫端的 stdout。本腳本的機器輸出只有檔案與
# exit code，因此 dup 下來的原始 stdout 不再使用。
os.dup2(2, 1)

# ── 演算法常數（不要改值）──────────────────────────────────────────────
# 實驗依據：11 個 1920×1080 合成投影片場景（軸線／表格格線／卡片邊框／膠囊／
# 色塊交界／垂直漸層／紋理背景／折線圖斜線／壓在線上的文字／低對比彩色細字），
# 每個場景都有「無文字背景」的 ground truth，遮罩用 text-layers.ts 的 padX/padY
# 幾何並加 ±3px 抖動模擬 OCR 框誤差。相對於舊版（灰階眾數判墨＋7×7 膨脹 2 次）：
# 結構像素誤差 29.6 → 3.7、遮罩外被改動像素 13445 → 0、殘字 5.6 → 1.3。
# JPEG q95／q88／q75 往返後同樣領先，故不因壓縮雜訊改用更大的 FLOOD_TOLERANCE。
#
# FLOOD_TOLERANCE：flood 的逐鄰居容差。太大（≥10）會沿反鋸齒爬進低對比文字造成
# 殘字；太小（≤4）則紋理／顆粒背景蔓延不進去，背景會被誤判成墨。
FLOOD_TOLERANCE = 6
# 種子取樣間隔：沿遮罩框外每 3 個像素取一點，確保框外每種結構（底色、線、色塊）
# 都至少有一個種子；已被標記的點會跳過，成本與 flood 次數無關。
SEED_STEP = 3
# 框外取種子的環寬。
HALO = 10
# 墨膨脹：ink 已精確到像素，只需 3×3 一次蓋住反鋸齒殘緣（舊版 7×7 兩次會外擴
# 6px，正是圖表線被抹斷的主因）。
DILATE_KERNEL_SIZE = 3
DILATE_ITERATIONS = 1
INPAINT_RADIUS = 3
# 軸向橋接：抹除帶兩端各取 BRIDGE_PROBE 像素的中位色，色差在 BRIDGE_TOLERANCE
# 內才視為「同一條線／同一片底色被文字截斷」並線性插值接回；超過 BRIDGE_MAX_GAP
# 的帶不橋接（兩端同色也可能只是巧合）。
BRIDGE_MAX_GAP = 420
BRIDGE_PROBE = 4
BRIDGE_TOLERANCE = 12
# textMask 產物是「白色矩形＋透明底」的 RGBA PNG：alpha > 128 即為矩形區。
ALPHA_THRESHOLD = 128


def read_region(mask, shape):
    """遮罩矩形區：RGBA 取 alpha；萬一遮罩沒有 alpha（不透明白矩形＋黑底）退回亮度。"""
    import cv2
    import numpy as np

    if mask.ndim == 3 and mask.shape[2] == 4:
        channel = mask[:, :, 3]
    elif mask.ndim == 3:
        channel = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    else:
        channel = mask
    if channel.shape[:2] != shape:
        channel = cv2.resize(channel, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
    return (channel > ALPHA_THRESHOLD).astype(np.uint8)


def background_by_flood(base, region):
    """從遮罩框外蔓延出的背景。

    要保留的東西（底色、漸層、紋理、軸線、格線、邊框、色塊）在遮罩框外都有本體，
    顏色可以連續走進框內；文字被 textMask 的 padding 完整包住，框外沒有它的延續。
    """
    import cv2
    import numpy as np

    height, width = base.shape[:2]
    filled = np.zeros((height + 2, width + 2), dtype=np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    tolerance = (FLOOD_TOLERANCE,) * 3
    count, labels, stats, _ = cv2.connectedComponentsWithStats(region, connectivity=8)
    for index in range(1, count):
        x, y = stats[index, cv2.CC_STAT_LEFT], stats[index, cv2.CC_STAT_TOP]
        w, h = stats[index, cv2.CC_STAT_WIDTH], stats[index, cv2.CC_STAT_HEIGHT]
        y0, y1 = max(0, y - HALO), min(height, y + h + HALO)
        x0, x1 = max(0, x - HALO), min(width, x + w + HALO)
        # 種子只取 region == 0 的像素：相鄰文字框內的字不會被誤當成背景樣本。
        outside = region[y0:y1, x0:x1] == 0
        if not outside.any():
            continue
        seed_y, seed_x = np.nonzero(outside)
        for k in range(0, len(seed_y), SEED_STEP):
            py, px = int(seed_y[k]) + y0, int(seed_x[k]) + x0
            if filled[py + 1, px + 1]:
                continue
            cv2.floodFill(base, filled, (px, py), 0, tolerance, tolerance, flags)
    return filled[1:-1, 1:-1] > 0


def ink_mask(base, region):
    """要抹掉的字墨：遮罩內、背景蔓延不到的像素。膨脹後夾回遮罩，框外保證零改動。"""
    import cv2
    import numpy as np

    background = background_by_flood(base, region)
    ink = ((region > 0) & ~background).astype(np.uint8) * 255
    kernel = np.ones((DILATE_KERNEL_SIZE, DILATE_KERNEL_SIZE), dtype=np.uint8)
    ink = cv2.dilate(ink, kernel, iterations=DILATE_ITERATIONS)
    ink &= region * 255
    return ink


def _bridge_axis(base, ink):
    """逐列掃描抹除帶，回傳 (插值顏色, 兩端色差)；色差 255 代表該像素不可橋接。"""
    import numpy as np

    fill = np.zeros_like(base)
    score = np.full(base.shape[:2], 255, dtype=np.int16)
    mask = ink > 0
    width = base.shape[1]
    for y in range(base.shape[0]):
        row = mask[y]
        if not row.any():
            continue
        edges = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
        for x0, x1 in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1):
            span = x1 - x0 + 1
            if span > BRIDGE_MAX_GAP or x0 - BRIDGE_PROBE < 0 or x1 + BRIDGE_PROBE + 1 > width:
                continue
            left_slice = slice(x0 - BRIDGE_PROBE, x0)
            right_slice = slice(x1 + 1, x1 + 1 + BRIDGE_PROBE)
            if mask[y, left_slice].any() or mask[y, right_slice].any():
                continue
            left = np.median(base[y, left_slice], axis=0)
            right = np.median(base[y, right_slice], axis=0)
            delta = int(np.abs(left - right).max())
            if delta > BRIDGE_TOLERANCE:
                continue
            ramp = (np.arange(span, dtype=np.float32) + 0.5)[:, None] / span
            fill[y, x0 : x1 + 1] = np.clip(left * (1 - ramp) + right * ramp, 0, 255)
            score[y, x0 : x1 + 1] = delta
    return fill, score


def bridge_lines(base, ink, filled):
    """把被文字蓋住的水平／垂直線接回來。

    線被文字覆蓋的那一段在輸入影像裡根本不存在，inpaint 只會留下缺口。抹除帶兩端
    同色時沿該方向線性插值補回；兩端不同色（真的是不同內容）就保留 inpaint 結果。
    """
    import numpy as np

    horizontal_fill, horizontal_score = _bridge_axis(base, ink)
    vertical_fill, vertical_score = _bridge_axis(
        np.transpose(base, (1, 0, 2)).copy(), ink.T.copy()
    )
    vertical_fill = np.transpose(vertical_fill, (1, 0, 2))
    vertical_score = vertical_score.T
    out = filled.copy()
    inked = ink > 0
    use_horizontal = (horizontal_score <= vertical_score) & (horizontal_score < 255) & inked
    use_vertical = (vertical_score < horizontal_score) & (vertical_score < 255) & inked
    out[use_horizontal] = horizontal_fill[use_horizontal]
    out[use_vertical] = vertical_fill[use_vertical]
    return out


def erase_text(base, region):
    import cv2

    ink = ink_mask(base, region)
    filled = cv2.inpaint(base, ink, INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return bridge_lines(base, ink, filled)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: local_inpaint.py BASE_PNG MASK_PNG OUTPUT_PNG")
    base_path, mask_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    import cv2

    base = cv2.imread(base_path, cv2.IMREAD_COLOR)
    if base is None:
        raise SystemExit(f"failed to read base image: {base_path}")
    mask = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
    if mask is None:
        raise SystemExit(f"failed to read mask image: {mask_path}")

    region = read_region(mask, base.shape[:2])
    if not region.any():
        raise SystemExit("mask contains no opaque region to inpaint")

    result = erase_text(base, region)
    if not cv2.imwrite(output_path, result):
        raise SystemExit(f"failed to write output image: {output_path}")


if __name__ == "__main__":
    main()
