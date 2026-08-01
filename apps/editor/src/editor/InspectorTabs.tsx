export type InspectorPanel = "slide" | "project" | "sources" | "export";

/**
 * 右側 inspector 的分頁列（頁面／專案／來源／匯出）與收合鈕。
 *
 * 選中狀態原本只有 CSS class 撐著：閱讀器聽到四顆一模一樣的按鈕，唯一得知現狀的
 * 辦法是按下去——而按下去就換掉了整個面板。`aria-current="page"` 是最小修法；
 * 完整的 `role="tablist"` 要連帶實作方向鍵巡覽（Home／End、`aria-controls`、
 * roving tabindex），成本高得多，這次不做。
 *
 * 收合鈕留在分頁列裡，收起來之後它是側邊欄唯一還看得見的東西（其餘由 CSS 藏掉），
 * 所以還原鈕與收合鈕是同一顆——不必另外找地方擺一個只有收合時才存在的按鈕。
 */
export function InspectorTabs({
  panel,
  onPanel,
  collapsed,
  onCollapsedToggle,
  sourceCount,
}: {
  panel: InspectorPanel;
  onPanel: (panel: InspectorPanel) => void;
  collapsed: boolean;
  onCollapsedToggle: () => void;
  sourceCount: number;
}) {
  return (
    <div className="inspector-tabs">
      <button
        className={panel === "slide" ? "active" : ""}
        {...(panel === "slide" ? { "aria-current": "page" as const } : {})}
        onClick={() => onPanel("slide")}
      >
        頁面
      </button>
      <button
        className={panel === "project" ? "active" : ""}
        {...(panel === "project" ? { "aria-current": "page" as const } : {})}
        onClick={() => onPanel("project")}
      >
        專案
      </button>
      {/* 來源筆數原本掛在 header 的導覽列上，導覽列收掉後改由這個分頁承接（accessible name 仍是「來源 N」）。 */}
      <button
        className={panel === "sources" ? "active" : ""}
        {...(panel === "sources" ? { "aria-current": "page" as const } : {})}
        onClick={() => onPanel("sources")}
      >
        來源 <b>{sourceCount}</b>
      </button>
      <button
        className={panel === "export" ? "active" : ""}
        {...(panel === "export" ? { "aria-current": "page" as const } : {})}
        onClick={() => onPanel("export")}
      >
        匯出
      </button>
      <button
        type="button"
        className="inspector-collapse"
        // 少了 aria-controls，讀螢幕的人只聽得到「已展開／已收合」，卻不知道是什麼展開了。
        aria-controls="inspector"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "展開側邊欄" : "收起側邊欄"}
        title={collapsed ? "展開側邊欄" : "收起側邊欄，放大編輯區"}
        onClick={() => onCollapsedToggle()}
      >
        {collapsed ? "‹" : "›"}
      </button>
    </div>
  );
}
