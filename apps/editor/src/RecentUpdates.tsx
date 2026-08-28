import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { changelogDays, formatChangelogDate, type ChangelogDay } from "./changelog.js";
import { useBackdropDismiss } from "./useBackdropDismiss.js";

/**
 * 主畫面右上角的「最近更新」：一顆按鈕加上點開的 modal，內容來自建置時內嵌的 CHANGE.md。
 *
 * 三個庫（簡報／風格庫／模型庫）共用 `LibraryHeader`，所以三個分頁都看得到這顆按鈕。
 *
 * `days` 只為了測試空狀態而開（正式使用一律吃內嵌的那份）；不接 props 的話，
 * 「沒有任何更新紀錄」那條路就只能靠 mock 模組才測得到。
 */
export function RecentUpdatesButton({ days = changelogDays }: { days?: ChangelogDay[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // 三條關閉路徑（關閉鈕／Esc／點背景）都走這一份：焦點回到觸發按鈕是其中一步，
  // 各自 setOpen(false) 的話，鍵盤使用者按完 Esc 會被丟回文件開頭。
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const dismiss = useBackdropDismiss(close);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // 鎖住背景捲動：遮罩自身不可捲，滾輪會直接穿透去捲背後那一頁（面板還在原地不動，
  // 關掉之後才發現整頁被捲走了）。還原寫在 cleanup，卸載路徑也一併還原。
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="recent-updates-trigger"
        onClick={() => setOpen(true)}
      >
        最近更新
      </button>
      {/*
        modal 必須 portal 到 `document.body`，**不可以**留在 header 裡就地渲染：
        `.dashboard-header` 有 `backdrop-filter: blur(14px)`，依規範這會讓它成為 fixed
        後代的 containing block，於是覆蓋層的 `position: fixed; inset: 0` 會解析成 header
        那條 64px 的方框——實測遮罩只蓋住 header、面板上緣被推到 viewport 外（y=-236），
        標題與最上面幾則更新直接被切掉。jsdom 量不到這件事，只有真實瀏覽器看得見。
        （既有的 `.pdf-modal-backdrop` 沒踩到，是因為它掛在 `dashboard-content` 底下。）
      */}
      {open &&
        createPortal(
          <div className="recent-updates-backdrop" {...dismiss}>
            <div
              ref={dialogRef}
              className="recent-updates-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <header className="recent-updates-header">
                <strong id={titleId}>最近更新</strong>
                <button
                  type="button"
                  className="recent-updates-close"
                  onClick={close}
                  aria-label="關閉"
                >
                  ×
                </button>
              </header>
              <div className="recent-updates-body">
                {days.length === 0 ? (
                  <p className="recent-updates-empty">尚無更新紀錄。</p>
                ) : (
                  days.map((day) => (
                    <section key={day.date} className="recent-updates-day">
                      <h3 className="recent-updates-date">{formatChangelogDate(day.date)}</h3>
                      <ul className="recent-updates-list">
                        {day.entries.map((entry, index) => (
                          <li key={`${day.date}-${index}`}>
                            {entry.title ? (
                              <>
                                <strong>{entry.title}</strong>
                                {`：${entry.body}`}
                              </>
                            ) : (
                              entry.body
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
