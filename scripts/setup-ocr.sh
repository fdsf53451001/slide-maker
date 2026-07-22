#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENV="$ROOT/.venv-ocr"
PYTHON=""
for CANDIDATE in python3.12 python3.11 python3.10 python3.9; do
  if command -v "$CANDIDATE" >/dev/null 2>&1; then PYTHON="$CANDIDATE"; break; fi
done
if [ -z "$PYTHON" ]; then
  printf '%s\n' "PaddleOCR requires Python 3.9–3.12. Install Python 3.12 and run this command again." >&2
  exit 1
fi

"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install "paddlepaddle==3.2.0" "paddleocr==3.7.0" "Pillow>=10,<12"
"$VENV/bin/python" "$ROOT/scripts/paddle_ocr.py" --self-test
touch "$VENV/.ready"

printf '%s\n' "OCR setup complete: $VENV"
