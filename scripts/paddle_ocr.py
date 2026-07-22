#!/usr/bin/env python3
"""Small JSON adapter around PaddleOCR. Stdout is reserved for machine JSON."""
import contextlib
import io
import json
import os
import sys


def load_engine():
    # PP-OCRv6（paddleocr>=3.7）：層級 tiny/small/medium，偵測與辨識用同一層級。
    # medium（34.5M 參數）在 CPU 全解析度下實測 6–8 秒/頁，辨識比 v5 server 高 5.1%，
    # 空格／全形分隔線／繁體輸出顯著改善，故為預設。v5 時代的 mobile/hybrid/server
    # 舊值映射到對應層級以保持向後相容。兩個環境變數皆由 apps/server/src/config.ts
    # 在啟動時驗證後傳入；此處再驗一次以涵蓋直接執行本腳本的情況。
    legacy = {"mobile": "small", "hybrid": "medium", "server": "medium"}
    tier = os.environ.get("SLIDE_MAKER_OCR_MODEL_TIER", "medium")
    tier = legacy.get(tier, tier)
    if tier not in ("tiny", "small", "medium"):
        raise SystemExit(f"SLIDE_MAKER_OCR_MODEL_TIER must be tiny, small, or medium (got {tier!r})")
    raw_side_len = os.environ.get("SLIDE_MAKER_OCR_DET_SIDE_LEN", "1920")
    if not raw_side_len.isdigit() or not 512 <= int(raw_side_len) <= 4096:
        raise SystemExit(f"SLIDE_MAKER_OCR_DET_SIDE_LEN must be an integer between 512 and 4096 (got {raw_side_len!r})")
    rec_prefix = f"PP-OCRv6_{tier}"
    det_prefix = f"PP-OCRv6_{tier}"
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR
        return PaddleOCR(
            lang="ch", device="cpu",
            text_detection_model_name=f"{det_prefix}_det",
            text_recognition_model_name=f"{rec_prefix}_rec",
            # 投影片是 1920x1080：預設短邊 736 的縮圖會漏掉小字，改為最長邊 1920（不縮圖）。
            text_det_limit_side_len=int(raw_side_len),
            text_det_limit_type="max",
            # 放寬偵測門檻並加大外擴比例，減少淡色字漏抓與字緣被裁掉。
            text_det_thresh=0.25,
            text_det_box_thresh=0.45,
            text_det_unclip_ratio=1.8,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )


def normalize_prediction(prediction):
    boxes = []
    for item in prediction:
        payload = getattr(item, "json", item)
        if callable(payload):
            payload = payload()
        if isinstance(payload, str):
            payload = json.loads(payload)
        data = payload.get("res", payload) if isinstance(payload, dict) else {}
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        polygons = data.get("rec_polys", data.get("dt_polys", []))
        for text, score, polygon in zip(texts, scores, polygons):
            boxes.append({"text": str(text), "confidence": float(score),
                          "polygon": [[float(point[0]), float(point[1])] for point in polygon]})
    return boxes


def main():
    engine = load_engine()
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        print(json.dumps({"ok": True}))
        return
    if len(sys.argv) != 2:
        raise SystemExit("usage: paddle_ocr.py IMAGE_PATH")
    from PIL import Image
    with Image.open(sys.argv[1]) as image:
        width, height = image.size
    with contextlib.redirect_stdout(sys.stderr):
        prediction = engine.predict(input=sys.argv[1])
    print(json.dumps({"width": width, "height": height,
                      "boxes": normalize_prediction(prediction)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
