import { describe, expect, it } from "vitest";
import { formatStartupStatus } from "../src/startup-status.js";

describe("startup provider status", () => {
  it("reports the bind address and the quota-free default provider", () => {
    const output = formatStartupStatus({ baseUrl: "http://127.0.0.1:4173" }).join("\n");
    expect(output).toContain("http://127.0.0.1:4173");
    expect(output).toContain("Mock image provider is active");
  });

  // 啟動訊息永遠不該回聲環境變數的值：那是最容易把 API key 印進 log 的地方。
  it("never echoes environment values", () => {
    const output = formatStartupStatus({ baseUrl: "http://127.0.0.1:4173" }).join("\n");
    expect(output).not.toMatch(/SLIDE_MAKER_[A-Z_]+=/);
  });
});
