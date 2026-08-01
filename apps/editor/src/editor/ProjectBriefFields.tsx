import type { PresentationBrief, PresentationProject, StylePreset } from "@slide-maker/core";
import { api } from "../api.js";
import { confirmStyleReplacement, styleOptions } from "./projectHelpers.js";

/**
 * 專案面板的 PROJECT BRIEF 八個欄位與風格下拉。
 *
 * 八個欄位改的是**本地草稿**，要按「儲存 Brief」才送出（那顆按鈕在呼叫端）；風格則是
 * 選了就立刻套用，所以它自己帶 `confirmStyleReplacement` 的確認。
 */
export function ProjectBriefFields({
  briefDraft,
  onBriefDraft,
  styles,
  styleSnapshot,
  projectId,
  run,
}: {
  briefDraft: PresentationBrief;
  onBriefDraft: (brief: PresentationBrief) => void;
  // 不是 `readonly`：`confirmStyleReplacement()`／`styleOptions()` 收的是可變陣列。
  styles: StylePreset[];
  styleSnapshot: PresentationProject["styleSnapshot"];
  projectId: string;
  run: (operation: () => Promise<PresentationProject>) => Promise<PresentationProject | undefined>;
}) {
  return (
    <>
      <div className="inspector-heading">
        <span>PROJECT BRIEF</span>
      </div>
      <label>
        主題
        <input
          value={briefDraft.topic}
          onChange={(event) => onBriefDraft({ ...briefDraft, topic: event.target.value })}
        />
      </label>
      <label>
        目標觀眾
        <input
          value={briefDraft.audience}
          onChange={(event) => onBriefDraft({ ...briefDraft, audience: event.target.value })}
        />
      </label>
      <label>
        目的
        <input
          value={briefDraft.purpose}
          onChange={(event) => onBriefDraft({ ...briefDraft, purpose: event.target.value })}
        />
      </label>
      <label>
        語言
        <input
          value={briefDraft.language}
          onChange={(event) => onBriefDraft({ ...briefDraft, language: event.target.value })}
        />
      </label>
      <label>
        頁數
        <input
          type="number"
          min={1}
          max={100}
          value={briefDraft.desiredSlideCount}
          onChange={(event) =>
            onBriefDraft({ ...briefDraft, desiredSlideCount: Number(event.target.value) })
          }
        />
      </label>
      <label>
        語氣
        <input
          value={briefDraft.tone}
          onChange={(event) => onBriefDraft({ ...briefDraft, tone: event.target.value })}
        />
      </label>
      <label>
        內容模式
        <select
          value={briefDraft.contentMode}
          onChange={(event) =>
            onBriefDraft({
              ...briefDraft,
              contentMode: event.target.value as PresentationBrief["contentMode"],
            })
          }
        >
          <option value="creative">Creative</option>
          <option value="grounded">Grounded</option>
        </select>
      </label>
      <label>
        風格
        <select
          value={styleSnapshot.id}
          onChange={(event) => {
            if (!confirmStyleReplacement(styles, styleSnapshot, event.target.value)) return;
            void run(() => api.applyStyle(projectId, event.target.value));
          }}
        >
          {styleOptions(styles, styleSnapshot)}
        </select>
      </label>
    </>
  );
}
