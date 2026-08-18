import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  remapTextRuns,
  resolveTextRuns,
  textStroke,
  type EditableTextBox,
} from "@slide-maker/core";
import { strokeCssColor, textBoxBackground, RESIZE_DIRECTIONS } from "./textBoxModel.js";

export function TextLayerCanvas({
  background,
  boxes,
  canvasWidth,
  canvasHeight,
  selectedId,
  onSelect,
  onChange,
}: {
  background: string;
  boxes: EditableTextBox[];
  canvasWidth: number;
  canvasHeight: number;
  selectedId: string | undefined;
  onSelect: (id?: string) => void;
  onChange: (boxes: EditableTextBox[]) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string>();
  // 拖曳期間的暫存框：只在放開時 commit 一次，避免每個 pointermove 都寫入 undo 歷史與觸發自動儲存。
  const [dragBoxes, setDragBoxes] = useState<EditableTextBox[]>();
  const drag = useRef<
    | {
        id: string;
        direction: "move" | (typeof RESIZE_DIRECTIONS)[number];
        x: number;
        y: number;
        clientX: number;
        clientY: number;
        box: EditableTextBox;
        moved?: boolean;
      }
    | undefined
  >(undefined);
  const point = (event: ReactPointerEvent) => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * canvasWidth) / bounds.width,
      y: ((event.clientY - bounds.top) * canvasHeight) / bounds.height,
    };
  };
  const begin = (
    event: ReactPointerEvent,
    box: EditableTextBox,
    direction: "move" | (typeof RESIZE_DIRECTIONS)[number],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const start = point(event);
    drag.current = {
      id: box.id,
      direction,
      x: start.x,
      y: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      box: structuredClone(box),
    };
    if (editingId !== box.id) setEditingId(undefined);
    onSelect(box.id);
    // 焦點主動搬到畫布：這裡的 preventDefault（拖曳必須擋掉原生的圖片拖放與文字選取）
    // 同時也擋掉了瀏覽器移動焦點。剛在側邊面板改完欄位再回來點框時，焦點還留在那個
    // input 上，接著按 Delete 會被 isTypingTarget 放行給輸入框——選了框卻刪不掉，
    // 而且完全沒有回饋。放寬 isTypingTarget 不是辦法（那會讓面板裡刪字元變成刪框）。
    stageRef.current?.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic or already-ended pointers can reject capture; selection must still succeed.
    }
  };
  const move = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active) return;
    // 死區用螢幕像素判斷（畫布座標會隨顯示尺寸縮放，雙擊間的手震在小視窗會誤觸拖曳）。
    //
    // 八個 resize 方向與 `move` 共用同一個死區，不可把 resize 排除在外：把手上的雙擊是
    // **正式支援的手勢**（見 text-box-handle-doubleclick.test.tsx），而只有一個字的框，
    // 八個把手幾乎鋪滿整個框身——沒有死區時，雙擊過程中 1 螢幕像素的手抖就會 commit
    // 一次縮放（960px 畫布渲染 1920 canvas，1px＝2 canvas 單位），連帶標 dirty、推一筆
    // undo、觸發自動存檔讓伺服器重跑合成，而使用者只是想編輯文字。
    // 取捨：死區只在 `!active.moved` 時作用，一旦跨過 3px 就 `moved = true`，之後任何
    // 微小移動照常生效——所以「刻意的 1–2px 微調」不是做不到，只是不能一步到位（先拖出
    // 3px 再拖回來）；inspector 目前沒有寬高數值欄位可以退回，這一點一併記著。
    // **不要**改採「在 finish() 比對幾何，沒變就不 onChange」：1px 抖動確實讓幾何變了
    // （300→302），那個比對照樣會 commit，等於沒修。
    if (
      !active.moved &&
      Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) < 3
    )
      return;
    active.moved = true;
    const current = point(event);
    const dx = current.x - active.x;
    const dy = current.y - active.y;
    let { x, y, width, height } = active.box;
    if (active.direction === "move") {
      x += dx;
      y += dy;
    } else {
      if (active.direction.includes("e")) width += dx;
      if (active.direction.includes("s")) height += dy;
      if (active.direction.includes("w")) {
        x += dx;
        width -= dx;
      }
      if (active.direction.includes("n")) {
        y += dy;
        height -= dy;
      }
    }
    width = Math.max(24, width);
    height = Math.max(18, height);
    x = Math.max(0, Math.min(canvasWidth - width, x));
    y = Math.max(0, Math.min(canvasHeight - height, y));
    setDragBoxes(
      boxes.map((box) => (box.id === active.id ? { ...box, x, y, width, height } : box)),
    );
  };
  const finish = (commit: boolean) => {
    if (commit && drag.current?.moved && dragBoxes) onChange(dragBoxes);
    drag.current = undefined;
    setDragBoxes(undefined);
  };
  return (
    <div
      ref={stageRef}
      className="text-layer-canvas"
      // 只為了「選取文字框時把焦點收回畫布」而可聚焦（見 begin）；-1 代表不進 Tab 順序，
      // 鍵盤使用者的 Tab 巡覽維持原樣。焦點環要關掉：全域的 `[tabindex]:focus-visible`
      // 會在「剛從面板欄位（鍵盤焦點）點回畫布」時整塊畫布亮一圈藍框，看起來像畫布被選取；
      // 這個元素進不了 Tab 順序，只由程式聚焦，關掉不影響鍵盤巡覽。
      tabIndex={-1}
      style={{ outline: "none" }}
      onPointerMove={move}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onPointerDown={() => {
        setEditingId(undefined);
        onSelect(undefined);
      }}
    >
      <img src={background} alt="文字抽離乾淨背景" />
      {(dragBoxes ?? boxes)
        .filter((box) => box.role === "presentation")
        .map((box) => {
          const lineCount = Math.max(1, box.text.split("\n").length);
          const textHeight = box.fontSize * box.lineHeight * lineCount;
          const spareHeight = Math.max(0, box.height - textHeight);
          const verticalOffset =
            box.verticalAlign === "bottom"
              ? spareHeight
              : box.verticalAlign === "middle"
                ? spareHeight / 2
                : 0;
          const editing = editingId === box.id && selectedId === box.id;
          const boxStroke = textStroke(box);
          const runs = resolveTextRuns(box);
          /*
           * `<textarea>` 畫不出多色文字——它沒有子節點，整個控制項只有一個 `color`。
           * 所以多色框在非編輯狀態改由一層 `<div>` 疊上去畫（每段一個 `<span>`），
           * textarea 本身的字設成透明但留在原位：它仍然負責雙擊進入編輯、鍵盤操作與
           * 焦點，換掉它會連帶動到那些行為。
           *
           * 兩層的字型、字級、行高、字距、對齊、內距與 400% 放大**必須逐一相同**，
           * 疊起來才會嚴絲合縫，所以樣式抽成同一個物件共用，不是各寫一份。
           * 編輯中不疊 overlay：那時使用者看到的是單色的真文字，退出編輯就恢復多色。
           */
          const showRunOverlay = runs.length > 1 && !editing;
          const overflowStyle = editing
            ? {}
            : {
                width: "400%",
                height: "400%",
                ...(box.align === "center"
                  ? { left: "-150%" }
                  : box.align === "right"
                    ? ({ left: "auto", right: 0 } as const)
                    : {}),
              };
          const textStyle = {
            fontFamily: box.fontFamily,
            fontSize: `${(box.fontSize / canvasHeight) * 100}cqh`,
            fontWeight: box.fontWeight,
            opacity: box.opacity,
            lineHeight: box.lineHeight,
            letterSpacing: `${box.letterSpacing}px`,
            textAlign: box.align,
            ...(boxStroke
              ? {
                  WebkitTextStrokeWidth: `${(boxStroke.widthPx / canvasHeight) * 100}cqh`,
                  WebkitTextStrokeColor: strokeCssColor(boxStroke),
                  paintOrder: "stroke" as const,
                }
              : {}),
            paddingTop: `${(verticalOffset / canvasHeight) * 100}cqh`,
            ...overflowStyle,
          };
          return (
            <div
              key={box.id}
              className={`editable-text-box ${selectedId === box.id ? "selected" : ""} ${editing ? "editing" : ""}`}
              style={{
                left: `${(box.x / canvasWidth) * 100}%`,
                top: `${(box.y / canvasHeight) * 100}%`,
                width: `${(box.width / canvasWidth) * 100}%`,
                height: `${(box.height / canvasHeight) * 100}%`,
                transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
                // 底色畫在容器層（容器尺寸正好等於框），不能掛在裡面的 textarea 上：
                // 非編輯狀態時那個 textarea 被刻意放大成 400% 用來顯示溢出文字，
                // 底色跟著糊成四倍大就與 SVG／PPTX 兩端對不上。
                background: textBoxBackground(box),
              }}
              onPointerDown={(event) => {
                if (editing) {
                  event.stopPropagation();
                  return;
                }
                begin(event, box, "move");
              }}
              onDoubleClick={(event) => {
                setEditingId(box.id);
                onSelect(box.id);
                event.currentTarget.querySelector("textarea")?.focus();
              }}
            >
              <textarea
                aria-label="可編輯簡報文字"
                readOnly={!editing}
                value={box.text}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  setEditingId(undefined);
                  event.currentTarget.blur();
                }}
                onChange={(event) =>
                  onChange(
                    boxes.map((candidate) => {
                      if (candidate.id !== box.id) return candidate;
                      const text = event.target.value;
                      /*
                       * 改字時把顏色分段跟著搬過去。少了這一步，改一個錯字就會讓
                       * 這一行的強調色錯位（`resolveTextRuns` 會把沒被蓋到的尾巴退回
                       * 框的預設色），使用者於是不敢碰抽出來的字。
                       * 全部刪光或分段塌成一段時 `remapTextRuns` 回 undefined，
                       * 這裡就把欄位整個移除（`exactOptionalPropertyTypes`）。
                       */
                      const runs = remapTextRuns(candidate.text, text, candidate.runs);
                      if (!runs) {
                        const { runs: _dropped, ...rest } = candidate;
                        return { ...rest, text };
                      }
                      return { ...candidate, text, runs };
                    }),
                  )
                }
                style={{
                  ...textStyle,
                  // 多色框在非編輯狀態把 textarea 的字藏起來，由下面的 overlay 畫彩色文字；
                  // 進入編輯時換回單色的真字（textarea 畫不出多色，見 overlay 的註解）。
                  color: showRunOverlay ? "transparent" : box.color,
                  caretColor: box.color,
                  /*
                   * 描邊。長度一律走 `cqh`（與 fontSize、paddingTop 同一套），不可寫裸 px：
                   * 畫布沒有用 `transform: scale`，尺寸全靠容器查詢單位算出來，絕對 px 不會
                   * 跟著畫布縮放，編輯畫面與匯出的描邊粗細就會對不上。
                   *
                   * `paintOrder: "stroke"` **不可省**：CSS 預設先填色再描邊，而描邊跨在字形
                   * 輪廓上，少了它描邊會蓋掉字面。Chromium 實測（Chrome 150）純白字心像素
                   * 2691 → 6312、黑色 4497 → 1434，也就是不加的話字被吃掉一大半。
                   * WebKit／Gecko 對 HTML 文字的 paint-order 支援度未逐一驗證，這是預設寬度
                   * 壓在 0.04em 的另一個理由：即使某個瀏覽器忽略 paint-order，那個寬度下字
                   * 只是變粗，不會變成黑塊。
                   */
                }}
              />
              {showRunOverlay && (
                <div className="text-run-overlay" aria-hidden="true" style={textStyle}>
                  {runs.map((run, index) => (
                    <span key={index} style={{ color: run.color }}>
                      {run.text}
                    </span>
                  ))}
                </div>
              )}
              {selectedId === box.id &&
                !editing &&
                RESIZE_DIRECTIONS.map((direction) => (
                  <button
                    key={direction}
                    /*
                     * 把手只吃指標事件，所以退出 Tab 順序與無障礙樹。
                     *
                     * 它們是真的 `<button>`，在此之前每選取一個文字框就多出八個可以 Tab 到、
                     * 按 Enter／Space 卻毫無反應的停點，而播報出來的還是「調整文字框 se」
                     * 「調整文字框 nw」——`n`／`ne`／`se` 是內部方向碼，對使用者沒有意義。
                     * 宣告成可按卻按不動，比一開始就不宣告更糟。
                     *
                     * 這是止血、不是修好：文字框的移動與縮放目前對鍵盤使用者**完全不可達**，
                     * 而 inspector 也沒有寬高數值欄位可以退回（見 `move` 死區那段註解）。
                     * 完整解法是在框身綁方向鍵移動／Shift+方向鍵縮放，那是獨立的一次改動。
                     *
                     * `aria-label` 留著只當測試與除錯的定位鉤子（`aria-hidden` 之後它進不了
                     * 播報），不是給使用者聽的字。
                     */
                    tabIndex={-1}
                    aria-hidden="true"
                    aria-label={`調整文字框 ${direction}`}
                    className={`text-resize-handle ${direction}`}
                    onPointerDown={(event) => begin(event, box, direction)}
                    /*
                     * 雙擊**刻意不攔**，讓它冒泡到框身的「進入編輯」。
                     *
                     * 八個把手各 10px 又外擴 6px，只有一個字的框本身可能不到 20px：把手
                     * 幾乎鋪滿整個框，雙擊必定落在把手上，於是那種框永遠進不了編輯狀態
                     * （使用者實測回報的正是這個）。縮放靠的是 pointerdown＋拖曳位移，
                     * 而雙擊的兩次點擊在 pointerup 時就各自 finish() 收乾淨了，零位移的
                     * 那次不會 commit 任何尺寸，所以放行 dblclick 不會與縮放打架。
                     */
                  />
                ))}
            </div>
          );
        })}
    </div>
  );
}
