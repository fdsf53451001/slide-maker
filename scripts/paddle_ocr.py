#!/usr/bin/env python3
"""Small JSON adapter around PaddleOCR. Stdout is reserved for machine JSON."""
import contextlib
import io
import json
import sys


def load_engine():
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR
        return PaddleOCR(
            lang="ch", device="cpu",
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
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
