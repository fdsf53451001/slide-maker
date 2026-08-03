import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 用 `fs` 讀而不是 `import "./styles.css?raw"`：Vitest 預設 `css: false`，CSS 匯入會回空值，
 * 拿它去斷言的話每一條都在對空字串比對——測試會紅得莫名，改對了也不會綠。
 */
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/**
 * 釘住一整類**在其他測試裡隱形**的失效：`var(--沒定義的東西)`。
 *
 * CSS 自訂屬性沒有定義時，引用它的那條宣告會在「計算值」階段整條失效，屬性退回初始值——
 * `background-color` 於是變成 `transparent`。這件事三道現有防線全都攔不到：`tsc` 不看 CSS、
 * jsdom 不套用外部樣式表（`getComputedStyle` 一律回空字串或 0），Prettier 只管排版。
 * 實機災情：`.recent-updates-modal` 寫成 `background: var(--surface-card)`，而整份 styles.css
 * 沒有這個 token——「最近更新」面板整片透明，底下的專案縮圖從字底下透上來，使用者回報
 * 「看不到」。當時 411 個測試全綠。
 *
 * 只掃 styles.css 自己就夠了：這個專案的 token 全部宣告在同一份檔案的 `:root`。
 */

/**
 * 由 JS 以 inline style 餵進來、所以**不會**出現在 styles.css 裡的變數。
 * 顯式列舉而非用模式放行——名單看一眼就知道總共豁免了誰，讓規則自己漏過來則不可稽核。
 */
const SET_BY_JS = new Set([
  // Editor.tsx 把畫布比例（寬÷高，純數字）掛在 .canvas 的 style 上餵給 calc()。
  "--ar",
]);

function declaredTokens(source: string): Set<string> {
  return new Set(source.match(/--[A-Za-z0-9-]+(?=\s*:)/g) ?? []);
}

function referencedTokens(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((match) => match[1] as string),
  );
}

describe("styles.css 的自訂屬性", () => {
  it("每個 var() 引用的 token 都有定義（JS 注入的除外）", () => {
    const declared = declaredTokens(css);
    const orphans = [...referencedTokens(css)]
      .filter((token) => !declared.has(token) && !SET_BY_JS.has(token))
      .sort();
    expect(orphans).toEqual([]);
  });

  /*
    精靈裡「尚未填寫」的欄位（不填需求就開始的專案，STEP 2 的簡報需求就是空的）只在 DOM 上
    掛一個 class，橘框整個押在這份 CSS 上——jsdom 不套樣式表，元件測試斷言得到 class、
    斷言不到使用者看不看得見。
  */
  it("尚未填寫的欄位有橘色外框，而且不吃掉焦點光暈", () => {
    const rule = [...css.matchAll(/([^{}]*\.field-needs-input[^{}]*)\{([^}]*)\}/g)].find((match) =>
      /border-color/.test(match[2] ?? ""),
    );
    expect(rule).toBeDefined();
    expect(rule![2]).toMatch(/var\(--accent\)/);
    // 這條選擇器比 `.setup-card textarea:focus` 更特異，少了 `:not(:focus)` 就會蓋掉焦點的
    // 3px 光暈——而聚焦樣式把 outline 關掉了，那圈光暈是唯一的焦點指示。
    expect(rule![1]).toMatch(/:not\(:focus\)/);
  });

  it("「最近更新」面板的底色是不透明的", () => {
    // 疊在儀表板上的面板一旦有透明度，後面的縮圖與卡片就會從字底下透上來。
    // 這裡比對字面值而不是算出來的顏色：jsdom 不套用樣式表，量不到 computed style。
    const rule = /\.recent-updates-modal\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toBe("");
    const background = /background(?:-color)?\s*:\s*([^;]+);/.exec(rule)?.[1]?.trim();
    expect(background).toBeDefined();
    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
