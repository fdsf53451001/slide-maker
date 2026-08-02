import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/**
 * pdfjs-dist 隨套件附帶的資料檔在磁碟上的位置。
 *
 * 這是**環境事實**（套件被裝在哪）而不是政策，三條 PDF 路徑對它只會有同一個答案；
 * 各自算一份的代價是升級 pdfjs-dist 或換 resolver 時只會修好其中一條，另一條在
 * 執行期靜默掉字（本次 sources.ts 的失效形狀正是如此：沒有錯誤碼，只有一行 stderr）。
 * 要傳哪些參數仍由各呼叫端自己決定——這裡刻意不提供組好的參數物件，
 * `isEvalSupported`／`useSystemFonts`／頁數與時限的分歧必須留著。
 */
const require_ = createRequire(import.meta.url);
const pdfjsRoot = dirname(require_.resolve("pdfjs-dist/package.json"));

export const PDFJS_CMAP_URL = join(pdfjsRoot, `cmaps${sep}`);
export const PDFJS_STANDARD_FONT_URL = join(pdfjsRoot, `standard_fonts${sep}`);
