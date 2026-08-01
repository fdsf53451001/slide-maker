import { z } from "zod";
import { SLIDE_PAGE_TYPES, slidePageTypeSchema } from "@slide-maker/core";
import {
  OUTLINE_SLIDE_IMAGE_REF_LIMIT,
  OUTLINE_SLIDE_SOURCE_REF_LIMIT,
  SLIDE_SOURCE_ID_LIMIT,
} from "./outline-sources.js";
import { idSchema } from "./project-write-helpers.js";

/**
 * 大綱回傳的頁型。**先正規化再 parse，認不得就當沒說**。
 *
 * 裸 `z.enum()` 在這裡有兩個問題：①非嚴格 gateway 回 `"Cover"`／`" section "` 這種良性變體
 * 時會讓**整份大綱**失敗，而模型顯然知道自己在指哪一種；②zod 的 `invalid_enum_value` 會把
 * 收到的值寫進 `ZodError.message`，而那個例外會被 `runOutlineStage` 的 catch 記進 log。
 * 落到 `undefined` 的代價很小：那一頁的合約退回「你自己判斷」＝加入這個欄位前的行為。
 */
export const outlinePageTypeSchema = z.preprocess((value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SLIDE_PAGE_TYPES as readonly string[]).includes(normalized) ? normalized : undefined;
}, slidePageTypeSchema.optional());

// 大綱生成的 content 超過硬上限時重生成的最大嘗試次數。
export const OUTLINE_MAX_ATTEMPTS = 3;

export interface OutlineCountErrorDetails {
  projectId: string;
  /**
   * 哪一個階段回錯頁數。少了它，`outline_count_invalid` 這一行在事後看 log 時分不出是
   * 規劃階段沒照 brief 的頁數，還是寫作階段沒照計畫寫——兩者的下一步完全不同。
   */
  stage: "plan" | "draft";
  /** 使用者在 brief 裡要求的頁數。**永遠是使用者的設定**，不可拿階段 1 的結果頂替。 */
  requestedCount: number;
  allowedMin: number;
  allowedMax: number;
  declaredCount: number | null;
  returnedCount: number;
  attempt: number;
}

/**
 * 模型回傳的大綱頁數不符合請求契約。
 *
 * code 與給使用者看的 message 分開保存，避免把動態頁數塞進 `Error.message` 後再靠統一
 * error handler 的 regex 猜錯誤種類。details 只含頁數與專案 id，可安全寫入結構化 log；
 * prompt、來源與模型正文一律不進這個型別。
 *
 * 訊息分階段：寫作階段的合法頁數是「規劃階段定下的那個數」，但使用者手上的設定是 brief
 * 的頁數。把 requestedCount 也填成計畫頁數的話，brief 要 12 頁而計畫合法地回了 14 頁時，
 * 訊息會變成「本次要求 14 頁，允許 14–14 頁」——與使用者自己的設定矛盾，還把他導向去改
 * 一個他根本沒設過的數字。
 */
export class OutlineCountError extends Error {
  readonly code = "OUTLINE_COUNT_INVALID";

  constructor(readonly details: OutlineCountErrorDetails) {
    super(
      details.stage === "draft"
        ? `大綱頁數不符合要求：本次要求 ${details.requestedCount} 頁，規劃階段定為 ${details.allowedMin} 頁，但撰寫階段回傳 ${details.returnedCount} 頁（第 ${details.attempt} 次嘗試）。`
        : `大綱頁數不符合要求：本次要求 ${details.requestedCount} 頁，允許 ${details.allowedMin}–${details.allowedMax} 頁；${details.declaredCount === null ? "模型未提供有效頁數宣告" : `模型宣告 ${details.declaredCount} 頁`}，實際回傳 ${details.returnedCount} 頁（第 ${details.attempt} 次嘗試）。`,
    );
    this.name = "OutlineCountError";
  }
}

/**
 * 階段 1（規劃）的回覆。**沒有 content**：這一輪的輸入只有來源目錄（每份一句摘要），
 * 手上沒有正文可寫，硬要它寫只會寫出憑摘要腦補的內容。
 *
 * 產出的 `purpose` 正好是階段 1.5 的檢索 query——「先有內容才知道要什麼來源／先有 query
 * 才能檢索」的循環就是在這裡解開的。
 */
export const outlinePlanSchema = z.object({
  actualSlideCount: z.preprocess(
    (value) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null),
    z.number().int().positive().nullable(),
  ),
  rationale: z.string(),
  slides: z
    .array(
      z.object({
        purpose: z.string().min(1),
        // 頁型屬於規劃：它決定這一頁套哪一段版面規則，與「這一頁要講什麼」是同一個決定。
        // 寫作階段只負責把正文寫出來，不該重新判斷一次。
        pageType: outlinePageTypeSchema,
        // `.default([])` 而非必填：非嚴格 gateway 常整個省略空陣列，缺欄位就 throw 等於
        // 把「這一頁不需要指定來源」變成硬失敗。留空是合法答案。
        sourceRefs: z.array(z.string()).max(OUTLINE_SLIDE_SOURCE_REF_LIMIT).default([]),
        imageRefs: z.array(z.string()).max(OUTLINE_SLIDE_IMAGE_REF_LIMIT).default([]),
      }),
    )
    .min(1),
});
export const outlinePlanJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["actualSlideCount", "rationale", "slides"],
  properties: {
    actualSlideCount: { type: ["integer", "null"], minimum: 1 },
    rationale: { type: "string" },
    slides: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["purpose", "pageType", "sourceRefs", "imageRefs"],
        properties: {
          purpose: { type: "string" },
          pageType: { type: "string", enum: [...SLIDE_PAGE_TYPES] },
          sourceRefs: {
            type: "array",
            maxItems: OUTLINE_SLIDE_SOURCE_REF_LIMIT,
            items: { type: "string" },
          },
          imageRefs: {
            type: "array",
            maxItems: OUTLINE_SLIDE_IMAGE_REF_LIMIT,
            items: { type: "string" },
          },
        },
      },
    },
  },
};

/**
 * 階段 2（寫作）的回覆。頁面順序與 `purpose` 由階段 1 決定，這一輪只負責把每頁的正文寫出來
 * 並確認它實際用到的來源。
 *
 * `sourceRefs`（內容依據）與 `imageRefs`（參考圖）是兩個獨立欄位、兩個獨立上限：參考圖會
 * 直接進影像模型的請求，寬鬆一點的代價是整頁生成失敗，而不是少一段佐證。
 * `sourceUrls` 保留給搜尋來的網頁（模型手上有 url、沒有 ref 時仍引用得到），刻意不驗
 * `.url()`：非嚴格 gateway 回一個不成形的字串時，丟掉那一筆就好，不該讓整份大綱失敗。
 */
export const outlineDraftSchema = z.object({
  slides: z
    .array(
      z.object({
        // 階段 1 每頁的錨點（`P1`…`Pn`）。**兩次無狀態呼叫之間唯一的配對依據**：沒有它，
        // 「第 N 筆 content 對應第 N 筆 purpose」純粹是對模型維持陣列順序的期待，而非嚴格
        // gateway 重排 JSON 陣列並不罕見。錯位不會 throw——只會讓封面頁拿到市場規模的
        // 內文，然後被影像合約當成內容頁畫出來，伺服器一行證據都沒有。
        // `.default("")` 而不是必填：漏欄位要走下面那條「重排不了就擋下」的具名路徑，
        // 而不是變成一個看不懂的 zod 400。
        planRef: z.string().default(""),
        content: z.string().min(1),
        narrative: z.string(),
        layoutHint: z.string(),
        sourceRefs: z.array(z.string()).max(OUTLINE_SLIDE_SOURCE_REF_LIMIT).default([]),
        imageRefs: z.array(z.string()).max(OUTLINE_SLIDE_IMAGE_REF_LIMIT).default([]),
        sourceUrls: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export const outlineDraftJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    slides: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "planRef",
          "content",
          "narrative",
          "layoutHint",
          "sourceRefs",
          "imageRefs",
          "sourceUrls",
        ],
        properties: {
          planRef: { type: "string" },
          content: { type: "string" },
          narrative: { type: "string" },
          layoutHint: { type: "string" },
          sourceRefs: {
            type: "array",
            maxItems: OUTLINE_SLIDE_SOURCE_REF_LIMIT,
            items: { type: "string" },
          },
          imageRefs: {
            type: "array",
            maxItems: OUTLINE_SLIDE_IMAGE_REF_LIMIT,
            items: { type: "string" },
          },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/**
 * 先把每頁的 ref 陣列截到上限再驗證（同 {@link withinSourceIdLimit} 的理由）。
 *
 * `maxItems` 只是「請模型配合」：Gemini 系 translator 不遵守 json_schema，而 prompt 又明說
 * 「留空是合法答案」，實測模型仍會硬湊。`.max()` 在這裡 throw 的話，使用者拿到的是三次
 * 看不懂的 500，而不是一份少引用了兩張圖的大綱。
 */
export function withinRefLimits(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as { slides?: unknown };
  if (!Array.isArray(value.slides)) return raw;
  return {
    ...value,
    slides: value.slides.map((slide: unknown) => {
      if (!slide || typeof slide !== "object") return slide;
      const item = slide as { sourceRefs?: unknown; imageRefs?: unknown };
      return {
        ...item,
        ...(Array.isArray(item.sourceRefs)
          ? { sourceRefs: item.sourceRefs.slice(0, OUTLINE_SLIDE_SOURCE_REF_LIMIT) }
          : {}),
        ...(Array.isArray(item.imageRefs)
          ? { imageRefs: item.imageRefs.slice(0, OUTLINE_SLIDE_IMAGE_REF_LIMIT) }
          : {}),
      };
    }),
  };
}

/**
 * 階段 1 每頁的錨點。階段 2 必須把它回聲，回來的順序才驗得動。
 *
 * 與 `S1`／`C1` 分開命名空間：三種 ref 混在同一個字首時，模型把 `S3` 填進 planRef 這種
 * 錯誤會「剛好對得上」另一頁，而那是最惡劣的一種錯位（看起來合法、內容全錯）。
 *
 * 記著一條備案（現在不要做）：若 `outline_plan_ref_missing` 上線後在實際使用的模型上持續
 * 出現，正確的反應**不是**改成缺錨點就擋下，而是把錨點從獨立欄位改成寫進 content 的前綴
 * （`[P3] …`）——模型幾乎不可能丟掉正文裡的字，而 gateway 丟掉不認識的欄位是常態。
 */
export function planRefOf(order: number): string {
  return `P${order + 1}`;
}

/**
 * 從模型回的錨點字串抽出頁碼（1-based），抽不出來回 `undefined`。
 *
 * 刻意容忍前導零與大小寫／空白（`p1`、` P01 `、`P0003`）：那些是**良性的格式變體**，模型
 * 顯然知道自己在指哪一頁。把它們判成失敗會很不對稱——「一個錨點都沒有」（證據最少）直接
 * 放行，而「每一筆都有、只是多了個零」（證據幾乎齊全）卻變成不可重試的硬失敗，對某個習慣
 * 補零的模型而言這條路等於永久壞掉（`runStructured` 無狀態，再按一次是同一個格式）。
 * 抽出來之後仍要求「唯一且落在 1..n」，配對還是雙射，安全性一點都沒放寬。
 */
export function planRefOrder(raw: string): number | undefined {
  const matched = /^P0*(\d+)$/.exec(raw.trim().toUpperCase());
  if (!matched) return undefined;
  const order = Number.parseInt(matched[1]!, 10);
  return Number.isSafeInteger(order) ? order : undefined;
}

/**
 * 依 planRef 把階段 2 的回覆對回計畫的順序。
 *
 * 三種結果，對應三種完全不同的事實：
 *  - `verified: true`——每一筆都帶錨點且剛好是 P1…Pn 的排列。**重排後**回傳，因此就算
 *    gateway 把 JSON 陣列的順序打亂（非嚴格 gateway 並不罕見），配對仍然正確。
 *    `normalized` 標記「有錨點被格式修正過」（`P01`→1），呼叫端據此留一行 log。
 *  - `verified: false`——一筆錨點都沒有。模型（或 gateway）整個忽略了這個欄位，我們沒有
 *    任何證據可以驗證順序，只能沿用陣列位置。這是改動前的既有行為，所以**不擋**，但要留
 *    一行 log：擋下等於讓所有不回聲這個欄位的 gateway 一律產不出大綱，代價遠大於風險。
 *  - `undefined`——部分有、重複、或指到不存在的頁。這是**正面證據**：模型自己都分不清哪
 *    一頁是哪一頁。照位置硬配是最壞的選擇（頁數相同時永遠不 throw，只會靜默錯位，讓封面
 *    拿到內頁的文字），所以呼叫端必須擋下。
 */
export function alignDraftToPlan<T extends { planRef: string }>(
  drafted: readonly T[],
  planCount: number,
): { slides: T[]; verified: boolean; normalized: boolean } | undefined {
  if (drafted.length !== planCount) return undefined;
  const raw = drafted.map((item) => item.planRef.trim());
  if (raw.every((ref) => !ref)) return { slides: [...drafted], verified: false, normalized: false };
  const byOrder = new Map<number, T>();
  let normalized = false;
  for (const [index, ref] of raw.entries()) {
    const order = planRefOrder(ref);
    // 抽不出頁碼、重複、或指到不存在的頁——三種都是「模型自己分不清哪一頁是哪一頁」的
    // 正面證據，照位置硬配只會靜默錯位。
    if (order === undefined || order < 1 || order > planCount || byOrder.has(order))
      return undefined;
    if (ref.toUpperCase() !== planRefOf(order - 1)) normalized = true;
    byOrder.set(order, drafted[index]!);
  }
  const aligned: T[] = [];
  for (let order = 1; order <= planCount; order += 1) {
    const item = byOrder.get(order);
    if (!item) return undefined;
    aligned.push(item);
  }
  return { slides: aligned, verified: true, normalized };
}

/** 模型回的 ref 超出上限、被 {@link withinRefLimits} 截掉的筆數（只用來記 log）。 */
export function countRefOverflow(raw: unknown): { sourceRefs: number; imageRefs: number } {
  const slides =
    raw && typeof raw === "object" && Array.isArray((raw as { slides?: unknown }).slides)
      ? (raw as { slides: unknown[] }).slides
      : [];
  let sourceRefs = 0;
  let imageRefs = 0;
  for (const slide of slides) {
    if (!slide || typeof slide !== "object") continue;
    const item = slide as { sourceRefs?: unknown; imageRefs?: unknown };
    if (Array.isArray(item.sourceRefs))
      sourceRefs += Math.max(0, item.sourceRefs.length - OUTLINE_SLIDE_SOURCE_REF_LIMIT);
    if (Array.isArray(item.imageRefs))
      imageRefs += Math.max(0, item.imageRefs.length - OUTLINE_SLIDE_IMAGE_REF_LIMIT);
  }
  return { sourceRefs, imageRefs };
}

export const aiRegeneratedSlideSchema = z.object({
  content: z.string().min(1),
  narrative: z.string(),
  layoutHint: z.string(),
  // 認不得或缺席時是 `undefined`＝「這一頁的頁型不變」，由呼叫端保留現值。單頁重生的
  // 語意是「保留這一頁在整份簡報裡的角色」，所以沉默必須是「不動」而不是「改成內頁」。
  pageType: outlinePageTypeSchema,
  sourceIds: z.array(idSchema).max(SLIDE_SOURCE_ID_LIMIT),
});
export const aiRegeneratedSlideJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["content", "narrative", "layoutHint", "pageType", "sourceIds"],
  properties: {
    content: { type: "string" },
    narrative: { type: "string" },
    layoutHint: { type: "string" },
    /*
     * enum 多一個空字串＝「不變」。
     *
     * 嚴格端點（OpenAI strict）要求 `required` 列出每一個 property，所以不能單靠把
     * `pageType` 拿掉來表達沉默——那等於逼模型在**舊專案的頁面根本沒有現值可保留**時硬
     * 挑一個，而最可能挑到的是 `content`。挑完就被釘住：合約明文禁止影像模型再從 purpose
     * 反推，於是一次重生就能把一張舊封面永久改判成內頁，而且畫面上沒有任何徵兆。
     */
    pageType: { type: "string", enum: [...SLIDE_PAGE_TYPES, ""] },
    sourceIds: { type: "array", maxItems: SLIDE_SOURCE_ID_LIMIT, items: { type: "string" } },
  },
};

/**
 * 先把模型回傳的 sourceIds 截到上限再驗證。
 *
 * 非嚴格 gateway（尤其 Gemini 系 translator）不遵守 json_schema 是常態，指定的來源多於上限時
 * 模型會照著自然語言指令多回幾個，`.max()` 就會 throw。那個 throw 在重試迴圈裡不被捕捉，
 * 使用者只會連續拿到三次看不懂的 500，也無從得知「少指定幾份」就能解決。
 */
export function withinSourceIdLimit(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as { sourceIds?: unknown };
  if (!Array.isArray(value.sourceIds) || value.sourceIds.length <= SLIDE_SOURCE_ID_LIMIT)
    return raw;
  return { ...value, sourceIds: value.sourceIds.slice(0, SLIDE_SOURCE_ID_LIMIT) };
}
