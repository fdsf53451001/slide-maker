import { z } from "zod";
import type { ResolvedImageProfile } from "./model-profile.js";

/**
 * 影像模型的「可調項」介面。
 *
 * **為什麼是宣告式的**：各家影像端點吃的欄位名與值域都不同，而使用者要選的是「這張圖多大」
 * 這種效果，不是 `image_size` 還是 `size` 這種欄位名。把後者搬到 UI 上等於要求使用者先懂
 * gateway；把前者寫死成一份泛用清單，又會列出這個模型根本不支援的檔位——選項不是選好玩的。
 *
 * 所以分工是：**provider 宣告「這個模型有哪些可調項、每一項有哪些值」，框架只負責渲染、
 * 存值與把值交回去翻譯**。框架不認得任何一個欄位 id 的語意，因此加一家新模型是在 provider
 * 套件多註冊一個 {@link ImageModelOptionSet}，UI 與伺服器一行都不用改；某家有獨有的旋鈕時，
 * 它自己多宣告一個 field 就會出現在畫面上。
 */

/** 單選欄位的一個選項。`label` 是使用者看到的字，`id` 是存進 models.json 的值。 */
export const imageOptionChoiceSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
});
export type ImageOptionChoice = z.infer<typeof imageOptionChoiceSchema>;

/**
 * 一格可調設定。
 *
 * `select` 的 `unsetLabel` 是「這一格不送、由端點自己決定」那個選項的字——**必須永遠存在**：
 * 使用者要有辦法退回預設，而「預設」對不同模型是不同的行為，只有 provider 講得出來。
 */
export const imageOptionFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    hint: z.string().max(240).optional(),
    unsetLabel: z.string().min(1).max(120),
    choices: z.array(imageOptionChoiceSchema).min(1).max(32),
  }),
  z.object({
    kind: z.literal("number"),
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    hint: z.string().max(240).optional(),
    placeholder: z.string().max(120),
    min: z.number().int(),
    max: z.number().int(),
  }),
]);
export type ImageOptionField = z.infer<typeof imageOptionFieldSchema>;

/**
 * entry 上存的選擇：欄位 id → 值（select 存 choice id、number 存數字）。
 *
 * 刻意存成不透明的字典而不是具名欄位：具名欄位等於把每一種模型的旋鈕都寫進 schema，
 * 加一家就要改 core、改伺服器、改前端型別——那正是這個介面要消滅的東西。認不得的 key
 * （provider 改版、模型被換掉）由 provider 的 `resolve()` 忽略，不讓舊資料把整個 entry 卡死。
 */
export const imageOptionValuesSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(64), z.number()]),
);
export type ImageOptionValues = z.infer<typeof imageOptionValuesSchema>;

/** provider 把使用者的選擇翻成的東西；沒提到的欄位沿用 transport 的預設值。 */
export type ImageProfileOverride = Partial<ResolvedImageProfile>;

/**
 * 一組「某個模型（或某系列模型）可調什麼」的宣告，由 provider 套件註冊。
 *
 * `resolve()` 對**空的 values 也要回得出東西**——那就是這個模型的預設行為（例如 Gemini 系
 * 的 `image_size:2K`）。讓預設與使用者的選擇走同一條路，兩者才不會分岔成兩套規則。
 */
export interface ImageModelOptionSet {
  /** 這組宣告的識別字，只用於 log 與測試。 */
  id: string;
  /** 顯示在欄位旁的來源說明，例如「Gemini 影像系列」。 */
  label: string;
  fields: ReadonlyArray<ImageOptionField>;
  resolve(values: ImageOptionValues): ImageProfileOverride;
}

/**
 * 送到前端的形狀：只有宣告，沒有 `resolve()`（那是伺服器端的翻譯，過不了 JSON）。
 *
 * 前端**不自己算**這份清單：它得知道每一家模型吃什麼欄位才算得出來，而那份知識住在
 * provider 套件裡，鏡射一份必然漂移——CLAUDE.md 對前端鏡射伺服器組態有專門一條。
 */
export interface ImageOptionSetView {
  id: string;
  label: string;
  fields: ReadonlyArray<ImageOptionField>;
}

/** 讀出 select 欄位的值；型別不符或不在選項裡就當沒設（舊資料、provider 改版）。 */
export function selectedChoice(
  field: Extract<ImageOptionField, { kind: "select" }>,
  values: ImageOptionValues,
): string | undefined {
  const value = values[field.id];
  if (typeof value !== "string") return undefined;
  return field.choices.some((choice) => choice.id === value) ? value : undefined;
}

/** 讀出 number 欄位的值；型別不符或超出宣告範圍就當沒設。 */
export function selectedNumber(
  field: Extract<ImageOptionField, { kind: "number" }>,
  values: ImageOptionValues,
): number | undefined {
  const value = values[field.id];
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= field.min && value <= field.max ? value : undefined;
}
