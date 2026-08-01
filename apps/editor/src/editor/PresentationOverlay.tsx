import type { PresentationProject, SlideSpec } from "@slide-maker/core";
import { PageNumberOverlay } from "./PageNumberOverlay.js";

/**
 * 全螢幕放映的覆蓋層。
 *
 * 這裡是四條換頁路徑裡的第③（點擊舞台前進）與第④（控制列 ←／→）：兩者都只讀
 * `presentationPrev`／`presentationNext` 這兩個**算好的目標 index**，`undefined` 就代表
 * 沒有下一頁（按鈕 disabled、點舞台不動）。跳過隱藏頁的規則收斂在 `nextVisibleIndex`
 * 那唯一一份，這一端不得自己算。
 *
 * 進度「第幾頁 / 共幾頁」刻意**不套** `pageNumberSlideLabel()`：那份帶 `startAt`／
 * `skipFirstSlide`，是印在成品上的 chrome，而控制列是放映進度，必須從 1 數到可見頁數。
 */
export function PresentationOverlay({
  presentationSlide,
  presentationImage,
  presentationPrev,
  presentationNext,
  presentationPosition,
  visibleSlideCount,
  canvas,
  pageNumberProject,
  onPresentationIndex,
  onExit,
}: {
  presentationSlide: SlideSpec;
  presentationImage: string | undefined;
  presentationPrev: number | undefined;
  presentationNext: number | undefined;
  presentationPosition: number;
  visibleSlideCount: number;
  canvas: PresentationProject["canvas"];
  pageNumberProject: PresentationProject;
  onPresentationIndex: (index: number) => void;
  onExit: () => void;
}) {
  return (
    <div
      className="presentation-mode"
      role="dialog"
      aria-modal="true"
      aria-label="全螢幕簡報"
      onClick={() => {
        if (presentationNext !== undefined) onPresentationIndex(presentationNext);
      }}
    >
      <div className="presentation-surface">
        {presentationImage ? (
          // 頁碼要疊在「圖片實際佔到的那塊矩形」上，而不是整個 100vw×100vh 的舞台：
          // 圖片是 letterbox 置中的，兩者的比例不同時會差一整條黑邊。
          //
          // 尺寸顯式算出來，不用 aspect-ratio + max-width：這裡是 grid item，auto track
          // 依 max-content 撐大並溢出，`max-width` 夾不住，窄視窗下右側會被裁掉。
          // 長度單位取 `.presentation-surface` 的容器查詢單位而非 vw／vh，見 styles.css。
          <div
            className="presentation-stage"
            style={{
              width: `min(100cqw, calc(100cqh * ${canvas.width} / ${canvas.height}))`,
              height: `min(100cqh, calc(100cqw * ${canvas.height} / ${canvas.width}))`,
            }}
          >
            <img
              src={presentationImage}
              alt={`簡報第 ${presentationPosition} 頁`}
              draggable={false}
            />
            <PageNumberOverlay project={pageNumberProject} order={presentationSlide.order} />
          </div>
        ) : (
          <div className="presentation-empty">
            <strong>{presentationSlide.purpose}</strong>
            <span>這一頁尚未生成圖片</span>
          </div>
        )}
      </div>
      <div className="presentation-controls" onClick={(event) => event.stopPropagation()}>
        <button
          aria-label="上一頁"
          disabled={presentationPrev === undefined}
          onClick={() => {
            if (presentationPrev !== undefined) onPresentationIndex(presentationPrev);
          }}
        >
          ←
        </button>
        <span>
          {presentationPosition} / {visibleSlideCount}
        </span>
        <button
          aria-label="下一頁"
          disabled={presentationNext === undefined}
          onClick={() => {
            if (presentationNext !== undefined) onPresentationIndex(presentationNext);
          }}
        >
          →
        </button>
        <button className="presentation-close" aria-label="離開簡報模式" onClick={onExit}>
          ×
        </button>
      </div>
    </div>
  );
}
