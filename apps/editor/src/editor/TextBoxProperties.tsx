import {
  TEXT_STROKE_DEFAULT_COLOR,
  TEXT_STROKE_DEFAULT_OPACITY,
  TEXT_STROKE_DEFAULT_WIDTH_EM,
  TEXT_STROKE_MAX_WIDTH_EM,
  type EditableTextBox,
} from "@slide-maker/core";
import { TextEffectRow } from "../TextEffectRow.js";
import { TEXT_BACKGROUND_DEFAULT_COLOR } from "./textBoxModel.js";

/**
 * 選中文字框的樣式編輯面板。
 *
 * 寫入一律經由 `onPatch`／`onClearBackground`／`onClearStroke`（都是 `useTextLayerEditing`
 * 的唯一變更入口），這裡不持有任何狀態——「現在打開的是哪一組效果下拉」也是外面那份，
 * 因為底色與描邊互斥地只能開一個。
 *
 * 「沒有選取文字框時整塊不出現」的條件與理由留在呼叫端（`Editor.tsx`），這裡只負責畫。
 */
export function TextBoxProperties({
  selectedText,
  openTextEffect,
  onOpenTextEffect,
  onPatch,
  onClearBackground,
  onClearStroke,
}: {
  selectedText: EditableTextBox;
  openTextEffect: "background" | "stroke" | undefined;
  onOpenTextEffect: (effect: "background" | "stroke" | undefined) => void;
  onPatch: (patch: Partial<EditableTextBox>) => void;
  onClearBackground: () => void;
  onClearStroke: () => void;
}) {
  return (
    <div className="text-properties fields">
      <div className="section-label">TEXT BOX</div>
      <div className="text-property-grid font-row">
        <label>
          字體
          <input
            value={selectedText.fontFamily}
            onChange={(event) => onPatch({ fontFamily: event.target.value })}
          />
        </label>
        <label>
          大小
          <input
            type="number"
            min="6"
            max="300"
            value={selectedText.fontSize}
            onChange={(event) => onPatch({ fontSize: Number(event.target.value) })}
          />
        </label>
        <label>
          字重
          <select
            value={selectedText.fontWeight}
            onChange={(event) => onPatch({ fontWeight: Number(event.target.value) })}
          >
            <option value="400">一般</option>
            <option value="600">半粗</option>
            <option value="700">粗體</option>
            <option value="900">黑體</option>
          </select>
        </label>
      </div>
      <div className="text-property-grid detail-row">
        <label>
          顏色
          <input
            type="color"
            value={selectedText.color}
            onChange={(event) => onPatch({ color: event.target.value })}
          />
        </label>
        <label>
          對齊
          <select
            value={selectedText.align}
            onChange={(event) =>
              onPatch({
                align: event.target.value as EditableTextBox["align"],
              })
            }
          >
            <option value="left">靠左</option>
            <option value="center">置中</option>
            <option value="right">靠右</option>
          </select>
        </label>
        <label>
          行高
          <input
            type="number"
            min="0.8"
            max="3"
            step="0.1"
            value={selectedText.lineHeight}
            onChange={(event) => onPatch({ lineHeight: Number(event.target.value) })}
          />
        </label>
        <label>
          字距
          <input
            type="number"
            min="-10"
            max="30"
            step="0.5"
            value={selectedText.letterSpacing}
            onChange={(event) => onPatch({ letterSpacing: Number(event.target.value) })}
          />
        </label>
      </div>
      {/*
        底色與描邊：各是**勾選框開關 ＋ 旁邊一顆下拉**，參數收在下拉裡，兩組再併成
        同一排。攤開就是兩個三四欄的 grid、佔掉面板約 150px，而它們是偶爾才調一次的
        東西；縮成一顆下拉之後每組只剩約 95px 寬，一排放得下兩組，再拆成兩排等於白
        吃掉一整行。
        「有沒有套」由勾選框本身講清楚，現在是什麼顏色則直接畫在觸發鈕的色塊上，
        兩件事都不必打開下拉就看得到。細節與定位理由見 `TextEffectRow`。
      */}
      <div className="text-effect-rows">
        <TextEffectRow
          label="底色"
          enabled={Boolean(selectedText.backgroundColor)}
          swatchColor={selectedText.backgroundColor ?? TEXT_BACKGROUND_DEFAULT_COLOR}
          open={openTextEffect === "background"}
          onOpenChange={(next) => onOpenTextEffect(next ? "background" : undefined)}
          onEnabledChange={(next) => {
            if (!next) {
              onClearBackground();
              return;
            }
            onPatch({
              backgroundColor: TEXT_BACKGROUND_DEFAULT_COLOR,
              backgroundOpacity: 1,
            });
          }}
        >
          <label>
            色票
            <input
              type="color"
              aria-label="文字框底色"
              value={selectedText.backgroundColor ?? TEXT_BACKGROUND_DEFAULT_COLOR}
              onChange={(event) => onPatch({ backgroundColor: event.target.value })}
            />
          </label>
          <label>
            底色不透明度
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={selectedText.backgroundOpacity ?? 1}
              onChange={(event) => {
                // 數字框可以被清空或打進超界值；schema 只收 0–1，
                // 這裡先夾好再寫入，否則存檔時整批文字框會被伺服器擋下。
                // 清空／非數字一律保留原值：`Number("")` 是 0（而且是有限數），
                // 照寫回去等於底色無聲消失，勾選框卻還是勾的。
                const raw = event.target.value.trim();
                if (!raw) return;
                const next = Number(raw);
                if (!Number.isFinite(next)) return;
                onPatch({ backgroundOpacity: Math.min(1, Math.max(0, next)) });
              }}
            />
          </label>
        </TextEffectRow>
        {/* 描邊：形狀與上面那組底色一致（色彩欄位＝開關，其餘是它的參數）。
            刻意是**逐框**的可選項而不是專案級開關：白字壓在明暗不定的生成圖上時
            它是可讀性的解藥，但同一份簡報裡乾淨純色底的那幾頁套上去只會顯得髒。 */}
        <TextEffectRow
          label="描邊"
          enabled={Boolean(selectedText.strokeColor)}
          swatchColor={selectedText.strokeColor ?? TEXT_STROKE_DEFAULT_COLOR}
          open={openTextEffect === "stroke"}
          onOpenChange={(next) => onOpenTextEffect(next ? "stroke" : undefined)}
          onEnabledChange={(next) => {
            if (!next) {
              onClearStroke();
              return;
            }
            onPatch({
              strokeColor: TEXT_STROKE_DEFAULT_COLOR,
              strokeWidth: TEXT_STROKE_DEFAULT_WIDTH_EM,
              strokeOpacity: TEXT_STROKE_DEFAULT_OPACITY,
            });
          }}
        >
          <label>
            描邊色
            <input
              type="color"
              aria-label="文字描邊色"
              value={selectedText.strokeColor ?? TEXT_STROKE_DEFAULT_COLOR}
              onChange={(event) => onPatch({ strokeColor: event.target.value })}
            />
          </label>
          <label>
            {/* 單位是 em（字級的倍數），所以改字級時描邊會等比跟著走。 */}
            粗細（em）
            <input
              type="number"
              min="0"
              max={TEXT_STROKE_MAX_WIDTH_EM}
              step="0.01"
              aria-label="文字描邊粗細"
              value={selectedText.strokeWidth ?? TEXT_STROKE_DEFAULT_WIDTH_EM}
              onChange={(event) => {
                // 與底色不透明度同一套：清空／非數字保留原值，超界先夾再寫。
                const raw = event.target.value.trim();
                if (!raw) return;
                const next = Number(raw);
                if (!Number.isFinite(next)) return;
                onPatch({
                  strokeWidth: Math.min(TEXT_STROKE_MAX_WIDTH_EM, Math.max(0, next)),
                });
              }}
            />
          </label>
          <label>
            描邊不透明度
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              aria-label="文字描邊不透明度"
              value={selectedText.strokeOpacity ?? TEXT_STROKE_DEFAULT_OPACITY}
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (!raw) return;
                const next = Number(raw);
                if (!Number.isFinite(next)) return;
                onPatch({ strokeOpacity: Math.min(1, Math.max(0, next)) });
              }}
            />
          </label>
        </TextEffectRow>
      </div>
    </div>
  );
}
