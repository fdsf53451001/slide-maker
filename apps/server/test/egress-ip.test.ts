import { describe, expect, it } from "vitest";
import { egressLoggingEnabled, logEgressAddresses } from "../src/egress-ip.js";

function collect(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => lines.push(message), lines };
}

describe("egress address logging", () => {
  it("stays off unless explicitly enabled", () => {
    expect(egressLoggingEnabled({})).toBe(false);
    expect(egressLoggingEnabled({ SLIDE_MAKER_LOG_EGRESS_IP: "0" })).toBe(false);
    expect(egressLoggingEnabled({ SLIDE_MAKER_LOG_EGRESS_IP: "true" })).toBe(false);
    expect(egressLoggingEnabled({ SLIDE_MAKER_LOG_EGRESS_IP: "1" })).toBe(true);
  });

  it("logs both families when the echo services answer", async () => {
    const { log, lines } = collect();
    await logEgressAddresses(log, (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.includes("api6.") ? "2001:db8::1" : "203.0.113.7");
    }) as typeof fetch);
    expect(lines).toContain("Egress IPv4: 203.0.113.7");
    expect(lines).toContain("Egress IPv6: 2001:db8::1");
  });

  it("never throws when a probe fails, so startup is unaffected", async () => {
    const { log, lines } = collect();
    await expect(
      logEgressAddresses(log, (async () => {
        throw new Error("network unreachable");
      }) as typeof fetch),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/探測失敗/);
  });

  /**
   * 回聲服務的回應是外部輸入。若它回的是 HTML 錯誤頁或一段文字，照抄進 log 等於讓
   * 外部內容決定 log 的內容；只接受 isIP 認得的短字串。
   */
  it("refuses to log a response that is not an IP address", async () => {
    const { log, lines } = collect();
    await logEgressAddresses(
      log,
      (async () => new Response("<html>rate limited</html>")) as typeof fetch,
    );
    for (const line of lines) expect(line).toContain("未回傳可辨識的位址");
    expect(lines.join("\n")).not.toContain("html");
  });

  it("ignores an over-long body even when it starts with an address", async () => {
    const { log, lines } = collect();
    await logEgressAddresses(
      log,
      (async () => new Response(`203.0.113.7${"x".repeat(200)}`)) as typeof fetch,
    );
    for (const line of lines) expect(line).toContain("未回傳可辨識的位址");
  });

  it("treats a non-2xx response as no answer rather than logging its body", async () => {
    const { log, lines } = collect();
    await logEgressAddresses(
      log,
      (async () => new Response("203.0.113.7", { status: 503 })) as typeof fetch,
    );
    for (const line of lines) expect(line).toContain("未回傳可辨識的位址");
  });
});
