#!/usr/bin/env python3
"""OpenCV 本地抹字 inpaint：base 圖＋文字遮罩 → 去字背景圖。

用法：local_inpaint.py BASE_PNG MASK_PNG OUTPUT_PNG
機器輸出走「輸出檔案 + exit code」，stdout 不做協定；診斷訊息一律進 stderr。
"""
import os
import sys

# 與 paddle_ocr.py 同一套 fd 紀律：OpenCV 原生層可能直接對 OS fd 1 printf
# （sys.stdout 層攔不到），在 import cv2 之前就把 fd 1 改道到 stderr，
# 保證任何原生輸出都不會污染呼叫端的 stdout。本腳本的機器輸出只有檔案與
# exit code，因此 dup 下來的原始 stdout 不再使用。
os.dup2(2, 1)

# ── 演算法常數（不要改值）──────────────────────────────────────────────
# 實驗依據（1920×1080 投影片、PaddleOCR 驗證：殘字 0、邊框／膠囊／分隔線完整保留）：
# 每個遮罩矩形內以灰階 ROI 的亮度眾數為背景值，偏離超過 INK_DELTA 視為字墨；
# 字墨遮罩整體以 7×7 全一 kernel 膨脹 2 次蓋住反鋸齒殘緣，再以 Telea 半徑 3 修補。
INK_DELTA = 22
DILATE_KERNEL_SIZE = 7
DILATE_ITERATIONS = 2
INPAINT_RADIUS = 3
# textMask 產物是「白色矩形＋透明底」的 RGBA PNG：alpha > 128 即為矩形區。
ALPHA_THRESHOLD = 128


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: local_inpaint.py BASE_PNG MASK_PNG OUTPUT_PNG")
    base_path, mask_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    import cv2
    import numpy as np

    base = cv2.imread(base_path, cv2.IMREAD_COLOR)
    if base is None:
        raise SystemExit(f"failed to read base image: {base_path}")
    mask = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
    if mask is None:
        raise SystemExit(f"failed to read mask image: {mask_path}")

    # 遮罩矩形區：RGBA 取 alpha；萬一遮罩沒有 alpha（不透明白矩形＋黑底）退回亮度。
    if mask.ndim == 3 and mask.shape[2] == 4:
        region_channel = mask[:, :, 3]
    elif mask.ndim == 3:
        region_channel = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    else:
        region_channel = mask
    if region_channel.shape[:2] != base.shape[:2]:
        region_channel = cv2.resize(
            region_channel, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_NEAREST
        )
    region = (region_channel > ALPHA_THRESHOLD).astype(np.uint8)
    if not region.any():
        raise SystemExit("mask contains no opaque region to inpaint")

    gray = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
    ink = np.zeros(gray.shape, dtype=np.uint8)
    # 逐個連通矩形取 ROI 亮度眾數當背景值——等價於實驗中的「每個遮罩矩形內」，
    # 且不需要另外重建矩形清單。
    count, labels, stats, _ = cv2.connectedComponentsWithStats(region, connectivity=8)
    for index in range(1, count):
        x, y, w, h = (
            stats[index, cv2.CC_STAT_LEFT],
            stats[index, cv2.CC_STAT_TOP],
            stats[index, cv2.CC_STAT_WIDTH],
            stats[index, cv2.CC_STAT_HEIGHT],
        )
        roi = gray[y : y + h, x : x + w]
        roi_region = labels[y : y + h, x : x + w] == index
        values = roi[roi_region]
        background = int(np.bincount(values, minlength=256).argmax())
        roi_ink = (np.abs(roi.astype(np.int16) - background) > INK_DELTA) & roi_region
        ink[y : y + h, x : x + w] |= roi_ink.astype(np.uint8) * 255

    kernel = np.ones((DILATE_KERNEL_SIZE, DILATE_KERNEL_SIZE), dtype=np.uint8)
    ink = cv2.dilate(ink, kernel, iterations=DILATE_ITERATIONS)
    result = cv2.inpaint(base, ink, INPAINT_RADIUS, cv2.INPAINT_TELEA)
    if not cv2.imwrite(output_path, result):
        raise SystemExit(f"failed to write output image: {output_path}")


if __name__ == "__main__":
    main()
