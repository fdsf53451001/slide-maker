import {
  pageNumberLayout,
  pageNumberSlideLabel,
  type PresentationProject,
} from "@slide-maker/core";

/**
 * 系統合成的頁碼，畫在畫布與簡報模式的圖片之上。
 *
 * 幾何與文字都來自 core 的 `pageNumberLayout`，與匯出端是同一份計算，預覽才會與匯出落點一致。
 * 尺寸一律用容器查詢單位（外層是 `container-type: size` 的畫布）——畫布是縮放顯示的，
 * 寫死 px 會讓頁碼在小視窗變得比匯出結果大得多。
 *
 * 收的是 `order` 而不是「第幾個」：可見序號由 `pageNumberSlideLabel` 從整份 `slides` 算，
 * 這一端不得自行扣掉隱藏頁（那會變成第五份規則）。
 */
export function PageNumberOverlay({
  project,
  order,
}: {
  project: PresentationProject;
  order: number;
}) {
  const label = pageNumberSlideLabel(project.pageNumber, project.slides, order);
  if (!label) return null;
  const { width, height } = project.canvas;
  const { text, chip } = pageNumberLayout(project.pageNumber, project.canvas, label);
  return (
    <div className="page-number-layer">
      {chip && (
        <div
          className="page-number-chip"
          style={{
            left: `${(chip.x / width) * 100}%`,
            top: `${(chip.y / height) * 100}%`,
            width: `${(chip.width / width) * 100}%`,
            height: `${(chip.height / height) * 100}%`,
            borderRadius: `${(chip.radius / height) * 100}cqh`,
            background: chip.color,
            opacity: chip.opacity,
          }}
        />
      )}
      <div
        className="page-number-text"
        style={{
          left: `${(text.x / width) * 100}%`,
          top: `${(text.y / height) * 100}%`,
          width: `${(text.width / width) * 100}%`,
          height: `${(text.height / height) * 100}%`,
          justifyContent:
            text.align === "center" ? "center" : text.align === "right" ? "flex-end" : "flex-start",
          fontFamily: text.fontFamily,
          fontSize: `${(text.fontSize / height) * 100}cqh`,
          fontWeight: text.fontWeight,
          lineHeight: text.lineHeight,
          color: text.color,
          opacity: text.opacity,
        }}
      >
        {label}
      </div>
    </div>
  );
}
