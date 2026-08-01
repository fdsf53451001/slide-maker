import { z } from "zod";
import {
  presentationProjectSchema,
  type PresentationProject,
  type SlideSpec,
} from "@slide-maker/core";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

/**
 * 專案本地風格 fork 的 id。
 *
 * **凡是把「只屬於這個專案」的東西寫進 `styleSnapshot` 的路徑，都必須先 fork 成這個 id。**
 * 理由不是命名整潔而是保命：`refreshStyleForGeneration()` 在每次生成前拿
 * `styles.get(styleSnapshot.id)` 比對版本，版本一不同就 `structuredClone(latest)` 整包蓋掉。
 * 風格庫裡沒有這個 id，那道同步因此查不到、也就蓋不掉。
 *
 * 留在庫裡的 id（例如 `ai-free-design`）只是「目前兩邊版本號剛好相同」在擋著，而那是巧合：
 * 使用者到風格庫改一次 `avoid` 就 version+1，下一次生成時專案專屬的那份設計系統會**靜默
 * 消失**——而且那時 `POST /outline` 已被 `OUTLINE_HAS_GENERATED_VERSIONS` 擋住，沒有復原
 * 路徑，前端也還顯示著 `styleDirection: {applied:true}`。
 *
 * 名字裡的 `pdf-` 是歷史包袱（第一個用它的是 PDF 匯入的分析頁），現在參考圖分析與
 * 「AI 自由設計」的風格決議共用同一個。**字串不可改**：既有專案的 `project.json` 存著它。
 */
export function projectStyleId(projectId: string): string {
  return `pdf-style-${projectId}`;
}

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
