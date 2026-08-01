import type { PresentationProject } from "@slide-maker/core";

/**
 * 「AI 自由設計」的風格決議結果 → 給使用者看的一句話。
 *
 * 讀 `project.styleDirection` 而不是自己推論：前端不得鏡射伺服器組態（有沒有文字模型、
 * 模型可不可用、這個專案算不算 AI 自由設計）來猜這件事，那必然漂移——答案只有伺服器
 * 知道，所以跟著大綱的回應一起回來。舊專案沒有這個欄位，當作「沒有跑過」而不是「跑失敗」。
 */

/** `applied: false` 的原因 → 下一步。措辭只寫「該做什麼」，不重述伺服器已經講過的細節。 */
const UNRESOLVED_REASONS: Record<string, string> = {
  STYLE_DIRECTION_MODEL_UNAVAILABLE:
    "選定組合的文字模型現在不可用。請到模型庫確認連線與 API 金鑰後，重新產生一次大綱。",
  STYLE_DIRECTION_FAILED: "呼叫文字模型時失敗了。可以直接重新產生一次大綱。",
  STYLE_DIRECTION_EMPTY:
    "文字模型這次沒有交出可用的設計系統。可以直接重新產生一次大綱；若連續發生，請改用另一個文字模型。",
  // 以下沿用模型庫的代碼（伺服器刻意不換名，前端才分辨得出這是設定問題而非模型狀況）。
  COMBINATION_NOT_FOUND:
    "這個專案綁定的模型組合已經不存在。請到專案設定重新選一個組合，再重新產生一次大綱。",
  COMBINATION_TEXT_MISSING:
    "這個專案綁定的模型組合沒有設定文字模型。請到模型庫替它指定一個，再重新產生一次大綱。",
  NO_DEFAULT_COMBINATION: "模型庫還沒有預設的模型組合。請建立一個並設為預設，再重新產生一次大綱。",
  TEXT_MODEL_NOT_FOUND:
    "這個組合指定的文字模型用不了（可能已被刪除，或它的種類本來就不產生文字）。請到模型庫改掉它，再重新產生一次大綱。",
};

/**
 * 要顯示在非錯誤通知列上的句子；沒有話要說時回 `undefined`。
 *
 * 成功且完整時刻意不寫任何訊息：通知列只有點擊才關得掉，替一份其實一切正常的產出留一句
 * 「已完成」只會擋在畫面上（同抽字那條的慣例）。
 */
export function styleDirectionNotice(project: PresentationProject): string | undefined {
  const outcome = project.styleDirection;
  if (!outcome) return undefined;
  if (outcome.applied) {
    // 寫進去了，但有具名缺口。目前只有一種：模型沒講明整份走深色還是淺色。
    if (outcome.reason === "STYLE_DIRECTION_TONE_MISSING")
      return "已為這份簡報決定共用的設計系統，但模型沒有講明整份要走深色還是淺色，頁與頁之間仍可能出現明暗翻轉。重新產生一次大綱通常就會補上。";
    return undefined;
  }
  const next =
    (outcome.reason && UNRESOLVED_REASONS[outcome.reason]) ??
    `原因代碼 ${outcome.reason ?? "UNKNOWN"}。`;
  // detail 是 provider 的可用性說明（缺哪個環境變數、缺哪把金鑰），往往正好是下一步。
  const detail = outcome.detail ? `（${outcome.detail}）` : "";
  return `這份簡報沒有共用的設計系統，每一頁會各自決定視覺語言，可能出現底色明暗與版型不一致。${next}${detail}`;
}
