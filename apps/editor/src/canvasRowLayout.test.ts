// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inscribedCanvasArea,
  measureCanvasRowLayout,
  shouldStackTextRail,
  CANVAS_ROW_GAP_PX,
  CANVAS_ROW_STACKED_CLASS,
  TEXT_RAIL_THICKNESS_PX,
} from "./canvasRowLayout.js";

const WIDE = 16 / 9;
/** 實際尺寸：28px 按鈕 ＋ 6px×2 padding ＋ 1px×2 border。 */
const RAIL = TEXT_RAIL_THICKNESS_PX;
const GAP = CANVAS_ROW_GAP_PX;

const decide = (rowWidth: number, rowHeight: number, railThickness = RAIL, gap = GAP) =>
  shouldStackTextRail({
    rowWidth,
    rowHeight,
    canvasAspect: WIDE,
    railThickness,
    columnGap: gap,
    rowGap: gap,
  });

describe("內接畫布面積", () => {
  it("與 styles.css 的 min(cqw, cqh*ar) × min(cqh, cqw/ar) 是同一個矩形", () => {
    // 寬度受限：高度用不完，畫布高＝寬 ÷ ar。
    expect(inscribedCanvasArea(1600, 1000, WIDE)).toBeCloseTo(1600 * (1600 / WIDE), 6);
    // 高度受限：寬度用不完，畫布寬＝高 × ar。
    expect(inscribedCanvasArea(1600, 800, WIDE)).toBeCloseTo(800 * WIDE * 800, 6);
  });

  it("沒有空間或比例不合法時是 0，不是 NaN／負數", () => {
    expect(inscribedCanvasArea(0, 800, WIDE)).toBe(0);
    expect(inscribedCanvasArea(-40, 800, WIDE)).toBe(0);
    expect(inscribedCanvasArea(1600, 0, WIDE)).toBe(0);
    expect(inscribedCanvasArea(1600, 800, 0)).toBe(0);
    expect(inscribedCanvasArea(1600, 800, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("文字工具列方向", () => {
  it("寬度受限（畫布下方本來就空著）時改成橫排", () => {
    // 全螢幕 1920×1080：shell 給舞台 1920-228-360=1332，扣掉左右 padding 後 .canvas-row 約
    // 1280 寬、900 高。1280/900 = 1.42 < 16:9，畫布被寬度夾住，下方空著兩百多 px。
    expect(decide(1280, 900)).toBe(true);
  });

  it("高度受限（水平方向本來就有空白）時維持側排", () => {
    // 最大化的瀏覽器：高度被 chrome 吃掉，1280/620 = 2.06 > 16:9，側欄的寬度不影響畫布。
    expect(decide(1280, 620)).toBe(false);
  });

  it("兩種佈局一樣大時維持側排（預設），不無故換版面", () => {
    // 正方形的列配正方形的畫布：兩邊完全對稱，面積必然相等。
    expect(
      shouldStackTextRail({
        rowWidth: 800,
        rowHeight: 800,
        canvasAspect: 1,
        railThickness: RAIL,
        columnGap: GAP,
        rowGap: GAP,
      }),
    ).toBe(false);
    // 工具列不佔厚度時同樣是平手。
    expect(decide(1280, 900, 0, 0)).toBe(false);
  });

  it("同一組 W×H 下，工具列變厚會把邊界推回側排", () => {
    // 1000×580 是寬度受限但垂直只剩約 17.5px 空白的臨界情形：橫排能不能贏，全看工具列
    // 塞不塞得進那條空白。臨界厚度 = (ar·H − W)/(ar − 1) ≈ 40px。
    expect(decide(1000, 580, 30, 0)).toBe(true);
    expect(decide(1000, 580, 50, 0)).toBe(false);
    // gap 與厚度同樣是被扣掉的空間，兩者一起算。
    expect(decide(1000, 580, 30, 20)).toBe(false);
  });

  it("畫布不是 16:9 時照樣依比例判斷", () => {
    const portrait = (rowWidth: number, rowHeight: number) =>
      shouldStackTextRail({
        rowWidth,
        rowHeight,
        canvasAspect: 9 / 16,
        railThickness: RAIL,
        columnGap: GAP,
        rowGap: GAP,
      });
    // 直式畫布在同一個橫向的列裡永遠是高度受限，橫排只會更小。
    expect(portrait(1280, 900)).toBe(false);
    // 反過來，窄長的列對直式畫布是寬度受限，下方有空白可用。
    expect(portrait(400, 900)).toBe(true);
  });

  it("列還沒有尺寸（首次 render／隱藏）時維持側排", () => {
    expect(decide(0, 0)).toBe(false);
  });

  it("兩種佈局各扣各的那一軸 gap：側排扣 column-gap、橫排扣 row-gap", () => {
    // `.canvas-row` 今天用 `gap` 簡寫、兩軸同值，但決策不該建立在那個巧合上。
    // 這裡把兩軸拉開到極端：橫排那一軸完全沒有間距、側排那一軸大到吃掉整條寬度。
    const layout = {
      rowWidth: 1000,
      rowHeight: 580,
      canvasAspect: WIDE,
      railThickness: 30,
      columnGap: 0,
      rowGap: 0,
    };
    // 基準：兩軸都沒有間距時（見上一條臨界案例）判橫排。
    expect(shouldStackTextRail(layout)).toBe(true);
    // 只加大**橫排**用的 row-gap：橫排要扣的空間變多，翻回側排。
    expect(shouldStackTextRail({ ...layout, rowGap: 20 })).toBe(false);
    // 只加大**側排**用的 column-gap：被懲罰的是側排，橫排照樣勝出（若程式一律拿 column-gap
    // 去算，這一條會錯判成側排）。
    expect(shouldStackTextRail({ ...layout, columnGap: 20 })).toBe(true);
  });
});

describe("從 DOM 量測決策輸入", () => {
  const setBox = (element: HTMLElement, box: { width: number; height: number }) => {
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: box.height });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
    return element;
  };
  const makeRow = () => {
    const row = document.createElement("div");
    row.style.columnGap = "10px";
    document.body.append(row);
    return setBox(row, { width: 1280, height: 900 });
  };
  // 側排時工具列是 42 寬、四顆按鈕疊起來 144 高；橫排時兩軸對調。
  const sideRail = () => setBox(document.createElement("div"), { width: 42, height: 144 });
  const stackedRail = () => setBox(document.createElement("div"), { width: 144, height: 42 });

  /**
   * 厚度＝工具列兩軸的**較小者**，所以不論它現在是直的還是橫的都量到同一個值。
   *
   * 這條原本驗的是「有沒有依目前佈局挑對軸」（挑錯＝把決策的產物餵回輸入，臨界尺寸下會
   * 2-cycle 抖動）。改成取 min 之後那個錯誤在結構上不存在了，於是這裡改驗等價的性質：
   * 量測不再需要知道目前是哪一種佈局，兩種方向的工具列都得到同一個厚度。
   */
  it("厚度取兩軸較小者：工具列不論直排橫排都量到同一個值", () => {
    const row = makeRow();
    expect(measureCanvasRowLayout(row, sideRail(), WIDE).railThickness).toBe(42);
    row.classList.add(CANVAS_ROW_STACKED_CLASS);
    expect(measureCanvasRowLayout(row, stackedRail(), WIDE).railThickness).toBe(42);
    // 類別是給 CSS 用的，量測不讀它：拿掉之後同一個工具列仍然量到 42。
    row.classList.remove(CANVAS_ROW_STACKED_CLASS);
    expect(measureCanvasRowLayout(row, stackedRail(), WIDE).railThickness).toBe(42);
  });

  it("側排長出傳統捲軸把長邊撐寬時，厚度仍是真正的薄邊", () => {
    // Windows/Edge 的傳統捲軸：視窗極矮時側排的工具列會自己捲，offsetWidth 變成 42+15。
    // 固定讀「直排就看 offsetWidth」會把 57 當厚度，決策跟著偏向橫排。
    const scrolling = setBox(document.createElement("div"), { width: 57, height: 300 });
    expect(measureCanvasRowLayout(makeRow(), scrolling, WIDE).railThickness).toBe(57);
    // ↑ 這是誠實的：真的被捲軸撐寬時 57 就是它佔的水平空間。翻成橫排之後兩軸對調、
    //   捲軸消失，量到的才是真正的薄邊 42——重點是兩種情形都不必問「現在是哪一種佈局」。
    const stackedNoScrollbar = setBox(document.createElement("div"), { width: 300, height: 42 });
    expect(measureCanvasRowLayout(makeRow(), stackedNoScrollbar, WIDE).railThickness).toBe(42);
  });

  it("工具列未掛載（這一頁還沒有圖）時退回常數，不是 0", () => {
    expect(measureCanvasRowLayout(makeRow(), null, WIDE).railThickness).toBe(
      TEXT_RAIL_THICKNESS_PX,
    );
  });

  it("量得到 gap 就用量到的，量不到才退回常數", () => {
    const row = makeRow();
    row.style.rowGap = "14px";
    const measured = measureCanvasRowLayout(row, sideRail(), WIDE);
    // 兩軸各自量各自的，不假設同值。
    expect(measured).toMatchObject({ columnGap: 10, rowGap: 14 });
    row.style.columnGap = "";
    row.style.rowGap = "";
    expect(measureCanvasRowLayout(row, sideRail(), WIDE)).toMatchObject({
      columnGap: CANVAS_ROW_GAP_PX,
      rowGap: CANVAS_ROW_GAP_PX,
    });
  });

  it("computed 的 `normal` 是「沒有間距」＝0，不是「讀不到」", () => {
    // flex `gap` 的初始值就是 `normal`，語意是 0。把它當讀不到而退回常數，等於有人把
    // `.canvas-row` 的 gap 拿掉之後，決策憑空多扣 10px（兩種佈局都被扣，邊界因此偏移）。
    const row = makeRow();
    row.style.columnGap = "normal";
    row.style.rowGap = "normal";
    expect(measureCanvasRowLayout(row, sideRail(), WIDE)).toMatchObject({
      columnGap: 0,
      rowGap: 0,
    });
  });

  it("尺寸取自畫布列自己，量到的值直接餵決策函式", () => {
    const layout = measureCanvasRowLayout(makeRow(), sideRail(), WIDE);
    expect(layout).toMatchObject({ rowWidth: 1280, rowHeight: 900, canvasAspect: WIDE });
    expect(shouldStackTextRail(layout)).toBe(true);
  });

  it("列的尺寸是 0（首次掛載、還沒有版面）時量得出 0 並維持側排，不是 NaN", () => {
    // `measureCanvasRowLayout` 直接讀 clientWidth/clientHeight，元素還沒有版面時兩者都是 0。
    // 這裡走的是**量測**那條路（describe 上面那條 `decide(0, 0)` 只驗決策函式本身），因為
    // 真正會在首次 render 收到 0 的是量測：它若把 0 變成 NaN，決策就會落進未定義行為。
    const row = setBox(document.createElement("div"), { width: 0, height: 0 });
    document.body.append(row);
    const layout = measureCanvasRowLayout(row, null, WIDE);
    expect(layout).toMatchObject({ rowWidth: 0, rowHeight: 0 });
    expect(Number.isFinite(layout.railThickness)).toBe(true);
    expect(shouldStackTextRail(layout)).toBe(false);
  });

  it("直式畫布（--ar < 1）走量測路徑時同樣維持側排", () => {
    // 畫布比例是專案給的，直式簡報（9:16）在橫向的視窗裡永遠是高度受限，橫排只會讓畫布更小。
    // 這條與上面純算式的 portrait 案例不同：它確認**量測**把 canvasAspect 原樣帶進決策，
    // 沒有在中途被硬寫成 16:9。
    const layout = measureCanvasRowLayout(makeRow(), sideRail(), 9 / 16);
    expect(layout.canvasAspect).toBe(9 / 16);
    expect(shouldStackTextRail(layout)).toBe(false);
  });

  /**
   * 收斂（不動點）：把「量測 → 決策 → 套上類別 → 再量測」整條閉迴路真的跑起來。
   *
   * 這是這個功能最容易壞、也最難靠單點斷言看出來的一條：工具列換方向會讓它自己的兩軸對調，
   * 只要有任何一處把「決策的產物」餵回「決策的輸入」（讀錯軸、拿畫布欄的剩餘空間當輸入），
   * 版面就會每次 resize 都來回翻。單一尺寸抓不到——1280×900 這種離邊界很遠的尺寸，就算讀錯
   * 軸也照樣收斂到同一個答案；只有**臨界尺寸**（1000×600：正確厚度 42 判橫排、錯讀成 144
   * 判側排）才翻得起來。所以這裡掃一整片尺寸，每一格都要求第二次量測起就是不動點。
   *
   * 厚度改成取兩軸較小者之後，這裡連**第一輪**都必須與後續相同（工具列怎麼轉都量到 42），
   * 所以斷言直接要求整串答案一模一樣——比原本的「第二輪起是不動點」更緊。
   */
  it("量測是閉迴路的不動點：任何尺寸重複量都停在同一個答案", () => {
    const row = makeRow();
    const rail = document.createElement("div");
    // 工具列的兩軸跟著自己的方向對調，與真實 DOM 一致：直排 42×144、橫排 144×42。
    const stackedNow = () => row.classList.contains(CANVAS_ROW_STACKED_CLASS);
    Object.defineProperty(rail, "offsetWidth", { get: () => (stackedNow() ? 144 : 42) });
    Object.defineProperty(rail, "offsetHeight", { get: () => (stackedNow() ? 42 : 144) });

    for (const width of [0, 400, 800, 1000, 1100, 1280, 1600, 2400])
      for (const height of [0, 560, 600, 620, 720, 900, 1300])
        for (const aspect of [WIDE, 4 / 3, 9 / 16]) {
          setBox(row, { width, height });
          row.classList.remove(CANVAS_ROW_STACKED_CLASS);
          const seen: boolean[] = [];
          for (let round = 0; round < 6; round += 1) {
            const next = shouldStackTextRail(measureCanvasRowLayout(row, rail, aspect));
            row.classList.toggle(CANVAS_ROW_STACKED_CLASS, next);
            seen.push(next);
          }
          // 每一輪都必須是同一個答案：中途翻一次就代表版面在真瀏覽器裡會抖。
          expect({ width, height, aspect, seen }).toMatchObject({
            seen: seen.map(() => seen[0]),
          });
        }
  });
});

/**
 * CSS 與 JS 之間唯一的握手：類別名。
 *
 * JS 這邊由 `CANVAS_ROW_STACKED_CLASS` 單點定義，但 styles.css 只能寫字面值——兩邊對不上時
 * 類別照樣掛得上去、jsdom 也量不出版面，所有既有測試都會是綠的，畫面上卻完全沒有換方向。
 * 這條把那個縫補起來：規則必須存在，而且要真的把 `.canvas-row` 轉成直向堆疊。
 */
describe("橫排類別的 CSS 規則", () => {
  // 刻意不用 `new URL("./styles.css", import.meta.url)`：Vite 會在轉譯期把那個樣式改寫成
  // 資產 URL（http），拿不回檔案路徑。
  const css = readFileSync(join(fileURLToPath(import.meta.url), "..", "styles.css"), "utf8");

  /**
   * 走訪所有規則（含 `@media` 內的）。
   *
   * 刻意手寫一個認得大括號巢狀的掃描器，而不是再多一條正則：`.stage` 之類的選擇器在
   * `@media` 裡也有一份，`[^}]*` 那種寫法會在第一個 `}` 就停下來、把 at-rule 的內容連同
   * 外層規則一起吃錯。
   */
  function* eachRule(source: string): Generator<{ selectors: string[]; body: string }> {
    let index = 0;
    while (index < source.length) {
      const open = source.indexOf("{", index);
      if (open === -1) return;
      const prelude = source.slice(index, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = source.slice(open + 1, cursor - 1);
      // at-rule（@media／@keyframes…）本身不是規則，要進去看裡面那一層。
      if (prelude.startsWith("@")) yield* eachRule(body);
      else yield { selectors: prelude.split(",").map((part) => part.trim()), body };
      index = cursor;
    }
  }

  /** 某個選擇器最終生效的宣告（同名選擇器有多條規則時，後面的蓋前面的）。 */
  const declarations = (selector: string): Record<string, string> => {
    const merged: Record<string, string> = {};
    for (const rule of eachRule(css.replace(/\/\*[\s\S]*?\*\//g, "")))
      if (rule.selectors.includes(selector))
        for (const declaration of rule.body.split(";")) {
          const colon = declaration.indexOf(":");
          if (colon === -1) continue;
          merged[declaration.slice(0, colon).trim()] = declaration
            .slice(colon + 1)
            .trim()
            .replace(/\s+/g, " ");
        }
    return merged;
  };

  it("styles.css 有 JS 掛上去的那個類別，且它把畫布列改成上下堆疊", () => {
    const rule = new RegExp(`\\.${CANVAS_ROW_STACKED_CLASS}\\s*\\{([^}]*)\\}`).exec(css);
    expect(rule?.[1]).toMatch(/flex-direction:\s*column/);
  });

  it("工具列在橫排底下改成水平排列", () => {
    const rule = new RegExp(
      `\\.${CANVAS_ROW_STACKED_CLASS}\\s+\\.text-layer-rail\\s*\\{([^}]*)\\}`,
    ).exec(css);
    expect(rule?.[1]).toMatch(/flex-direction:\s*row/);
  });

  it("橫排時畫布欄不再吞掉整條剩餘高度，工具列才會貼在畫布正下方", () => {
    // 沒有這條（`.canvas-fit` 維持 flex: 1 1 auto、畫布又貼齊頂端），工具列會被推到整列的
    // 最底緣：實測 1440×900 下與畫布底緣相隔 180px、1920×1080 相隔 93px，工具列與它操作的
    // 畫布視覺上脫節，換來的畫布寬度就白換了。高度必須用**整列**的兩軸算（cq 單位），
    // 而且要留 shrink，厚度對不上時寧可縮畫布也不要把工具列擠出列外。
    const fit = declarations(`.${CANVAS_ROW_STACKED_CLASS} .canvas-fit`);
    expect(fit["flex"]).toBe("0 1 auto");
    expect(fit["height"]).toMatch(/^min\(/);
    expect(fit["height"]).toContain("100cqh");
    expect(fit["height"]).toContain("100cqw");
    expect(fit["height"]).toContain("var(--text-rail-thickness)");
    expect(fit["height"]).toContain("var(--canvas-row-gap)");
    // 整組垂直置中，空白上下對半（而不是全部堆在畫布下方）。
    expect(declarations(`.${CANVAS_ROW_STACKED_CLASS}`)["justify-content"]).toBe("center");
  });

  /**
   * 防震盪的 CSS 地基。
   *
   * 整個「不會抖動」的論證建立在「`.canvas-row` 的尺寸與內部工具列方向無關」上，而那不是
   * JS 保證得了的事，是這幾條 CSS 撐出來的：舞台有確定的高度、只有畫布列會吸收縮放、
   * 畫布列自己又與內容無關。它們任何一條被改掉，**JS 測試會全綠而畫面在抖**——這是這個
   * 功能最貴的失效模式，所以直接讀 styles.css 把它們釘住。
   */
  describe("CSS 幾何地基", () => {
    it("舞台高度是確定的：.shell 撐滿視窗高、把中欄交給 1fr", () => {
      // 少了確定的高度，`.canvas-row` 的 flex 就沒有「剩餘空間」可分，量到的尺寸會隨內容變動
      //（工具列一換方向就跟著變）——決策的輸入從此不穩定。
      const shell = declarations(".shell");
      expect(shell["height"]).toBe("100vh");
      expect(shell["display"]).toBe("grid");
      expect(shell["grid-template"]).toMatch(/^52px\s+1fr\s*\//);
      expect(declarations(".stage")).toMatchObject({
        "min-height": "0",
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
      });
    });

    it("只有 .canvas-row 在吸收縮放：它可縮，而上面那排狀態列不可縮", () => {
      // `.stage-meta` 若也拿到 `min-height: 0`，視窗變矮時它會跟著被壓縮，`.canvas-row` 的
      // 高度就不再是「舞台高度減去固定的 chrome」，兩者會一起浮動。
      expect(declarations(".canvas-row")).toMatchObject({
        flex: "1 1 auto",
        "min-height": "0",
      });
      // 先確認真的讀到了那條規則，否則「沒有 min-height」會是空物件的假綠。
      expect(declarations(".stage-meta")).toMatchObject({ display: "flex" });
      expect(declarations(".stage-meta")).not.toHaveProperty("min-height");
    });

    it("畫布列的尺寸與內容無關，而且沒有 padding／border 讓量測失準", () => {
      const row = declarations(".canvas-row");
      // `container-type: size` ＝ `contain: size`：內容（含工具列）不會反過來撐大這一列。
      expect(row["container-type"]).toBe("size");
      // JS 讀的是 clientWidth/clientHeight（padding box、不含 border）。這一列一旦有 padding，
      // 那組數字就會高估可用空間、決策偏向橫排，而且沒有任何 JS 測試會紅。
      for (const property of Object.keys(row))
        expect(property).not.toMatch(/^(padding|border)(-|$)/);
    });

    it("JS 的退路常數與 CSS 的自訂屬性是同一個值", () => {
      const row = declarations(".canvas-row");
      expect(row["--text-rail-thickness"]).toBe(`${TEXT_RAIL_THICKNESS_PX}px`);
      expect(row["--canvas-row-gap"]).toBe(`${CANVAS_ROW_GAP_PX}px`);
      expect(row["gap"]).toBe("var(--canvas-row-gap)");
    });

    it("工具列的厚度真的是 28 + 6×2 + 1×2 = 42：按鈕、padding、border 三者加起來", () => {
      // 常數與自訂屬性都寫著 42，但那個 42 是從這三個數字加出來的。誰改了按鈕尺寸或 padding
      // 卻沒同步改常數，橫排的高度算式就會與工具列實際佔的空間差幾 px（畫布跟著錯位）。
      const px = (value: string | undefined) => Number.parseFloat(value ?? "");
      const rail = declarations(".text-layer-rail");
      const button = declarations(".text-layer-rail button");
      expect(px(button["width"])).toBe(px(button["height"]));
      expect(px(button["width"]) + 2 * px(rail["padding"]) + 2 * px(rail["border"])).toBe(
        TEXT_RAIL_THICKNESS_PX,
      );
    });
  });
});
