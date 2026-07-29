import { sourceAttachesReferenceImage, type SourceAsset } from "@slide-maker/core";
import { IMAGE_DESCRIPTION_NOTICE } from "./image-description.js";
import { truncateAtBoundary } from "./sources.js";
import type { SqliteFtsRetriever } from "./retriever.js";
import { knownSourceContext, type SourceContextChunk } from "./source-context.js";

/**
 * 單頁大綱最多帶幾個 sourceIds。schema、JSON schema 與防禦性截斷共用，不得各寫一份。
 * 整份大綱與單頁重生兩條路都從這裡取。
 */
export const SLIDE_SOURCE_ID_LIMIT = 20;

/**
 * 每頁最多可以引用幾份「內容依據」與幾張「參考圖」。
 *
 * 兩個上限刻意分開：內容依據多一份只是多一段可寫的材料，參考圖多一張卻會直接進影像模型的
 * 請求（Gemini 的硬上限是 8 張）。2026-07-29 線上那份 20 頁專案每頁被灌進 12 張內容圖，
 * 整份因 `GEMINI_IMAGE_REFERENCES_LIMIT` 全數失敗。
 *
 * **3 張不保證一定送得出去**：`stylePresetSchema.referenceImages` 的上限是 4，所以最壞情況
 * 是一般生成 3+4=7（進得去），而遮罩編輯／抽字再加上 base 與 mask 就是 9 > 8——`jobs.ts` 的
 * `limitReferences()` 會照優先序砍掉 1 張內容圖並留下 log。那是刻意的取捨（風格圖決定整頁
 * 長得像不像這份簡報，資料圖少一張只是少一份佐證），不是漏算：這裡的 3 是「大綱最多**要求**
 * 幾張」，能不能全部送出由 provider 的宣告上限決定。
 */
export const OUTLINE_SLIDE_SOURCE_REF_LIMIT = 8;
export const OUTLINE_SLIDE_IMAGE_REF_LIMIT = 3;

/**
 * 階段 1 的來源目錄預算。
 *
 * 舊版寫死 `.slice(0, 100)`：線上那份專案有 108 份來源，最後 8 份在目錄裡根本不存在，模型
 * 沒有任何方式選到它們。份數不是成本，字元才是，所以改成字元預算。超出的那幾份跳過不列
 * （**跳過而不是就地停止**：後面若還有塞得下的短條目就繼續收，一份特別長的來源不會把
 * 整條尾巴一起帶走），並記下丟掉幾份（只記數字）。
 *
 * 每份 240 字。從 400 降下來是因為**那 400 字裡有一大半不是選源資訊**——實測 100 份圖片
 * 來源全部退回「截 extractedText」，每份開頭都是同一句 61 字元的聲明（合計 15% 的預算），
 * 剩下的還常常硬切在表格列中間。聲明改成整區共用一次、摘要改用結構化的 `metadata.summary`
 * 之後，240 字裝得下的實質資訊比原本的 400 字更多。
 *
 * 總預算 90000 是配合 `SOURCE_COUNT_LIMIT`（200 份）算的：200 ×（240 摘要 ＋ 約 55 檔名
 * ＋ 約 45 的 ref／kind／JSON 外框）≈ 68000，用掉 76%，剩下的餘裕留給更長的檔名。
 * 階段 1 的 prompt 因此約 90K 字元、CJK 下約 30K token——那是「一個專案放得下 200 份來源」
 * 必然要付的成本：目錄裝不下的來源，模型連選都選不到。
 */
export const OUTLINE_CATALOG_SUMMARY_CHARS = 240;
export const OUTLINE_CATALOG_CHAR_BUDGET = 90_000;

/**
 * 階段 2 的正文塊數預算。
 *
 * 每一塊截在 `SOURCE_CHUNK_CHARS`（1600 字），而階段 2 的 prompt 要一次扛下**每一頁**
 * 的片段。整份預算因此訂在「跨頁去重後的總塊數」上：96 塊 ≈ 15 萬字，與改動前單次 prompt
 * 的 40 塊加上百份目錄同一個量級，不會因為頁數變多就無上限地膨脹。
 *
 * 逐頁預算由總預算除以頁數得出，再夾在 5..12：
 *  - 下限 5——低於這個數，模型階段 1 挑的來源會有一半連一塊正文都拿不到（`knownSourceContext`
 *    的保底輪是每份來源各 1 塊），那等於階段 1 白挑。
 *  - 上限 12——單頁重生那條路用 40 塊寫**一頁**；整份路徑每頁再多也讀不完，只是把 prompt 撐大。
 *
 * 呼叫端會再把預算撐到「這一頁被指定的來源數」（仍夾在上限內），所以 96 是常態值而非硬上限：
 * 每頁都指定滿 12 份來源的極端情況下，跨頁去重前的上界是頁數 × 12。
 */
export const OUTLINE_DECK_CHUNK_BUDGET = 96;
export const OUTLINE_SLIDE_CHUNK_MIN = 5;
export const OUTLINE_SLIDE_CHUNK_MAX = 12;

export function outlineSlideChunkBudget(slideCount: number): number {
  const share = Math.ceil(OUTLINE_DECK_CHUNK_BUDGET / Math.max(1, slideCount));
  return Math.min(OUTLINE_SLIDE_CHUNK_MAX, Math.max(OUTLINE_SLIDE_CHUNK_MIN, share));
}

/**
 * 圖片來源摘要的**集體**出處聲明，兩個階段的 prompt 各講一次。
 *
 * 取代的是「每一份目錄條目都自帶一份 61 字元聲明」——150 份就是 9150 字元、15% 的目錄預算，
 * 而且沒有一個字幫得上選源。語意必須與被剝掉的那一句等價：kind 為 image 的來源，其 summary
 * 由視覺模型讀圖產生、不是圖內的原始文字、只供檢索與定位，引用其中數據前要以圖片本身為準。
 */
export function imageSummaryNotice(): string {
  return "Every source whose kind is image has a summary written by a vision model that read the picture. It is not the original text inside the image: it exists so you can find and place that image, and any figure quoted from it is unverified — the picture itself is the authority. The same applies to any excerpt marked as an AI image description.";
}

export interface OutlineCatalogEntry {
  /** `S1`…`Sn`。模型逐頁複製 36 字元的 UUID 是幻覺溫床，而且非常燒 token。 */
  ref: string;
  name: string;
  kind: "image" | "text";
  url?: string;
  summary: string;
}

export interface OutlineCatalog {
  entries: OutlineCatalogEntry[];
  /** 正規化過的 ref → 真正的 source id。對不上的 ref 一律丟棄，不猜。 */
  idByRef: Map<string, string>;
  refById: Map<string, string>;
  droppedCount: number;
}

/** 模型回來的 ref 可能帶空白或大小寫不一（`s1`、` S1 `）；比對前一律正規化。 */
function normalizeRef(ref: string): string {
  return ref.trim().toUpperCase();
}

/**
 * 把可用來源整理成階段 1 的目錄。
 *
 * `name` 一定要留：線上有一張圖的檔名是「…AWS Security Agent…安全防線_08.jpg」，它的
 * `extractedText` 卻整篇在講餐廳評分（那是 Agentic AI 的 demo 截圖）——這張圖與「AWS 資安」
 * 的唯一連結就在檔名。只給正文的目錄會讓它永遠檢索不到。
 */
/**
 * 剝掉圖片描述的出處聲明。剝不掉（不是圖片描述、或格式變了）就安靜沿用原字串。
 *
 * **只在目錄組裝時剝**：`source.extractedText` 自己的前綴是刻意設計的（使用者在來源詳情
 * 看到的就是那一句），一個字都不能動；階段 2 每一塊 excerpt 的短前綴同樣保留——chunk 是被
 * 單獨切出來餵進 prompt 的，標註必須跟著它走，而 96 塊 × 12 字元的成本可以忽略。
 * 目錄不一樣：150 份就是 150 次重複，卻只需要在 prompt 裡講一次（見 `imageSummaryNotice()`）。
 */
function withoutImageDescriptionNotice(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(IMAGE_DESCRIPTION_NOTICE)) return text;
  return trimmed.slice(IMAGE_DESCRIPTION_NOTICE.length).trimStart();
}

/**
 * 目錄裡「這一份來源長什麼樣」的那段字。
 *
 * 組法是**結構化摘要優先、不足再補正文**：
 *  - `metadata.summary` 是圖片描述寫回時存下的「標題＋一句話」（網頁來源則是搜尋摘要），
 *    密度遠高於截一段正文。
 *  - 補正文時先把與摘要重複的開頭扣掉（兩者同源，摘要就是正文的前兩段），否則同一句話會在
 *    同一個條目裡出現兩次，把省下來的預算又吃回去。
 *  - 切點交給 `truncateAtBoundary()`，不硬切在表格列中間。
 *
 * 換行刻意保留（只壓縮空白與連續空行）：markdown 表格與段落的邊界就是換行，全部壓成一行
 * 之後既看不出結構，也沒有邊界可切。
 */
function catalogSummary(source: SourceAsset): string {
  // 兩邊**必須套同一組正規化**：只壓縮 body 的連續空行時，摘要寫成兩段（vision 的指令就是
  // 「two or three sentences」）或前面掛個 markdown 標題，下面的 `startsWith` 就直接 false，
  // 去重整個失效——240 字的額度會有一半在講同一句話，正好是這批要消滅的浪費。
  const normalize = (text: string) =>
    text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  // 先切再正規化：`extractedText` 上限是 40 萬字，對它跑兩趟全字串 regex 只為了取前 240 字
  // 是白付的延遲與暫時字串。8 倍餘裕足以吸收前綴剝除與空白壓縮。
  const body = normalize(
    withoutImageDescriptionNotice(source.extractedText).slice(0, OUTLINE_CATALOG_SUMMARY_CHARS * 8),
  );
  // `||` 而非 `??`：手貼網址的來源沒有搜尋摘要，存下來的是空字串。用 `??` 的話模型只會被
  // 告知「有這個來源」卻看不到任何內容，等於這份目錄對它沒有作用。
  const structured = normalize(source.metadata.summary || "");
  if (!structured) return truncateAtBoundary(body, OUTLINE_CATALOG_SUMMARY_CHARS);
  const room = OUTLINE_CATALOG_SUMMARY_CHARS - structured.length - 1;
  if (room <= 0) return truncateAtBoundary(structured, OUTLINE_CATALOG_SUMMARY_CHARS);
  const rest = body.startsWith(structured) ? body.slice(structured.length).trimStart() : body;
  const topUp = truncateAtBoundary(rest, room);
  return topUp ? `${structured}\n${topUp}` : structured;
}

export function buildOutlineCatalog(sources: readonly SourceAsset[]): OutlineCatalog {
  const entries: OutlineCatalogEntry[] = [];
  const idByRef = new Map<string, string>();
  const refById = new Map<string, string>();
  let used = 0;
  let droppedCount = 0;
  for (const source of sources) {
    const ref = `S${entries.length + 1}`;
    const entry: OutlineCatalogEntry = {
      ref,
      name: source.name,
      // 影像來源要標出來，模型才知道哪些 ref 放得進 imageRefs。判準與 `jobs.ts` 附圖時
      // 同一份：只認 `visual-reference` 的話，使用者標成「原樣素材」（`direct-asset`）
      // 或風格參考的圖片會被標成 text，而兩個階段的 prompt 都明說「imageRefs 只能放 kind
      // 是 image 的 ref」——等於明文禁止模型附上那些圖，然後我們自己也忘了為什麼。
      kind: sourceAttachesReferenceImage(source.usage) ? "image" : "text",
      ...(source.metadata.url ? { url: source.metadata.url } : {}),
      summary: catalogSummary(source),
    };
    const cost = JSON.stringify(entry).length;
    if (used + cost > OUTLINE_CATALOG_CHAR_BUDGET) {
      droppedCount += 1;
      continue;
    }
    used += cost;
    entries.push(entry);
    idByRef.set(normalizeRef(ref), source.id);
    refById.set(source.id, ref);
  }
  return { entries, idByRef, refById, droppedCount };
}

export interface OutlineRefMapping {
  /** 對得上目錄的來源 id，依模型給的順序去重。 */
  ids: string[];
  /** 對上的 ref 筆數。**由這個函式自己回傳**：呼叫端另外數一次遲早會與這裡分歧。 */
  matched: number;
  returned: number;
}

/**
 * 把模型回的 ref 映射回 source id，對不上的一律丟棄。
 *
 * 回傳命中數而不只是 id 陣列，是因為「模型沒有 throw」不等於「它做了事」：回 `[]` 與回一整
 * 組幻覺 ref 都會 parse 成功，然後靜默走回「fallback 灌全部來源」——與整個兩階段沒跑長得
 * 一模一樣，只是換了個入口。呼叫端要靠 `matched` 分辨這兩件事並留下 log。
 */
export function mapOutlineRefs(
  refs: readonly string[],
  idByRef: ReadonlyMap<string, string>,
): OutlineRefMapping {
  const ids: string[] = [];
  let matched = 0;
  for (const ref of refs) {
    const id = idByRef.get(normalizeRef(ref));
    if (!id) continue;
    matched += 1;
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, matched, returned: refs.length };
}

export interface OutlineExcerpt {
  /** `C1`…`Cn`。逐頁的 `excerptRefs` 指過來，同一塊的正文在 prompt 裡只出現一次。 */
  ref: string;
  /** 這一塊來自目錄的哪一筆（`S3`）。目錄被字元預算截掉時沒有這個欄位。 */
  source?: string;
  name: string;
  url?: string;
  locator?: string;
  text: string;
}

/**
 * 把逐頁檢索到的片段攤成「一份去重的正文池 ＋ 每頁一串 ref」，並套上**全域**塊數上限。
 *
 * 兩件事只有合在一起才成立：
 *
 * ① **跨頁去重**——同一塊被三頁選中時 prompt 裡只出現一次，各頁以 ref 指過去。
 * ② **全域上限**——逐頁預算兼任不了總量控制：逐頁下限是 5，頁數一多總量就線性成長
 *    （60 頁約 48 萬字元、102 頁約 82 萬），而「讓各頁拿到不同來源」正是兩階段的目的，
 *    去重救不了。爆掉的形狀是 413／context overflow，而且發生在階段 1 已經燒掉配額之後。
 *
 * 配額用 **round-robin** 發（先給每頁第 1 塊、再第 2 塊……），不是照頁序一頁一頁發：
 * 後者會讓前幾頁吃光整份預算，排在後面的頁一塊正文都拿不到——那些頁只能靠 purpose 硬掰，
 * 而那正是這次改動要消滅的失敗形狀。
 *
 * 預算用完後仍可以引用「已經在 prompt 裡」的塊（那不會再多一個字），只是不再新增。
 */
export function allocateOutlineExcerpts(
  pages: readonly (readonly SourceContextChunk[])[],
  refOfSource: (sourceId: string) => string | undefined,
  budget = OUTLINE_DECK_CHUNK_BUDGET,
): { excerpts: OutlineExcerpt[]; pageRefs: string[][]; droppedChunks: number } {
  const excerpts: OutlineExcerpt[] = [];
  const refByKey = new Map<string, string>();
  const pageRefs: string[][] = pages.map(() => []);
  const droppedKeys = new Set<string>();
  const deepest = Math.max(0, ...pages.map((chunks) => chunks.length));
  for (let round = 0; round < deepest; round += 1) {
    for (const [order, chunks] of pages.entries()) {
      const chunk = chunks[round];
      if (!chunk) continue;
      const key = `${chunk.id} ${chunk.locator ?? ""} ${chunk.text}`;
      let ref = refByKey.get(key);
      if (!ref) {
        if (excerpts.length >= budget) {
          droppedKeys.add(key);
          continue;
        }
        ref = `C${excerpts.length + 1}`;
        const source = refOfSource(chunk.id);
        excerpts.push({
          ref,
          // 目錄被字元預算截掉的來源沒有 ref：省略這個欄位，而不是編一個對不上的。
          ...(source ? { source } : {}),
          name: chunk.name,
          ...(chunk.url ? { url: chunk.url } : {}),
          ...(chunk.locator ? { locator: chunk.locator } : {}),
          text: chunk.text,
        });
        refByKey.set(key, ref);
      }
      pageRefs[order]!.push(ref);
    }
  }
  return { excerpts, pageRefs, droppedChunks: droppedKeys.size };
}

/**
 * 把一頁的 sourceIds 砍到「最多 {@link OUTLINE_SLIDE_IMAGE_REF_LIMIT} 份會變成附圖的來源」。
 *
 * `imageRefs` 的 schema 上限**管不到落地**：`sourceIds` 是把 sourceRefs 與 imageRefs 壓平
 * 成同一個陣列，而 `jobs.ts` 是從每一個 sourceId 依 usage 反推附圖——「哪幾張是圖」的資訊
 * 在落地那一刻就消失了。模型只要把 8 張圖填進 sourceRefs（完全合乎兩個 schema 上限），
 * 這一頁就附 8 張圖。
 *
 * 判準用 `sourceAttachesReferenceImage()`（與 `jobs.ts` 同一份），不是「模型填在哪個欄位」：
 * 填錯欄位的圖照樣會被附上去，只看欄位等於沒擋。不可讀取／不參與生成的來源同樣不算——
 * 它們在 `jobs.ts` 那端就被濾掉了，讓它們白吃額度會擠掉真的附得上的圖。
 *
 * **整份大綱與單頁重生共用這一份**：只有一條路套上限的話，同一份專案裡「整份生成的頁」與
 * 「單頁重生過的頁」附圖數會不一樣，而使用者無從得知（多出來的那幾張是被 jobs.ts 靜默砍掉的）。
 */
export function withinSlideImageLimit(
  ids: readonly string[],
  sources: ReadonlyMap<string, SourceAsset>,
  limit = OUTLINE_SLIDE_IMAGE_REF_LIMIT,
): { ids: string[]; droppedImageSourceIds: string[] } {
  const droppedImageSourceIds: string[] = [];
  let images = 0;
  const kept = ids.filter((id) => {
    const source = sources.get(id);
    const attaches =
      !!source &&
      source.allowModelAccess &&
      source.usage !== "exclude-from-generation" &&
      sourceAttachesReferenceImage(source.usage);
    if (!attaches) return true;
    if (images >= limit) {
      droppedImageSourceIds.push(id);
      return false;
    }
    images += 1;
    return true;
  });
  return { ids: kept, droppedImageSourceIds };
}

/**
 * 一頁的檢索結果：進 prompt 的片段，以及「模型什麼都沒選時」可以退回的來源清單。
 *
 * 整份大綱與單頁重生共用同一個形狀，兩條路的來源歸屬邏輯才不會再度分歧（分歧本身就是
 * `GEMINI_IMAGE_REFERENCES_LIMIT` 那個 bug 的溫床：整份路徑無差別灌、單頁路徑真的檢索）。
 */
export function slideSourceContext(
  retriever: Pick<SqliteFtsRetriever, "search">,
  projectId: string,
  sources: readonly SourceAsset[],
  query: string,
  limit: number,
  pinnedSourceIds: readonly string[] = [],
): { chunks: SourceContextChunk[]; sourceIds: string[] } {
  const chunks = knownSourceContext(retriever, projectId, sources, query, limit, pinnedSourceIds);
  return {
    chunks,
    sourceIds: [...new Set(chunks.map((chunk) => chunk.id))].slice(0, SLIDE_SOURCE_ID_LIMIT),
  };
}
