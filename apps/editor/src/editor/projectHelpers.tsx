import type {
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SlideVersion,
  StylePreset,
} from "@slide-maker/core";
import { imageUrl } from "../api.js";

export type CombinationSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  imageModelRef?: string;
};

export const PHASE_LABELS: Record<string, string> = {
  queued: "等待排程",
  preparing: "準備資料",
  launching: "啟動 Codex",
  waiting_for_codex: "Codex 正在生成",
  validating_output: "驗證圖片",
  persisting: "保存版本",
  completed: "完成",
  failed: "失敗",
  cancelled: "已取消",
};

/**
 * 刪除版本的守門錯誤：伺服器 409 只回裸錯誤碼（沒有 message 欄位），直接顯示對使用者
 * 沒有意義，而且每一種都有明確的下一步動作，所以在這裡翻成可行動的說明。
 */
export const VERSION_DELETE_MESSAGES: Record<string, string> = {
  VERSION_IN_USE: "這是使用中的版本，請先切換到其他版本再刪除。",
  VERSION_HAS_ACTIVE_JOB: "這個版本正在被生成任務使用，請等任務結束。",
  VERSION_REFERENCED_BY_TEXT_LAYER: "有可編輯文字版本以這一版為原圖，請先刪除那個版本。",
};

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function currentImage(project: PresentationProject, slide: SlideSpec): string | undefined {
  const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
  return version ? imageUrl(project.id, version.imagePath) : undefined;
}

/** 這個版本是不是 PDF 匯入落地的（原圖與可編輯文字兩個版本都算）。 */
export function isPdfImportVersion(version?: {
  providerId?: string;
  parameters?: Record<string, unknown>;
}) {
  return version?.providerId === "pdf-import" && version.parameters?.pdfImport === true;
}

/**
 * 刪除版本前的確認文字。
 *
 * PDF 匯入的可編輯文字版本是匯入當下用 PDF 原生文字層一次做出來的，刪掉就再也造不回來：
 * 重做只剩 extract-text 那條 OCR＋遮罩重繪的路，字框幾何明顯比原生文字層粗糙。泛用的
 * 「無法復原」在這裡等於沒說，使用者無從知道自己要付的是這個代價。
 *
 * `origin !== "manual"` 不是多餘的：手動文字層的新版本是 `{ ...原版本 }` 複製出來的，所以在
 * PDF 匯入的原圖版本上手動加字，新版本會同時滿足 `isPdfImportVersion() && textLayer`——
 * 少了這個條件，確認框會把「使用者剛手打的字」說成「PDF 匯入時建立的可編輯文字版本」。
 */
export function versionDeleteConfirmText(version: SlideVersion): string {
  if (isPdfImportVersion(version) && version.textLayer && version.textLayer.origin !== "manual")
    return "這是 PDF 匯入時建立的可編輯文字版本，刪掉後只能改用 OCR 重新抽字（字框會比原生文字層粗糙），確定嗎？";
  if (version.textLayer?.origin === "manual")
    return "這個版本裡手動加上的文字會一併刪除，刪掉後無法復原，確定嗎？";
  return "刪除這個版本後無法復原，確定嗎？";
}

/** 這份專案是不是由 PDF 匯入建立的（決定 setup 階段要走分析頁而不是四步 wizard）。 */
export function isPdfImportProject(project: PresentationProject): boolean {
  return project.slides.some((slide) =>
    slide.versions.some((version) => isPdfImportVersion(version)),
  );
}

/**
 * 風格下拉選單的選項。
 *
 * 專案自己的 styleSnapshot 不一定在風格庫清單裡（PDF 匯入分析出來的 `pdf-style-*`
 * 就不在），少了代表它的那個 option，`value` 會對不上任何選項，瀏覽器改為顯示
 * 第一個選項「AI 自由設計」——畫面上寫的風格與實際套用的不是同一個。
 */
export function styleOptions(styles: StylePreset[], snapshot: StylePreset) {
  return (
    <>
      {!styles.some((style) => style.id === snapshot.id) && (
        <option value={snapshot.id}>{snapshot.name}（本專案專屬）</option>
      )}
      {styles.map((style) => (
        <option key={style.id} value={style.id}>
          {style.name} v{style.version}
        </option>
      ))}
    </>
  );
}

/**
 * 換風格前的確認。專案專屬的 designSystem 被庫裡的風格蓋掉之後沒有復原路徑，所以只有這
 * 種情況會問；一般專案照舊直接套用。回傳 false 代表不要執行。
 *
 * 產生「專案專屬設計系統」的路現在有**兩條**（都 fork 成同一個專案本地 id）：PDF 匯入的
 * 參考圖分析，以及「AI 自由設計」在大綱之後跑的風格決議。訊息因此不能再只講 PDF——那會
 * 讓另一條路上的使用者看到一句與自己無關的話，然後照按確定，把整份簡報的視覺基準換掉。
 */
export function confirmStyleReplacement(
  styles: StylePreset[],
  snapshot: StylePreset,
  nextStyleId: string,
): boolean {
  if (nextStyleId === snapshot.id) return false;
  const projectLocal = !styles.some((style) => style.id === snapshot.id);
  if (!projectLocal || !snapshot.designSystem) return true;
  return confirm(
    "這份簡報用的是它自己的專屬設計系統（AI 分析或風格決議產生的），套用其他風格會把它覆蓋掉且無法復原，確定繼續？",
  );
}

/**
 * 送出 brief 草稿時要拿掉 `webSearchMode`。
 *
 * 草稿都是「開專案／開精靈當下」的快照，而 `webSearchMode` 由自動搜尋勾選框獨佔
 * （見 `useWebSearchToggle`）。PATCH /brief 是 merge（`app.ts`：`{ ...current.brief, ...patch }`），
 * 少送這個欄位就是「不要動它」；整份送回去則會把之後（可能是另一個人）切換過的搜尋設定倒回舊值。
 */
export function briefPatchWithoutWebSearch(brief: PresentationBrief): Partial<PresentationBrief> {
  const patch: Partial<PresentationBrief> = { ...brief };
  delete patch.webSearchMode;
  return patch;
}
