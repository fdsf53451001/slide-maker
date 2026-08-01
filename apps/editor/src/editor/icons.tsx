/**
 * 文字工具列的圖示。
 *
 * 一律用 inline SVG，不用 `↺`／`🗑` 這類符號字元：符號在不同平台會落到不同的 fallback
 * 字型（甚至變成彩色 emoji），同一排圖示的粗細與視覺大小就會對不齊——這個專案已經踩過
 * 一次跨機器字型 fallback 的坑。`currentColor` 讓 disabled 態沿用按鈕自己的文字色。
 */
export function TextToolIcon({ shape }: { shape: "add" | "delete" | "undo" | "redo" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/*
        新增／刪除是同一個「T」配右下角不同的角標，兩顆一看就是一組。
        刻意畫 T 而不是畫方框：方框配 ＋／✕ 在 15px 下會被讀成播放／停止鍵（實測比對過），
        T 則直接說明這顆按鈕動的是文字。
      */}
      {(shape === "add" || shape === "delete") && <path d="M3.2 4.6h7.6M7 4.6v7.6" />}
      {shape === "add" && <path d="M12 9.4v3.8M10.1 11.3h3.8" />}
      {shape === "delete" && <path d="M10.4 9.7l3.2 3.2M13.6 9.7l-3.2 3.2" />}
      {shape === "undo" && (
        <>
          <path d="M6.1 3.6 3.3 6.2l2.8 2.6" />
          <path d="M3.3 6.2h6a3.3 3.3 0 1 1 0 6.6H7.2" />
        </>
      )}
      {/* 重做＝復原的水平鏡射（箭頭在右、弧線往左繞），兩顆才會是明確的一對。 */}
      {shape === "redo" && (
        <>
          <path d="M9.9 3.6 12.7 6.2l-2.8 2.6" />
          <path d="M12.7 6.2h-6a3.3 3.3 0 1 0 0 6.6H8.8" />
        </>
      )}
    </svg>
  );
}

/**
 * 縮圖上「隱藏／取消隱藏這一頁」那顆按鈕的圖示。
 *
 * 與 {@link TextToolIcon} 同一套理由用 inline SVG：`◎`／`⊘`／`👁` 這類符號字元在不同平台
 * 會落到不同的 fallback 字型（`👁` 甚至會變成彩色 emoji），同一排三顆圖示鈕的粗細與視覺
 * 大小就對不齊——這個專案已經踩過一次跨機器字型 fallback 的坑。
 *
 * 眼睛的開闔跟著**目前狀態**走（睜眼＝這一頁會上場、劃掉＝已隱藏），與 Keynote／Figma
 * 的圖層可見性慣例一致；按鈕名稱則講的是**按下去會發生什麼**（`aria-label` 那邊），兩者
 * 分工不重疊。
 */
export function SlideVisibilityIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.4 8S3.8 3.9 8 3.9 14.6 8 14.6 8 12.2 12.1 8 12.1 1.4 8 1.4 8Z" />
      <circle cx="8" cy="8" r="2.1" />
      {/* 劃掉的斜線只在隱藏時出現：眼睛的輪廓不變，兩態才會被讀成同一顆按鈕的兩個狀態，
          而不是換了一顆別的按鈕。 */}
      {hidden && <path d="M2.6 13.4 13.4 2.6" />}
    </svg>
  );
}
