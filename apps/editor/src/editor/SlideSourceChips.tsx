import type { SourceAsset } from "@slide-maker/core";
import {
  countSourceSelection,
  sourceSelectionState,
  SOURCE_SELECTION_ACTION,
  SOURCE_SELECTION_ICON,
  SOURCE_SELECTION_LABEL,
  type SlideSourceSelection,
} from "../sourceSelection.js";

/**
 * 單頁來源的三態選取列。勾選代表「我指定」，AI 自己挑進來的另以虛線框與 ✦ 呈現。
 *
 * 狀態不只靠顏色：實心／虛線框線、✓／✦ 圖示，以及描述文字各自都說得清楚。
 * 狀態放在 aria-describedby 而不是 aria-label：可及名稱要穩定（它是使用者用來指稱這個
 * 控制項的詞），會變的狀態屬於描述。checkbox 在「AI 選用」時設 indeterminate
 * （對應 aria-checked="mixed"），讓螢幕閱讀器也讀得出「有在用，但不是我指定的」。
 *
 * groupId 用來把描述元素的 id 綁在所在頁面上——大綱步驟會為每一頁各畫一組同樣的晶片，
 * 只用 source.id 當 id 會在同一份文件裡重複。
 */
export function SlideSourceChips({
  groupId,
  sources,
  selection,
  disabled = false,
  // 側邊欄只有 330px，晶片橫排會擠成一堆兩三個字的碎片；改成一列一個，
  // 每顆佔滿欄寬，長檔名才有空間顯示。大綱確認頁的版面寬，維持橫排較省高度。
  layout = "inline",
  onToggle,
}: {
  groupId: string;
  sources: readonly SourceAsset[];
  selection: SlideSourceSelection;
  disabled?: boolean;
  layout?: "inline" | "stack";
  onToggle: (sourceId: string) => void;
}) {
  const counts = countSourceSelection(
    selection,
    sources.map((source) => source.id),
  );
  return (
    <div className="outline-sources">
      <span className="outline-sources-label">
        來源 · 我指定 {counts.pinned} · AI 選用 {counts.ai} / 共 {sources.length}
      </span>
      <div className={`outline-source-chips${layout === "stack" ? " chips-stacked" : ""}`}>
        {sources.map((source) => {
          const state = sourceSelectionState(selection, source.id);
          const stateLabel = SOURCE_SELECTION_LABEL[state];
          const action = SOURCE_SELECTION_ACTION[state];
          const descriptionId = `source-chip-state-${groupId}-${source.id}`;
          return (
            <label
              key={source.id}
              className={`source-chip source-chip-${state}`}
              title={`${source.name}（${stateLabel}）— ${action}`}
            >
              <input
                type="checkbox"
                disabled={disabled}
                checked={state === "pinned"}
                ref={(node) => {
                  if (node) node.indeterminate = state === "ai";
                }}
                aria-label={source.name}
                aria-describedby={descriptionId}
                onChange={() => onToggle(source.id)}
              />
              <span className="source-chip-check" aria-hidden="true">
                {SOURCE_SELECTION_ICON[state]}
              </span>
              <span className="source-chip-name">{source.name}</span>
              <span className="visually-hidden" id={descriptionId}>
                {stateLabel}，{action}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
