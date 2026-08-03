import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { logError, SafeProviderError } from "@slide-maker/core";
import { ModelLibraryError } from "./model-runtime.js";
import { OCR_QUEUE_BUSY, OCR_QUEUE_SHUTDOWN } from "./ocr-queue.js";
import { OutlineCountError } from "./outline-contracts.js";
import { ProviderReadinessGateError } from "./readiness.js";
import { SourceLimitError } from "./sources.js";
import { StyleAnalysisError } from "./style-analysis.js";
import { httpFailureFields } from "./log-safety.js";

/**
 * 匯入相關錯誤碼（PDF 與 `.slide-project.zip` 專案封存）→ 使用者看得懂的原因。
 *
 * 這些碼從光柵化管線深處以具名 Error 拋出（跨 worker 執行緒也只剩字串），沒有辦法
 * 在拋出點帶訊息；統一在對外邊界翻譯。匯入對話框是新使用者看到的第一個畫面，
 * 在那裡顯示 `PDF_ASPECT_UNSUPPORTED` 等於什麼都沒說。
 */
const PDF_MESSAGES: Record<string, string> = {
  // 風格分析的文字模型逾時。走 SafeProviderError 的 provider 不經過這裡，這一條是給
  // 只丟得出裸碼字串的路徑用的——沒有它，分析頁會直接把 `TEXT_MODEL_TIMEOUT` 顯示給使用者。
  TEXT_MODEL_TIMEOUT:
    "分析這幾頁花太久已中止。可以直接重試，或少挑幾頁再分析一次；也可以先用預設風格進編輯器。",
  // 長度重試三輪後仍超出可接受上限的兩倍。這是使用者唯一還會看到的長度失敗，裸碼在這裡
  // 等於叫人再按一次（而再按一次通常還是同樣結果）：訊息必須指出可行的下一步。
  // 階段 2 的回覆對不回階段 1 的頁面（缺 planRef、重複、指到不存在的頁）。照位置硬配
  // 會讓封面拿到內頁的文字而毫無徵兆，所以寧可擋下；再按一次通常就過了。
  OUTLINE_PLAN_MISMATCH:
    "模型這次回來的內容對不回大綱的頁面順序，為避免每一頁的標題與內文錯位，這一份沒有落地。請再產生一次；若連續發生，請改用另一個文字模型。",
  OUTLINE_CONTENT_UNREADABLE:
    "模型幾次都寫出遠超版面容量的內容，這一頁沒有落地。請把資訊密度調低一級，或把這一頁拆成兩頁，再重新產生一次。",
  PDF_SIZE_INVALID: "檔案是空的或超過 100MB 上限。",
  PDF_INVALID: "這不是一份 PDF 檔。",
  PDF_EMPTY: "這份 PDF 沒有任何頁面。",
  PDF_RENDER_FAILED: "無法讀取這份 PDF，可能已加密或損壞。",
  PDF_FIRST_PAGE_UNREADABLE:
    "這份 PDF 的第一頁損壞、讀不出來，無法判斷簡報比例。請確認檔案未損毀後再試。",
  PDF_ASPECT_UNSUPPORTED:
    "只能匯入 16:9 的簡報：這份 PDF 第一頁不是 16:9。若原檔是 PowerPoint／Keynote，請把版面設成 16:9 再另存為 PDF。",
  PDF_PAGE_SELECTION_INVALID: "選取的頁面沒有一頁可以匯入，請重新挑選。",
  PDF_PAGE_NOT_FOUND: "這一頁不在 PDF 裡。",
  PDF_IMPORT_TIMEOUT: "這份 PDF 處理太久已中止。請減少選取的頁數再試一次。",
  PDF_RENDER_WORKER_FAILED: "PDF 轉檔程序中途結束，沒有完成匯入。請再試一次。",
  // 匯出連結是裸 `<a href>`：這條路上的錯誤碼會直接出現在瀏覽器分頁裡，沒有前端能翻譯它。
  // 替代方案要列**全**：少列一個等於使用者在這個狀態下拿不到一份其實匯得出來的檔案。
  // 「下載大綱」是後來加的第三種，原本那句「（兩者都會收錄隱藏頁）」當場就過期了。
  EXPORT_NO_VISIBLE_SLIDES:
    "所有頁面都已隱藏，pptx／pdf 沒有可以匯出的頁面。請先取消隱藏至少一頁，或改用「下載每頁 PNG」／「下載大綱」／「備份完整專案」（這幾種都會收錄隱藏頁）。",
  // 單頁 PNG 也是裸 `<a href>`：前端在沒有圖片時就不給連結，這兩句是「畫面比伺服器舊」
  // （另一個分頁剛把這一頁刪掉／把版本清掉）時使用者唯一看得到的說明。
  EXPORT_SLIDE_NOT_FOUND: "找不到這一頁，可能已在別處被刪除。請重新整理後再試。",
  EXPORT_SLIDE_IMAGE_MISSING: "這一頁還沒有圖片，沒有可以下載的 PNG。請先生成這一頁。",
  // `.slide-project.zip` 匯入與 PDF 匯入是同一個畫面上的兩顆按鈕，兩邊都不能只回錯誤碼。
  PROJECT_BUNDLE_INVALID:
    "這個檔案不是有效的專案封存。請選擇從「備份完整專案」下載的 .slide-project.zip。",
  PROJECT_BUNDLE_TOO_LARGE: "這份專案封存太大，無法匯入。",
  PROJECT_BUNDLE_UNSAFE_PATH: "這個專案封存的內容路徑不合法，已拒絕匯入。",
};

/**
 * 伺服器端失敗的 PDF 錯誤碼 → HTTP 狀態。
 * 這兩個不是壞輸入：回 4xx 的話，log 裡分不出使用者送了怪檔案還是 worker 掛了。
 */
const PDF_SERVER_FAILURE_STATUS: Record<string, number> = {
  PDF_IMPORT_TIMEOUT: 504,
  PDF_RENDER_WORKER_FAILED: 500,
};

/**
 * OCR 併發閘門的拒絕碼 → HTTP 狀態與繁中說明。
 *
 * 兩個都不是「伺服器壞了」，落到最後那條 500 會把正常的排隊控制記成 INTERNAL_SERVER_ERROR，
 * 使用者也只拿到一個沒有下一步的錯誤。抽字按鈕的錯誤是直接顯示 `message` 的，所以每一條
 * 都得自己說清楚該做什麼。
 */
const OCR_QUEUE_FAILURE: Record<string, { status: number; message: string }> = {
  [OCR_QUEUE_BUSY]: {
    status: 429,
    message: "另一頁正在抽離文字，一次只能處理一頁，請稍候再試。",
  },
  [OCR_QUEUE_SHUTDOWN]: {
    status: 503,
    message: "伺服器正在重新啟動，這次抽離文字沒有開始。請稍候再試一次。",
  },
};

// 四個參數的簽名不可省略，否則 Express 不會把這支當成 error handler。
export const errorHandler = (
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  if (response.headersSent) {
    // 已經吐了一半才失敗（串流匯出、sendFile、express.static）：再 `.status().json()`
    // 會撞 ERR_HTTP_HEADERS_SENT，原始錯誤就此消失、客戶端只拿到被截斷的檔案。
    // 交給 finalhandler，它會正確地 destroy socket，讓客戶端知道這份檔案不完整。
    logError(
      "http_response_failed_after_headers",
      { method: request.method, path: request.path },
      error,
    );
    return next(error);
  }
  if (error instanceof z.ZodError)
    return response.status(400).json({ error: "INVALID_REQUEST", issues: error.issues });
  // 放在所有 message regex 分支**之前**：下面幾條是前綴／字串比對（`/not found/i`、
  // `^(SOURCE_|…)`），今天都吃不到 `OCR_QUEUE_*`，但那是巧合而不是保證。這條只認完整
  // 字串、不會誤收別人的碼，擺在前面就永遠不會被後來新增的分支吃掉。
  // 用 Object.hasOwn 而不是 `in`：`in` 連 Object.prototype 的鍵（`toString`、`constructor`）
  // 都算數，取出來的會是函式，`failure.status` 就是 undefined、`response.status()` 直接 throw。
  if (error instanceof Error && Object.hasOwn(OCR_QUEUE_FAILURE, error.message)) {
    const failure = OCR_QUEUE_FAILURE[error.message]!;
    return response.status(failure.status).json({ error: error.message, message: failure.message });
  }
  if (error instanceof SourceLimitError)
    // **不能只靠下面那條 409 的 regex**：再後面還有一條 `/^(SOURCE_|…)/` 的 400 分支，
    // 兩個新碼都以 `SOURCE_` 開頭，漏列就會變成 400——而「專案滿了」語意上是衝突不是
    // 壞輸入。改用具名型別，順序怎麼調都不會踩到。
    return response.status(409).json({ error: error.code, message: error.message });
  if (error instanceof OutlineCountError) {
    // 只記頁數契約與專案 id：prompt、來源內容、模型正文及憑證都不在 typed details 裡。
    logError("outline_count_invalid", {
      code: error.code,
      ...error.details,
    });
    return response.status(400).json({ error: error.code, message: error.message });
  }
  if (error instanceof ProviderReadinessGateError)
    return response
      .status(409)
      .json({ error: "PROVIDER_PREFLIGHT_BLOCKED", readiness: error.readiness });
  if (error instanceof ModelLibraryError)
    // 模型庫解析／完整性錯誤（缺預設組合、缺能力模型等）：可行動的設定問題。
    return response.status(409).json({ error: error.code, message: error.message });
  if (error instanceof Error && /not found/i.test(error.message))
    return response.status(404).json({ error: "NOT_FOUND" });
  if (
    error instanceof Error &&
    /^(SOURCE_IN_USE|OUTLINE_HAS_GENERATED_VERSIONS|SLIDE_HAS_ACTIVE_JOB|LAST_SLIDE|INVALID_SLIDE_ORDER|INVALID_SLIDE_SELECTION|STYLE_REFERENCES_UNSUPPORTED|MULTIPLE_REFERENCES_UNSUPPORTED|FULL_SLIDE_GENERATION_UNSUPPORTED|SYSTEM_STYLE_READ_ONLY|STYLE_REFERENCE_LIMIT|VERSION_IN_USE|VERSION_HAS_ACTIVE_JOB|VERSION_REFERENCED_BY_TEXT_LAYER|TEXT_LAYER_EXISTS|EDIT_BASE_VERSION_MISSING)/.test(
      error.message,
    )
  ) {
    return response.status(409).json({ error: error.message });
  }
  if (error instanceof StyleAnalysisError)
    // 風格分析的具名失敗：`message` 是要直接顯示給使用者的中文說明。
    return response.status(400).json({ error: error.code, message: error.message });
  if (error instanceof Error && error.message in PDF_SERVER_FAILURE_STATUS) {
    // worker 崩潰與整批逾時是伺服器端的失敗，不是壞輸入：回 4xx 的話，log 裡
    // 分不出「使用者送了怪 PDF」與「render worker 掛了」。
    console.error("PDF import failed", { code: error.message });
    return response
      .status(PDF_SERVER_FAILURE_STATUS[error.message]!)
      .json({ error: error.message, message: PDF_MESSAGES[error.message]! });
  }
  if (
    error instanceof Error &&
    /^(SOURCE_|PROJECT_BUNDLE_|EXPORT_|SLIDE_VERSION_MISSING|STYLE_REFERENCE_|STYLE_COVER_|PDF_|OUTLINE_|TEXT_MODEL_|STYLE_ANALYSIS_)/.test(
      error.message,
    )
  ) {
    const message = PDF_MESSAGES[error.message];
    // PDF 匯入是新使用者看到的第一個畫面：裸錯誤碼在那裡沒有任何意義。
    return response.status(400).json({ error: error.message, ...(message ? { message } : {}) });
  }
  if (error instanceof SafeProviderError) {
    // Provider 對外安全錯誤：回傳 code 與安全訊息，讓前端能顯示可行動的原因。
    logError(
      "http_request_failed",
      { method: request.method, path: request.path, code: error.code },
      error,
    );
    return response.status(502).json({ error: error.code, message: error.safeMessage });
  }
  // 刻意不把 error 交給 logError 的第三個參數：見 httpFailureFields 的說明。
  logError("http_request_failed", {
    method: request.method,
    path: request.path,
    ...httpFailureFields(error),
  });
  return response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
