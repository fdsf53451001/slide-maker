import { useState, type RefObject } from "react";
import type { PresentationProject } from "@slide-maker/core";
import { api } from "../api.js";
import { currentImage } from "./projectHelpers.js";
import { SlideVisibilityIcon } from "./icons.js";

/**
 * 左側縮圖列：頁面清點、新增空白頁、拖曳排序，以及每一格的隱藏／複製／刪除。
 *
 * `draggedId` 是這裡的**內部狀態**（整個編輯器只有拖曳排序這一段讀寫它）。四個頁面
 * 操作一律走呼叫端的 `runThumbAction`，那份共用 busy 的理由見它的 JSDoc——不可在這裡
 * 各自 `run()`。
 */
export function SlideRail({
  project,
  selectedSlideId,
  thumbBusy,
  newSlideBusy,
  slideCountTitle,
  visibleSlideCount,
  hiddenCount,
  railRef,
  onSelect,
  onAddSlide,
  runThumbAction,
}: {
  project: PresentationProject;
  selectedSlideId: string | undefined;
  thumbBusy: boolean;
  newSlideBusy: boolean;
  slideCountTitle: string;
  visibleSlideCount: number;
  hiddenCount: number;
  railRef: RefObject<HTMLDivElement | null>;
  onSelect: (slideId: string) => void;
  onAddSlide: () => Promise<void>;
  runThumbAction: (operation: () => Promise<PresentationProject>) => Promise<void>;
}) {
  const [draggedId, setDraggedId] = useState<string>();
  return (
    <aside className="rail">
      <div className="rail-heading">
        <span>PAGES</span>
        <span className="rail-heading-count">
          <b title={slideCountTitle}>
            {/* 「14/17」被螢幕閱讀器念成「十四斜線十七」，等於沒有資訊：數字給眼睛，
              完整句子給閱讀器，兩者互斥地各出現一次，不會被重複播報。
              已知缺口：`title` 只有滑鼠 hover 讀得到（`<b>` 不可聚焦，而原生 tooltip
              本來也不在鍵盤焦點上顯示），所以「不用滑鼠、也不用閱讀器」的人看不到
              這句話。刻意不為它加 `tabIndex`（憑空多一個沒有動作的 Tab 停點）或改寫
              成自製 tooltip 元件——閱讀器那條路已經完整，剩下的缺口不值那個成本。 */}
            <span aria-hidden="true">
              {hiddenCount > 0
                ? `${visibleSlideCount}/${project.slides.length}`
                : project.slides.length}
            </span>
            <span className="visually-hidden">{slideCountTitle}</span>
          </b>
          <button
            className="add-page"
            aria-label="新增頁面"
            title="新增空白頁"
            disabled={newSlideBusy}
            onClick={() => void onAddSlide()}
          >
            ＋
          </button>
        </span>
      </div>
      <div className="thumbnails" ref={railRef}>
        {project.slides.map((slide) => {
          const thumb = currentImage(project, slide);
          return (
            <div
              key={slide.id}
              className={`thumbnail ${slide.id === selectedSlideId ? "selected" : ""} ${slide.hidden ? "hidden-slide" : ""}`}
              draggable
              onDragStart={() => setDraggedId(slide.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (!draggedId || draggedId === slide.id) return;
                const ids = project.slides.map((item) => item.id);
                const from = ids.indexOf(draggedId);
                const to = ids.indexOf(slide.id);
                ids.splice(to, 0, ids.splice(from, 1)[0]!);
                void runThumbAction(() => api.reorderSlides(project.id, ids));
                setDraggedId(undefined);
              }}
              onClick={() => onSelect(slide.id)}
              /*
               * `role="button"` **不會**像真的 `<button>` 那樣把 Enter／Space 合成成 click，
               * 所以必須自己接。在此之前這一格 Tab 得到、焦點環會亮、閱讀器也念「按鈕」，
               * 按下去卻毫無反應——選頁是編輯器的核心動線，等於整個編輯器對純鍵盤使用者
               * 不可用。寫法照抄 header 專案名稱那顆同為 `role="button"` 的 `<strong>`。
               *
               * 只認 `target === currentTarget`：裡面那排操作按鈕是真的 `<button>`，Enter
               * 會被它們自己處理完再冒泡上來，不擋的話「按 Enter 刪除這一頁」會順帶把
               * 這一頁選起來。
               */
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelect(slide.id);
              }}
              role="button"
              tabIndex={0}
              // 選中狀態原本只有 CSS class：閱讀器聽到的是一排長得一模一樣的按鈕，
              // 無從得知現在停在哪一頁。
              {...(slide.id === selectedSlideId ? { "aria-current": "page" as const } : {})}
            >
              <span className="slide-number">{String(slide.order + 1).padStart(2, "0")}</span>
              <span
                className="thumb-canvas"
                style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
              >
                {!thumb && <em>{slide.purpose}</em>}
              </span>
              {/* 淡化本身不夠：縮圖本來就有深有淺，只靠透明度看不出是「被隱藏」還是
                「這張圖比較暗」，所以再補一個明講的標記。它刻意是 .thumb-canvas 的
                兄弟而不是子節點——父層的 opacity 會把標記一起淡掉。 */}
              {slide.hidden && <i className="thumb-hidden-badge">已隱藏</i>}
              <span className="thumb-actions">
                <button
                  /* 隱藏中的頁面，這顆按鈕是唯一的復原途徑，因此 `.hidden-slide` 讓
                   `.thumb-actions` 永遠可見（見 styles.css）；只在 hover 顯示會讓使用者
                   找不到怎麼取消隱藏。
                   名稱跟著狀態翻（「取消隱藏此頁」已經蘊含「這一頁現在是隱藏的」），
                   所以**不加** `aria-pressed`：兩者併用時螢幕閱讀器會念出
                   「取消隱藏此頁, 已按下」——雙重否定，比沒有狀態資訊更糟。
                   視覺上的狀態由「已隱藏」標記與淡化的縮圖承擔。 */
                  className="thumb-hide"
                  title={slide.hidden ? "取消隱藏此頁" : "隱藏此頁（不放映、不匯出 pptx／pdf）"}
                  aria-label={slide.hidden ? "取消隱藏此頁" : "隱藏此頁"}
                  disabled={thumbBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void runThumbAction(() =>
                      api.setSlideHidden(project.id, slide.id, !slide.hidden),
                    );
                  }}
                >
                  <SlideVisibilityIcon hidden={!!slide.hidden} />
                </button>
                {/* `title` 不在鍵盤焦點時顯示、行動裝置無法觸發、部分閱讀器設定會忽略它，
                  所以名稱要靠 `aria-label`——同一排的第一顆本來就兩個都有。 */}
                <button
                  aria-label="複製頁面"
                  title="複製頁面"
                  disabled={thumbBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void runThumbAction(() => api.duplicateSlide(project.id, slide.id));
                  }}
                >
                  ⧉
                </button>
                <button
                  aria-label="刪除頁面"
                  title="刪除頁面"
                  disabled={thumbBusy || project.slides.length === 1}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirm("刪除此頁？"))
                      void runThumbAction(() => api.deleteSlide(project.id, slide.id));
                  }}
                >
                  ×
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
