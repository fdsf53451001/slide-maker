import {
  designSystemTonalRegister,
  isProjectLocalStyle,
  STYLE_NAME_MAX_LENGTH,
  type PresentationProject,
  type StylePreset,
  type TonalRegister,
} from "@slide-maker/core";
import { imageUrl } from "../api.js";

/**
 * 風格庫頁「AI 產生」區的資料來源：各專案自己那份、**風格庫查不到**的設計系統。
 *
 * 純前端推導，不新增端點：`GET /api/projects` 本來就把每份 `project.json` 整份載入解析
 * （儀表板的專案清單現在就在付這個成本），而判斷條件只用得到 `styleSnapshot` 與 `slides`
 * 兩個已經在手上的欄位。
 *
 * **這一區是唯讀衍生視圖**：它列出來的東西不會、也不可以被寫回風格庫。那些風格的 id 是
 * `projectStyleId()`，而它必須查不到才活得下去（見 `packages/core/src/project-style.ts`）；
 * 唯一的寫入動作是「複製一份**新 id** 的到風格庫」，原專案的指向一個字都不動。
 *
 * @module
 */

/** 這份設計系統是打哪來的。三種都要顯示得出來——漏掉一種等於那張卡片沒有來源標籤。 */
export type AiStyleOrigin = "reference-images" | "style-direction" | "unknown";

export const AI_STYLE_ORIGIN_LABELS: Record<AiStyleOrigin, string> = {
  "reference-images": "參考圖分析",
  "style-direction": "AI 自由設計決議",
  // 兩者皆非：這個欄位存在之前分析出來的舊資料。不知道來源不等於可以不標，
  // 沒有標籤的卡片會讓人以為它與旁邊那些是同一種東西。
  unknown: "AI 產生",
};

export interface AiStyleEntry {
  project: PresentationProject;
  /** 就是 `project.styleSnapshot`，只是取個名字讓呼叫端不必再想一次它為什麼在專案裡。 */
  style: StylePreset;
  origin: AiStyleOrigin;
  /** 設計系統有鎖明暗登記時才有值；舊格式沒有那一行就是 `undefined`（不猜，見 core 的註解）。 */
  tonalRegister?: TonalRegister;
  /** 第一張「已經生成出圖」的可見頁；一張都沒有時是 `undefined`，卡片退回純文字。 */
  cover?: string;
}

/**
 * 縮圖取「第一張**有圖的**可見頁」，而不是死抓第一張可見頁。
 *
 * 這張圖是這套風格唯一的實際證據（比任何色塊示意都準），而使用者常常先生成中間某幾頁再
 * 回頭補封面——只認第 1 頁的話，一份已經畫出十頁的簡報會顯示成「尚未生成任何頁面」。
 * 隱藏頁一律不算：它不上場，拿它代表整份簡報的長相是錯的。
 */
function coverImage(project: PresentationProject): string | undefined {
  for (const slide of project.slides) {
    if (slide.hidden) continue;
    const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
    if (version) return imageUrl(project.id, version.imagePath);
  }
  return undefined;
}

function originOf(project: PresentationProject): AiStyleOrigin {
  // 參考圖分析與「AI 自由設計」的風格決議互斥（後者不會寫參考圖，前者寫回時會把
  // `styleDirection` 刪掉），所以這裡不會兩個都成立；順序仍照「有實體證據的優先」。
  if (project.styleSnapshot.referenceImages.length > 0) return "reference-images";
  if (project.styleDirection?.applied === true) return "style-direction";
  return "unknown";
}

/**
 * 依 `updatedAt` 由新到舊，與上方專案清單一致。
 *
 * 只收**真的有設計系統**的專案：`styleSnapshot` fork 成專案本地 id 的路徑不只一條
 * （改個風格名也會 fork），而一張只能複製出空設計系統的卡片對使用者沒有任何用處，
 * 卻會讓這一區看起來像「所有專案都在這」。
 */
export function aiStyleEntries(projects: readonly PresentationProject[]): AiStyleEntry[] {
  return projects
    .filter((project) => isProjectLocalStyle(project) && project.styleSnapshot.designSystem.trim())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((project) => {
      const tonalRegister = designSystemTonalRegister(project.styleSnapshot.designSystem);
      const cover = coverImage(project);
      return {
        project,
        style: project.styleSnapshot,
        origin: originOf(project),
        ...(tonalRegister ? { tonalRegister } : {}),
        ...(cover ? { cover } : {}),
      };
    });
}

/** 複本名稱裡至少要留給風格名的字數；不足就整段捨棄後綴。 */
const MIN_STYLE_NAME_ROOM = 4;

/**
 * 複本的名稱：帶上來源專案，讓風格庫裡分辨得出這一份是從哪裡來的。
 *
 * 一定要自己裁到 `STYLE_NAME_MAX_LENGTH`：專案名的上限是 200 字，接上去輕易就超過風格名的
 * 120 字，而超過的下場是伺服器 400——使用者看到的是「按了沒反應」。
 */
export function styleLibraryCopyName(styleName: string, projectName: string): string {
  const suffix = `（來自 ${projectName}）`;
  const room = STYLE_NAME_MAX_LENGTH - suffix.length;
  const base =
    room >= MIN_STYLE_NAME_ROOM
      ? `${styleName.slice(0, room)}${suffix}`
      : styleName.slice(0, STYLE_NAME_MAX_LENGTH);
  return base.trim() || "AI 設計系統";
}

/**
 * `POST /api/styles` 的 body。
 *
 * **絕不帶 `id`**：風格庫裡永遠不可以出現 `pdf-style-*`，那是專案本地風格活得下去的唯一
 * 前提（風格庫查得到它，`refreshStyleForGeneration()` 就會在下一次生成前把它整包蓋掉）。
 * 伺服器的 `stylePresetInputSchema` 本來就把 `id` omit 掉、一律發新的 uuid，這裡不送只是
 * 讓「不可以」在送出的那一刻就成立，而不是靠對面幫忙擋。
 *
 * `referenceImages` 明寫空陣列而不是省略：**這份複本刻意不帶參考圖**。原專案那批圖的資產
 * 歸原專案所有——`ownedStyleReferences()` 認的就是「`styleSnapshot.id` 是專案本地 id」，
 * 而這一區列出來的每一份都滿足它，所以使用者一按「重新分析」或換一個風格，那些 asset 就會
 * 被 `deleteReference()` 真的刪掉，共用 id 的複本從此指向不存在的檔案（下一次編輯它會被
 * `STYLE_REFERENCE_INVALID` 擋下，畫面上則是破圖）。要安全共用只能重新上傳一份位元組，
 * 那是前端跨 N 張圖、沒有交易的多步驟寫入，中途失敗就在 `styles/assets` 留下沒有主的孤兒
 * ——這個專案已經為同一件事付過代價（見 `api.analyseProjectStyle` 的註解）。UI 上明講。
 */
export function styleLibraryCopyInput(entry: AiStyleEntry) {
  const { style, project } = entry;
  return {
    name: styleLibraryCopyName(style.name, project.name),
    description: style.description,
    density: style.density,
    imageDirection: style.imageDirection,
    avoid: [...style.avoid],
    promptTemplate: style.promptTemplate,
    designSystem: style.designSystem,
    referenceImages: [],
  } satisfies Partial<StylePreset> & { name: string };
}
