import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDialogA11y } from "../useDialogA11y.js";

export function ImageEditDialog({
  image,
  busy,
  supportsMask,
  onCancel,
  onSubmit,
}: {
  image: string;
  busy: boolean;
  supportsMask: boolean;
  onCancel: () => void;
  onSubmit: (instruction: string, maskDataUrl?: string) => void;
}) {
  type MaskPoint = { x: number; y: number };
  type MaskSelection = MaskPoint & { width: number; height: number };
  const [instruction, setInstruction] = useState("");
  const [selection, setSelection] = useState<MaskSelection>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape 已由 `Editor` 的集中式鏈處理（它有 `imageEditBusy` 守衛），這裡只補焦點。
  // 說明欄的 `autoFocus` 不會被搶走：hook 只在焦點還沒進到對話框裡時才主動聚焦。
  useDialogA11y(dialogRef, true);
  const dragStart = useRef<MaskPoint | undefined>(undefined);
  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>): MaskPoint | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    return {
      x: Math.max(
        0,
        Math.min(canvas.width, ((event.clientX - bounds.left) * canvas.width) / bounds.width),
      ),
      y: Math.max(
        0,
        Math.min(canvas.height, ((event.clientY - bounds.top) * canvas.height) / bounds.height),
      ),
    };
  };
  const drawSelection = (start: MaskPoint, end: MaskPoint): MaskSelection | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rectangle = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    setSelection(rectangle);
    return rectangle;
  };
  const beginSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!supportsMask) return;
    const point = canvasPoint(event);
    if (!point) return;
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawSelection(point, point);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragStart.current) return;
    const point = canvasPoint(event);
    if (point) drawSelection(dragStart.current, point);
  };
  const finishSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = dragStart.current;
    dragStart.current = undefined;
    if (!start) return;
    const point = canvasPoint(event);
    const rectangle = point ? drawSelection(start, point) : undefined;
    if (!rectangle || rectangle.width < 8 || rectangle.height < 8) clearMask();
  };
  const clearMask = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    dragStart.current = undefined;
    setSelection(undefined);
  };
  return (
    <div
      ref={dialogRef}
      className="image-edit-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="編輯當頁圖片"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <form
        className="image-edit-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!instruction.trim()) return;
          onSubmit(
            instruction.trim(),
            selection ? canvasRef.current?.toDataURL("image/png") : undefined,
          );
        }}
      >
        <header>
          <div>
            <span className="section-label">EDIT CURRENT IMAGE</span>
            <h2>修改當頁圖片</h2>
            <p>以目前版本為基礎修改，不會覆蓋舊版本。</p>
          </div>
          <button type="button" aria-label="關閉圖片編輯" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <div className={`image-mask-stage ${supportsMask ? "masking" : ""}`}>
          <img src={image} alt="目前頁面圖片" />
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            aria-label="圖片修改範圍"
            onPointerDown={beginSelection}
            onPointerMove={moveSelection}
            onPointerUp={finishSelection}
            onPointerCancel={clearMask}
          />
          {selection && (
            <div
              className="mask-selection-box"
              style={{
                left: `${selection.x / 9.6}%`,
                top: `${selection.y / 5.4}%`,
                width: `${selection.width / 9.6}%`,
                height: `${selection.height / 5.4}%`,
              }}
            />
          )}
          {supportsMask && !selection && <span>拖曳框選要修改的區域（不框選＝整張套用）</span>}
        </div>
        <label className="image-edit-instruction">
          修改說明
          <textarea
            aria-label="圖片修改說明"
            rows={3}
            autoFocus
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：只把右上角的機器人改成女性工程師，其他文字與排版保持不變"
          />
        </label>
        <div className="mask-controls">
          {supportsMask ? (
            <>
              <small>
                {selection
                  ? "框內可修改，框外保留原圖；可直接拖曳重選"
                  : "直接在圖上拖曳即可限定修改範圍"}
              </small>
              <button type="button" disabled={!selection} onClick={clearMask}>
                清除框選
              </button>
            </>
          ) : (
            <small>目前 Provider 不支援範圍編輯</small>
          )}
        </div>
        <div className="image-edit-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={busy || !instruction.trim()}>
            {busy ? "正在建立圖片編輯工作…" : "套用修改 →"}
          </button>
        </div>
      </form>
    </div>
  );
}
