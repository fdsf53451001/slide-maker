import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderAvailability,
  SafeProviderError,
  type StructuredTextProvider,
  type StructuredTextRequest,
  type StructuredTextResult,
} from "@slide-maker/core";
import { runCodexStructured } from "./structured.js";

export interface CodexStructuredTextOptions {
  /** 對應 SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX 軟隔離總開關。 */
  allowExecution: boolean;
  workspaceRoot?: string;
  timeoutMs?: number;
  executable?: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "codex"。 */
  id?: string;
}

/**
 * 以 Codex CLI 進行結構化文字生成。網路瀏覽固定關閉——搜尋交給 WebSearchProvider。
 */
export class CodexStructuredTextProvider implements StructuredTextProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  readonly #options: CodexStructuredTextOptions;

  constructor(options: CodexStructuredTextOptions) {
    this.id = options.id ?? "codex";
    this.#options = options;
    this.availability = options.allowExecution
      ? { status: "available", warning: "Codex 軟隔離：非安全邊界，且消耗 Codex 配額。" }
      : {
          status: "unavailable",
          reason: "需設定 SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 才能使用 Codex 文字生成。",
        };
  }

  /**
   * Codex CLI 的 app-server 協定不回報 token 用量，故 `usage` 一律省略——由帳本正規化成
   * `reported:false`。**不可**填 0：那會讓「Codex 這條通道天生沒有數字」看起來像「這次
   * 真的沒花 token」，而 Codex 正是最耗配額的那一條。
   */
  async runStructured(request: StructuredTextRequest): Promise<StructuredTextResult> {
    if (!this.#options.allowExecution)
      throw new SafeProviderError("CODEX_DISABLED", "Codex 文字生成未啟用。");
    const timeoutMs = request.timeoutMs ?? this.#options.timeoutMs;
    const value = await runCodexStructured({
      workspaceRoot: this.#options.workspaceRoot ?? join(tmpdir(), "slide-maker-codex-structured"),
      webSearchMode: "disabled",
      outputSchema: request.outputSchema,
      prompt: request.prompt,
      ...(request.imagePaths ? { imagePaths: request.imagePaths } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(this.#options.executable ? { executable: this.#options.executable } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { value };
  }
}
