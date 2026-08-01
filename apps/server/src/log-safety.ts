import { z } from "zod";
import { SafeProviderError } from "@slide-maker/core";

/**
 * 模型呼叫的例外裡「可以進 log」的那部分（樣式精修與兩階段大綱共用一份）。
 *
 * **刻意不記 `message` 與 `stack`**：非嚴格 gateway 會把 request body 原樣回聲進 400 的
 * message，而那份 body 含 `OCR_BOXES_JSON` 與每一框的正文（大綱那條路則是整批來源正文）；
 * zod 的 `invalid_enum_value` 也會把收到的值夾進 `ZodError.message`。改記型別名、provider
 * 的安全代碼與 zod 的欄位路徑——診斷價值幾乎沒少，而正文一個字都出不去。
 */
export function modelErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof SafeProviderError) return { errorName: error.name, errorCode: error.code };
  if (error instanceof z.ZodError)
    return {
      errorName: "ZodError",
      zodPaths: error.issues.slice(0, 8).map((issue) => issue.path.join(".")),
    };
  return { errorName: error instanceof Error ? error.name : typeof error };
}
/**
 * 未分類例外裡「可以進 log」的那部分（統一 error handler 專用）。
 *
 * 這條路上的例外**經常夾帶正文**：非嚴格 gateway 會把 request body 原樣回聲進 400 的
 * message，而大綱的 body 裝著整批來源節錄（實測一次 4528 字元、含來源正文）。
 * `logWarn`／`logError` 的第三個參數會把 `message` 與 `stack` 整份序列化進去，而 V8 的
 * `stack` 第一行就是 message，所以只挑出 `at …` 那幾行——**保住呼叫堆疊的診斷價值，
 * 但正文一個字都出不去**。訊息本身的損失是刻意的取捨：真正需要訊息的失敗（provider 的
 * 安全錯誤、具名錯誤碼）都有自己的分支，落到這裡的是「不該發生」的例外。
 */
export function httpFailureFields(error: unknown): Record<string, unknown> {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  // 只認**長得像 stack frame** 的行，不是「行首是 at 」：多行 message 裡任何以 `at ` 起頭
  // 的句子都會被前者收進 log（實測 `at 2026-07-29 the customer 王小明 signed 機密合約`
  // 整行進去）。跳過第一行同樣不夠——回聲進來的 JSON body 本來就有換行。
  // 行尾必須是 `檔案:行:欄`、`native` 或 `<anonymous>`，這三種才是 V8 真的會產生的形狀。
  const frames = stack
    .split("\n")
    .filter((line) => /^\s*at (?:\S.*)?\(?(?:[^()\s]+:\d+:\d+|native|<anonymous>)\)?$/.test(line))
    .slice(0, 5)
    .map((line) => line.trim());
  return { ...modelErrorFields(error), ...(frames.length ? { errorFrames: frames } : {}) };
}
