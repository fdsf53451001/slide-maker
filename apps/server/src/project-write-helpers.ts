import { z } from "zod";
import {
  presentationProjectSchema,
  type PresentationProject,
  type SlideSpec,
} from "@slide-maker/core";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

export function outlineSnapshot(slide: SlideSpec) {
  return {
    purpose: slide.purpose,
    content: slide.content,
    narrative: slide.narrative,
    layoutHint: slide.layoutHint,
    imagePrompt: slide.imagePrompt,
    sourceIds: [...slide.sourceIds],
    // 與 `jobs.ts` 的同名函式必須逐欄一致：一邊補了欄位而另一邊沒有，「編輯前的狀態」與
    // 「生成當時的狀態」就會少比一欄，橘框從此對那一欄失明。
    // （`routes/pdf-deck.ts` 還有第三份手寫的快照字面值，但那條路匯入的頁面沒有頁型，
    //   而它建頁面時用的是同一個字面值，兩者因此自洽。）
    pageType: slide.pageType,
  };
}

export function preserveCurrentOutlineSnapshot(slide: SlideSpec): void {
  const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
  if (version && !version.outlineSnapshot) {
    version.outlineSnapshot = outlineSnapshot(slide);
    // 快照補的是「這次編輯之前的狀態」，當時生效的指定要一起補，否則還原回這一版時
    // 指定會被當成從來不存在。
    version.pinnedSourceIds = [...slide.pinnedSourceIds];
  }
}

/**
 * 要回給前端的專案快照。
 *
 * 走一次 schema，讓回應與「等一下會寫進磁碟的那一份」逐欄一致。像
 * `pinnedSourceIds ⊆ sourceIds` 這種只在解析層強制的不變式，若回應直接 clone 尚未正規化
 * 的物件，前端就會短暫看到一個磁碟上並不存在的狀態。解析本身會產生全新的物件，因此
 * 同時取代了 structuredClone 的隔離作用。
 *
 * 這裡只跑 schema，`writeProject` 走的是 `parseProject`（schema 前面多一段舊資料遷移）。
 * 輸入必然是 `loadProject` 解析過的物件，遷移對它是 no-op，兩者結果因此相同；若日後新增
 * 的遷移會改動已解析物件，這裡要一起改成 `parseProject`，否則回應會與磁碟分歧。
 */
export function asPersisted(project: PresentationProject): PresentationProject {
  return presentationProjectSchema.parse(project);
}
