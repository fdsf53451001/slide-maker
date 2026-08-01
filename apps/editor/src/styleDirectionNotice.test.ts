import { describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { styleDirectionNotice } from "./editor/styleDirection.js";

/**
 * 「AI 自由設計」的風格決議降級時，使用者看得到什麼。
 *
 * 這件事非講不可的理由與抽字那條一樣：決議失敗的產出**看起來完全正常**（大綱好好的、
 * 每一頁都生得出圖），唯一的徵兆要等到十幾張圖擺在一起才看得見。而「這一份沒有共用的
 * 設計系統」與「模型今天狀況比較差」在畫面上長得一模一樣。
 */
const project = (styleDirection: PresentationProject["styleDirection"]): PresentationProject =>
  ({ ...(styleDirection ? { styleDirection } : {}) }) as PresentationProject;

describe("風格決議的通知句", () => {
  it("成功且完整時什麼都不說", () => {
    // 通知列只有點擊才關得掉：替一份其實一切正常的產出留一句「已完成」只會擋在畫面上。
    expect(styleDirectionNotice(project({ applied: true }))).toBeUndefined();
  });

  it("沒有這個欄位時當成「沒跑過」，不是「跑失敗了」", () => {
    // 這個功能之前的專案沒有它；把缺席讀成失敗會讓每一份舊專案都跳出警告。
    expect(styleDirectionNotice(project(undefined))).toBeUndefined();
  });

  it("採用了但缺明暗登記時，講的是「還是可能翻」而不是「失敗」", () => {
    const notice = styleDirectionNotice(
      project({ applied: true, reason: "STYLE_DIRECTION_TONE_MISSING" }),
    );
    expect(notice).toContain("深色還是淺色");
    expect(notice).toContain("重新產生一次大綱");
    expect(notice).not.toContain("沒有共用的設計系統");
  });

  it("設定錯誤與執行期失敗給的是不同的下一步", () => {
    // 伺服器刻意沿用模型庫的代碼，前端才分辨得出「去改設定」與「再試一次」。
    const config = styleDirectionNotice(
      project({ applied: false, reason: "COMBINATION_TEXT_MISSING" }),
    );
    expect(config).toContain("沒有共用的設計系統");
    expect(config).toContain("模型庫");
    const runtime = styleDirectionNotice(
      project({ applied: false, reason: "STYLE_DIRECTION_FAILED" }),
    );
    expect(runtime).toContain("沒有共用的設計系統");
    expect(runtime).not.toContain("模型庫");
  });

  it("伺服器附的 detail 原樣接在後面（它往往正好是下一步）", () => {
    const notice = styleDirectionNotice(
      project({
        applied: false,
        reason: "STYLE_DIRECTION_MODEL_UNAVAILABLE",
        detail: "需設定 SLIDE_MAKER_OPENAI_BASE_URL",
      }),
    );
    expect(notice).toContain("需設定 SLIDE_MAKER_OPENAI_BASE_URL");
  });

  it("認不得的代碼仍然說得出「發生了什麼」，而不是靜默", () => {
    const notice = styleDirectionNotice(project({ applied: false, reason: "SOMETHING_NEW" }));
    expect(notice).toContain("沒有共用的設計系統");
    expect(notice).toContain("SOMETHING_NEW");
  });
});
