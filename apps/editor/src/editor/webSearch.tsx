import { useEffect, useRef, useState } from "react";
import type { PresentationProject } from "@slide-maker/core";
import { api } from "../api.js";

/**
 * 自動搜尋網路資源的共用讀寫（精靈 STEP 3 與系統設定對話框兩個入口）。
 *
 * 這個值是**專案設定**：伺服器只讀 `project.brief.webSearchMode`。舊版把它存在瀏覽器
 * localStorage 再由一條 effect 同步回專案，多人共用同一台伺服器（server 端沒有 session／user
 * 概念）時，兩人開同一個專案就會互相覆寫，而且畫面顯示的是本機值、實際生效的是專案值。
 * 這份 JSDoc 是這個設計理由的唯一真相，其餘地方只指過來。
 *
 * 三件與寫入有關的事：
 * - 只送 `webSearchMode` 一個欄位，理由同 `briefPatchWithoutWebSearch`。
 * - 刻意不做樂觀更新：勾選狀態直接讀專案值，讀寫同源就不會漂移，失敗時也自動停在伺服器的
 *   實際值。代價是慢連線下按了到翻面之間有空窗，由 `busy` 的進行中樣式補上。
 * - 防連點靠 `busyRef` 而不是把 checkbox `disabled`：disabled 元素不可聚焦，在自己的 change
 *   handler 裡打開會把鍵盤焦點丟回 `<body>`，等於每切換一次就被踢回 Tab 序列開頭。
 */
export function useWebSearchToggle(
  project: PresentationProject | undefined,
  onProject: (value: PresentationProject) => void,
  onError: (message: string) => void,
): { enabled: boolean; busy: boolean; toggle: (next: boolean) => void } {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // PATCH 在飛的時候使用者可能已經關掉對話框、切到別的專案、或退回專案列表；回應落地時若還
  // 無條件 `onProject`，就會把人拉回舊專案。舊的同步 effect 是靠 cleanup 的 `active` 旗標擋
  // 這件事，改成 hook 之後沒有 cleanup 可掛，改用「現在還是不是同一個專案」來判斷。
  const activeProjectId = useRef(project?.id);
  useEffect(() => {
    activeProjectId.current = project?.id;
  }, [project?.id]);
  // 伺服器端只有 "disabled" 會跳過搜尋，enum 的 "live" 與 "cached" 行為完全相同。舊專案存的
  // 是 "cached"，判成關閉會無聲改掉既有專案的行為，所以視同開啟——也刻意不順手改寫成 "live"。
  const enabled = project ? project.brief.webSearchMode !== "disabled" : true;
  const toggle = (next: boolean): void => {
    if (!project || busyRef.current) return;
    const projectId = project.id;
    busyRef.current = true;
    setBusy(true);
    void api
      .updateBrief(projectId, { webSearchMode: next ? "live" : "disabled" })
      .then((updated) => {
        if (activeProjectId.current === projectId) onProject(updated);
      })
      .catch((reason: unknown) => {
        if (activeProjectId.current !== projectId) return;
        onError(reason instanceof Error ? reason.message : "更新自動搜尋設定失敗");
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  return { enabled, busy, toggle };
}

/**
 * 自動搜尋勾選框；兩個入口共用同一份文案與寫入邏輯。
 *
 * `busy`（自己的 PATCH 在飛）與 `disabled`（整個步驟不能動，例如精靈正在產大綱）是兩回事：
 * 前者只上 `aria-busy` 與進行中樣式、保住焦點與可聚焦性，後者才真的 `disabled`。
 * 進行中的指示器走 CSS `::after`，不放任何文字節點進 `<label>`——label 的文字內容就是這個
 * checkbox 的可及名稱，多一個字就會讓「自動搜尋網路資源」這個名字對不上。
 */
export function WebSearchToggle({
  className,
  enabled,
  busy,
  disabled,
  onToggle,
}: {
  className: string;
  enabled: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label className={className}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        aria-busy={busy || undefined}
        onChange={(event) => onToggle(event.target.checked)}
      />
      自動搜尋網路資源
    </label>
  );
}
