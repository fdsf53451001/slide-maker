#!/usr/bin/env python3
"""OpenCV 本地抹字 inpaint：base 圖＋文字遮罩 → 去字背景圖。

用法：local_inpaint.py BASE_PNG MASK_PNG OUTPUT_PNG
機器輸出走「輸出檔案 + exit code」，stdout 不做協定；診斷訊息一律進 stderr。

背景／字墨的判定分三道，缺一都會有實測失效（見常數區的實驗依據）：
  1. 顏色蔓延：從遮罩框外取種子做容差 flood，走得進框內的顏色是背景。
  2. 顏色歸屬：走進來的顏色還必須出現在框外樣本裡（擋住柔邊低對比字沿梯度爬入）。
  3. 貫穿檢查：背景裡「不貫穿 halo」的非平坦色團塊，是被遮罩切到的字沿自身洩漏
     進來的，改判回墨。
接著把字墨小幅膨脹並夾回遮罩（框外零改動），Telea 修補，最後對兩端同色的抹除帶
做軸向橋接，接回被文字蓋住的線。
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
# 結構像素誤差 29.6 → 3.7、遮罩外被改動像素 13445 → 0、殘字 5.6 → 1.2。
# JPEG q95／q88／q75 往返後同樣領先，故不因壓縮雜訊放寬 FLOOD_TOLERANCE。
#
# FLOOD_TOLERANCE：flood 的逐鄰居容差，平坦底色用的下限。太大（≥10）會沿反鋸齒
# 爬進低對比文字造成殘字；太小（≤4）則連平坦底色的編碼雜訊都蔓延不過去。
FLOOD_TOLERANCE = 6
# 顆粒／照片背景的相鄰像素差本來就大於平坦底色，固定容差會讓整片背景蔓延不進去、
# 被當成墨抹平（σ=16 的顆粒實測損壞 38% 的乾淨區域）。改為每個遮罩各自估：取框外
# 背景相鄰差的中位數（平坦底色≈0，且框外少數幾條線與邊緣拉不動中位數）乘上係數，
# 夾在下限與 FLOOD_TOLERANCE_MAX 之間。上限只在顆粒背景生效——平坦底色估出來就是
# 下限，柔邊低對比字仍由第二道「顏色歸屬」擋著，不會因為這個上限爬回來。
FLOOD_NOISE_FACTOR = 1.5
FLOOD_TOLERANCE_MAX = 48
# 種子取樣間隔：沿遮罩框外每 3 個像素取一點，確保框外每種結構（底色、線、色塊）
# 都至少有一個種子。總 flood 工作量由影像面積封頂——flood mask 已標記處不會重入，
# 所以種子數量再多也不會變成 O(種子 × 面積)。
SEED_STEP = 3
# 框外取種子與取色樣本的環寬。
HALO = 10
# 顏色歸屬：把框外樣本量化成 32³ cube（每格 8 級）再膨脹 1 格（±8 容差）。少了
# 這道，柔邊文字（重新編碼／縮放過的投影片，邊緣 ramp ≤ 6 級/px）會讓 flood 直接
# 爬進字身，實測 σ=1.6 高斯模糊的灰字殘留 3637 px、σ=2.4 殘留 5363 px。
CUBE_BITS = 3
CUBE_DILATE = 1
# 貫穿檢查：遮罩若切在筆劃中間，字會從缺口沿自身蔓延成「背景」。真結構（軸線、
# 格線、邊框、色塊）在框外有本體，一路延伸到 ROI 外緣；洩漏的字團塊困在 ROI 內。
# 只檢查「跨過遮罩邊界、且與框外平坦底色差距超過門檻」的團塊：不跨邊界的排除掉
# 顆粒雜訊，門檻本身也會跟著顆粒程度放大（見 _flood_tolerance）。
LEAK_HALO = 20
LEAK_DELTA = 24
# 墨膨脹：ink 已精確到像素，只需 3×3 一次蓋住反鋸齒殘緣（舊版 7×7 兩次會外擴
# 6px，正是圖表線被抹斷的主因）。
DILATE_KERNEL_SIZE = 3
DILATE_ITERATIONS = 1
INPAINT_RADIUS = 3
# 軸向橋接：抹除帶兩端各取 BRIDGE_PROBE 像素的中位色，色差在 BRIDGE_TOLERANCE
# 內才視為「同一條線／同一片底色被文字截斷」並線性插值接回。超過 BRIDGE_MAX_GAP
# 的帶不是直接拒絕（整行標題壓在表格線上輕易就超過，硬拒等於那條線永遠接不回），
# 而是要自證承載結構——見 BRIDGE_STRUCTURE_MIN。
BRIDGE_MAX_GAP = 420
BRIDGE_PROBE = 4
BRIDGE_TOLERANCE = 12
# 沒有對手的插值要多一道把關：另一軸不能橋接（探針被鄰近抹除帶佔住）或這是寬帶時，
# 插值色至少要離框外底色這麼遠才准覆蓋 inpaint 結果。少了這道，被文字壓住的水平線
# 會被垂直方向的底色整條塗白（實測 400px 的線 100% 被塗掉）。
BRIDGE_STRUCTURE_MIN = 24
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


def _roi_bounds(stats, index, shape, halo):
    import cv2

    x, y = stats[index, cv2.CC_STAT_LEFT], stats[index, cv2.CC_STAT_TOP]
    w, h = stats[index, cv2.CC_STAT_WIDTH], stats[index, cv2.CC_STAT_HEIGHT]
    return (
        slice(max(0, y - halo), min(shape[0], y + h + halo)),
        slice(max(0, x - halo), min(shape[1], x + w + halo)),
    )


def _colour_cube(samples):
    """框外背景樣本的顏色集合，量化後膨脹 1 格當容差。"""
    import numpy as np

    cube = np.zeros((32, 32, 32), dtype=bool)
    quantised = (samples >> CUBE_BITS).astype(np.int32)
    cube[quantised[:, 0], quantised[:, 1], quantised[:, 2]] = True
    for _ in range(CUBE_DILATE):
        grown = cube.copy()
        for axis in range(3):
            grown |= np.roll(cube, 1, axis=axis)
            grown |= np.roll(cube, -1, axis=axis)
        cube = grown
    return cube


def _flood_tolerance(roi, outside):
    """依框外背景的顆粒程度決定 flood 容差。

    取相鄰像素差的中位數：平坦底色（含編碼雜訊）≈0，照片／顆粒背景則明顯大於零，
    而框外少數幾條線與邊緣拉不動中位數，所以不會因為框外有邊框就整個放寬。
    """
    import numpy as np

    if roi.shape[1] < 2:
        return FLOOD_TOLERANCE
    step = np.abs(np.diff(roi.astype(np.int16), axis=1)).max(axis=2)
    sample = step[outside[:, :-1] & outside[:, 1:]]
    if sample.size == 0:
        return FLOOD_TOLERANCE
    noise = int(np.median(sample) * FLOOD_NOISE_FACTOR)
    return max(FLOOD_TOLERANCE, min(FLOOD_TOLERANCE_MAX, noise))


def background_by_flood(base, region, labels, stats, count):
    """從遮罩框外蔓延、且顏色屬於框外樣本的像素＝背景。

    要保留的東西（底色、漸層、紋理、軸線、格線、邊框、色塊）在遮罩框外都有本體，
    顏色可以連續走進框內；文字被 textMask 的 padding 包住，框外沒有它的延續。
    """
    import cv2
    import numpy as np

    height, width = base.shape[:2]
    reached = np.zeros((height + 2, width + 2), dtype=np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    cubes = {}
    for index in range(1, count):
        rows, cols = _roi_bounds(stats, index, (height, width), HALO)
        # 種子只取 region == 0 的像素：相鄰文字框內的字不會被誤當成背景樣本。
        outside = region[rows, cols] == 0
        if not outside.any():
            continue
        roi = base[rows, cols]
        cubes[index] = _colour_cube(roi[outside])
        tolerance = (_flood_tolerance(roi, outside),) * 3
        seed_y, seed_x = np.nonzero(outside)
        for k in range(0, len(seed_y), SEED_STEP):
            y, x = int(seed_y[k]) + rows.start, int(seed_x[k]) + cols.start
            if reached[y + 1, x + 1]:
                continue
            cv2.floodFill(base, reached, (x, y), 0, tolerance, tolerance, flags)
    background = reached[1:-1, 1:-1] > 0
    for index, cube in cubes.items():
        ys, xs = np.nonzero((labels == index) & background)
        if len(ys) == 0:
            continue
        quantised = (base[ys, xs] >> CUBE_BITS).astype(np.int32)
        background[ys, xs] = cube[quantised[:, 0], quantised[:, 1], quantised[:, 2]]
    return background


def _outer_flat_colour(roi, roi_region, roi_background):
    """該遮罩框外的平坦底色（背景像素的中位色）；沒有框外背景可取樣時回 None。"""
    import numpy as np

    outer = roi_background & ~roi_region
    if not outer.any():
        return None
    return np.median(roi[outer], axis=0)


def flat_colour_map(base, region, background, labels, stats, count):
    """每個遮罩框內填上「該框外的平坦底色」，給橋接判斷哪一軸承載結構用。"""
    import numpy as np

    flat = np.zeros_like(base)
    height, width = base.shape[:2]
    for index in range(1, count):
        rows, cols = _roi_bounds(stats, index, (height, width), HALO)
        roi_region = labels[rows, cols] == index
        colour = _outer_flat_colour(base[rows, cols], roi_region, background[rows, cols])
        if colour is None:
            continue
        view = flat[rows, cols]
        view[roi_region] = colour
    return flat


def drop_leaked_ink(base, region, background, labels, stats, count):
    """遮罩切在筆劃中間時，字會從缺口沿自身蔓延成「背景」；把它判回墨。

    判準是「有沒有貫穿到 ROI 外緣」：真結構在框外有本體會一路延伸出去，洩漏的字
    只在邊界露出幾個像素、團塊主體困在 ROI 內。
    """
    import cv2
    import numpy as np

    height, width = base.shape[:2]
    for index in range(1, count):
        rows, cols = _roi_bounds(stats, index, (height, width), LEAK_HALO)
        roi = base[rows, cols]
        roi_region = labels[rows, cols] == index
        roi_background = background[rows, cols]
        flat = _outer_flat_colour(roi, roi_region, roi_background)
        if flat is None:
            continue
        # 顆粒背景本來就處處偏離底色，門檻要跟著顆粒程度放大，否則每一撮雜訊都會
        # 進入 suspect、再因為湊不出貫穿路徑而被當成洩漏抹掉。
        delta = max(LEAK_DELTA, _flood_tolerance(roi, ~roi_region))
        suspect = roi_background & (np.abs(roi.astype(np.int32) - flat).max(axis=2) > delta)
        if not suspect.any():
            continue
        total, components = cv2.connectedComponents(suspect.astype(np.uint8), connectivity=8)
        if total <= 1:
            continue
        edge = np.zeros(components.shape, dtype=bool)
        edge[0, :] = edge[-1, :] = True
        edge[:, 0] = edge[:, -1] = True
        spanning = np.zeros(total, dtype=bool)
        spanning[np.unique(components[edge])] = True
        spanning[0] = True
        # 洩漏一定是從遮罩外走進來的，團塊必須跨過遮罩邊界。少了這個條件，顆粒背景
        # 裡每一撮偏離底色的雜訊都會被當成洩漏抹掉（σ=16 實測 38% 的乾淨區域受損）。
        crosses = np.zeros(total, dtype=bool)
        crosses[np.unique(components[~roi_region])] = True
        crosses[0] = False
        leaked = (~spanning & crosses)[components] & roi_region
        if leaked.any():
            roi_background[leaked] = False
    return background


def ink_mask(base, region):
    """要抹掉的字墨：遮罩內、判不出背景的像素。膨脹後夾回遮罩，框外保證零改動。

    一併回傳 flat_colour_map()：橋接要靠它判斷哪一軸承載結構。
    """
    import cv2
    import numpy as np

    count, labels, stats, _ = cv2.connectedComponentsWithStats(region, connectivity=8)
    background = background_by_flood(base, region, labels, stats, count)
    if not background.any():
        # 遮罩塞滿整張圖時沒有任何背景可取樣，繼續走下去會原樣輸出並以 exit 0
        # 回報成功，呼叫端會把「還有字的原圖」存成去字背景。寧可明確失敗。
        raise SystemExit("mask leaves no background to sample: refusing to return the input")
    flat = flat_colour_map(base, region, background, labels, stats, count)
    background = drop_leaked_ink(base, region, background, labels, stats, count)
    ink = ((region > 0) & ~background).astype(np.uint8) * 255
    kernel = np.ones((DILATE_KERNEL_SIZE, DILATE_KERNEL_SIZE), dtype=np.uint8)
    ink = cv2.dilate(ink, kernel, iterations=DILATE_ITERATIONS)
    ink &= region * 255
    return ink, flat


def _bridge_axis(base, ink):
    """逐列掃描抹除帶，回傳 (插值顏色, 兩端色差, 是否為寬帶)。

    色差 255 代表該像素不可橋接；寬帶（超過 BRIDGE_MAX_GAP）不是直接拒絕，而是
    交給呼叫端要求它自證承載結構——整行標題壓在表格線上時，抹除帶輕易就超過上限，
    硬拒會讓那條線永遠接不回來。
    """
    import numpy as np

    fill = np.zeros_like(base)
    score = np.full(base.shape[:2], 255, dtype=np.int16)
    wide = np.zeros(base.shape[:2], dtype=bool)
    mask = ink > 0
    width = base.shape[1]
    for y in range(base.shape[0]):
        row = mask[y]
        if not row.any():
            continue
        edges = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
        for x0, x1 in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1):
            span = x1 - x0 + 1
            if x0 - BRIDGE_PROBE < 0 or x1 + BRIDGE_PROBE + 1 > width:
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
            if span > BRIDGE_MAX_GAP:
                wide[y, x0 : x1 + 1] = True
    return fill, score, wide


def bridge_lines(base, ink, inpainted, flat):
    """把被文字蓋住的水平／垂直線接回來。

    線被文字覆蓋的那一段在輸入影像裡根本不存在，inpaint 只會留下缺口。抹除帶兩端
    同色時沿該方向線性插值補回；兩端不同色（真的是不同內容）就保留 inpaint 結果。

    兩軸都可橋接時（水平兩端是底色、垂直兩端是線色，兩者的端點色差都是 0），選
    「插值色離框外平坦底色較遠」的那一軸：承載結構的軸給的是線色，另一軸給的是
    底色。參考點必須是底色而不是 inpaint 結果——Telea 在抹除帶邊緣本來就會擴散出
    正確的線色，拿它當參考會讓帶子兩端的判斷反過來。固定偏好水平則會讓垂直線
    （表格欄線、圖表 Y 軸、卡片「｜」分隔線）整段被底色蓋掉。
    """
    import numpy as np

    horizontal_fill, horizontal_score, horizontal_wide = _bridge_axis(base, ink)
    vertical_fill, vertical_score, vertical_wide = _bridge_axis(
        np.transpose(base, (1, 0, 2)).copy(), ink.T.copy()
    )
    vertical_fill = np.transpose(vertical_fill, (1, 0, 2))
    vertical_score = vertical_score.T
    vertical_wide = vertical_wide.T
    inked = ink > 0
    horizontal_ok = (horizontal_score < 255) & inked
    vertical_ok = (vertical_score < 255) & inked
    reference = flat.astype(np.int16)
    horizontal_structure = np.abs(horizontal_fill.astype(np.int16) - reference).max(axis=2)
    vertical_structure = np.abs(vertical_fill.astype(np.int16) - reference).max(axis=2)
    both = horizontal_ok & vertical_ok
    # 沒有對手的插值不可信：另一軸不能橋接（探針被鄰近抹除帶佔住），或這一軸是寬帶
    # （兩端同色也可能只是巧合）時，它若給的只是底色，就會把垂直於它的線整條塗掉。
    # 這兩種情況下要自己證明「承載結構」（插值色明顯不同於框外底色）才准覆蓋。
    confident_h = horizontal_structure >= BRIDGE_STRUCTURE_MIN
    confident_v = vertical_structure >= BRIDGE_STRUCTURE_MIN
    eligible_h = horizontal_ok & (both & ~horizontal_wide | confident_h)
    eligible_v = vertical_ok & (both & ~vertical_wide | confident_v)
    out = inpainted.copy()
    use_horizontal = eligible_h & (~eligible_v | (horizontal_structure >= vertical_structure))
    use_vertical = eligible_v & (~eligible_h | (vertical_structure > horizontal_structure))
    out[use_horizontal] = horizontal_fill[use_horizontal]
    out[use_vertical] = vertical_fill[use_vertical]
    return out


def erase_text(base, region):
    import cv2

    ink, flat = ink_mask(base, region)
    inpainted = cv2.inpaint(base, ink, INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return bridge_lines(base, ink, inpainted, flat)


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
