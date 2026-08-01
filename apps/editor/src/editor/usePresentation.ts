import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentationProject, SlideSpec, SlideVersion } from "@slide-maker/core";
import { imageUrl } from "../api.js";
import { currentImage } from "./projectHelpers.js";
import { firstPresentableIndex, nextVisibleIndex } from "./slideVisibility.js";
import {
  normalizeWheelDelta,
  WHEEL_GESTURE_GAP_MS,
  WHEEL_MAX_LOCK_MS,
  WHEEL_PAGE_LOCK_MS,
  WHEEL_PAGE_THRESHOLD_PX,
} from "./wheel.js";

/**
 * 簡報（放映）模式：進場、退場、兩條自動清狀態的路徑、滾輪換頁（路徑②），以及覆蓋層要用的
 * 衍生值。
 *
 * **鍵盤換頁（路徑①）不在這裡**，它留在 `Editor` 的那條集中 keydown listener 裡：那條
 * listener 依優先序同時處理影像編輯／風格選擇對話框的 Esc、簡報換頁與編輯模式的上下鍵，
 * 分支順序本身就是行為（簡報分支必須排在 `modalDialogOpen()` 之前），拆成兩個 listener 會
 * 改變事件處理順序與 preventDefault 的競合。它只消費這裡回傳的
 * `presentationIndex`／`setPresentationIndex`／`exitPresentation`。
 *
 * `project` 可空是因為呼叫點必須排在 `Editor` 那幾條 early return 之前；覆蓋層與進場按鈕
 * 都只在專案存在時才渲染，所以幾個 `!project` 守衛實務上不會成立（原本這些衍生值宣告在
 * early return 之後，直接吃非空 project）。
 */
export function usePresentation({
  project,
  route,
  selected,
  previewVersion,
  setSelectedId,
  setError,
}: {
  project: PresentationProject | undefined;
  route: string;
  selected: SlideSpec | undefined;
  previewVersion: SlideVersion | undefined;
  setSelectedId: (slideId: string) => void;
  setError: (message: string) => void;
}): {
  presentationIndex: number | null;
  setPresentationIndex: (index: number | null) => void;
  presentationSlide: SlideSpec | undefined;
  presentationImage: string | undefined;
  presentationPrev: number | undefined;
  presentationNext: number | undefined;
  presentationPosition: number;
  exitPresentation: () => void;
  startPresentation: () => void;
} {
  const [presentationIndex, setPresentationIndex] = useState<number | null>(null);
  /**
   * 簡報模式滾輪換頁的手勢狀態。
   *
   * 放在 ref 而不是 effect 的區域變數：換頁會改 `presentationIndex`，effect 因此重掛，
   * 區域變數會連同冷卻與累積量一起被重置，慣性尾巴就攔不住了。
   */
  const presentationWheel = useRef({ accumulated: 0, lastEventAt: 0, lockUntil: 0, lockCap: 0 });
  /**
   * 「使用者主動結束這場放映」的唯一出口。三條**會退出的**路徑（Esc、控制列的關閉鈕、
   * 以 F11／瀏覽器原生方式離開全螢幕）共用這一份，理由與 `nextVisibleIndex` 相同：退出時
   * 要把選取同步成「剛剛在放映的那一頁」，各自複製一份的話，日後只會有一條路被記得改。
   *
   * 退出後選取放映頁，是因為使用者放映到哪就是想從哪繼續編輯；停在進場前那一頁等於
   * 把整段放映的位移丟掉（縮圖列的自動捲入由既有的 `selectedId` effect 處理）。
   *
   * 另外兩種「簡報就這樣沒了」的情形**不走這裡**，各自純清狀態（見下方兩條 effect）：
   * 離開專案／換路由，以及正在放映的那一頁消失。它們不該同步選取——換專案時同步等於
   * 拿舊專案的 index 去改寫新專案的選取，刪頁時那個 index 指向的頁已經不存在了。
   */
  const exitPresentation = useCallback(() => {
    // 放映途中該頁在別的分頁被刪掉、或 index 越界時 slide 是 `undefined`：維持原本選取，
    // 不可寫入 `undefined`——那會讓 `selected` 退回 `slides[0]`，等於無故跳到第一頁。
    const presentedId =
      presentationIndex === null ? undefined : project?.slides[presentationIndex]?.id;
    if (presentedId) setSelectedId(presentedId);
    setPresentationIndex(null);
    // 走 fullscreenchange 進來時全螢幕已經退掉了，`fullscreenElement` 是 null，這段自動跳過。
    if (document.fullscreenElement && document.exitFullscreen)
      void document.exitFullscreen().catch(() => undefined);
  }, [presentationIndex, project]);
  /**
   * 離開這個專案（換專案、按瀏覽器上一頁回專案列表、切到模型庫／風格庫路由）就結束放映。
   * 少了這條，`presentationIndex` 會跨越專案存活：放映 A 到第 3 頁 → 瀏覽器上一頁回列表
   * （keydown handler 遇 metaKey／altKey 直接 return，瀏覽器照常導航）→ 再點 A，
   * `found.id !== project?.id` 為 false，什麼都不重設，簡報覆蓋層直接彈回第 3 頁；
   * 點別的專案 B 更糟，B 會以簡報模式開在 `B.slides[2]`。
   *
   * 純清狀態，**不要**改成呼叫 `exitPresentation()`：那會連帶把選取改寫成放映頁，
   * 而離開專案時同步選取沒有意義（換到 B 時甚至會用 A 的 index 去污染 B 的選取）。
   */
  useEffect(() => {
    setPresentationIndex(null);
  }, [project?.id, route]);
  /**
   * 正在放映的那一頁消失（自己刪掉、或別的分頁刪掉後輪詢回來、index 越界）就結束放映。
   * 少了這條會留下「隱形簡報模式」：`presentationSlide` 是 undefined，覆蓋層連同關閉鈕
   * 一起 unmount，但 `presentationIndex` 仍非 null——`canvasIsActiveSurface` 為 false，
   * 畫布上的 Delete／⌘Z／方向鍵全部靜默失效，方向鍵反而落進上面那條簡報分支，
   * 把覆蓋層叫回來。唯一出路是盲按 Esc。
   *
   * 同樣純清狀態、不走 `exitPresentation()`：那個 index 指向的頁已經不存在，沒有「放映
   * 到哪一頁」可以同步過去，選取必須原封不動留在使用者原本選的那一頁。
   */
  useEffect(() => {
    if (presentationIndex === null) return;
    if (project?.slides[presentationIndex]) return;
    setPresentationIndex(null);
  }, [presentationIndex, project]);
  useEffect(() => {
    if (presentationIndex === null) return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) exitPresentation();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
    // 依賴 `exitPresentation` 而不是只綁 `presentationIndex`：換頁本來就會重掛（它已經
    // 在依賴裡），會過期的是 `exitPresentation` 閉包捕住的 **`project`**——輪詢或另一個
    // 分頁刪掉某頁之後，舊的那份會拿過期的 slides 去換算「剛剛放映的是哪一頁」。
  }, [presentationIndex, exitPresentation]);
  // 簡報模式滾輪換頁：向下／向右一頁，向上／向左一頁，到頭到尾就停住不迴圈。
  // listener 只在簡報模式期間存在（依賴 presentationIndex），離開後編輯畫面的滾輪完全不受影響。
  useEffect(() => {
    if (presentationIndex === null || !project) return;
    const slides = project.slides;
    const onWheel = (event: WheelEvent) => {
      // Ctrl／⌘＋滾輪是瀏覽器的縮放手勢，不是換頁；連它一起擋掉會讓簡報模式無法縮放。
      if (event.ctrlKey || event.metaKey) return;
      // 簡報是覆蓋全螢幕的，滾輪不該讓底下的編輯畫面捲動；macOS 上不擋還會整頁彈跳。
      // 要能 preventDefault 就必須以 passive: false 註冊。
      event.preventDefault();
      const gesture = presentationWheel.current;
      const nowMs = Date.now();
      const newGesture = nowMs - gesture.lastEventAt >= WHEEL_GESTURE_GAP_MS;
      gesture.lastEventAt = nowMs;
      if (newGesture) gesture.accumulated = 0;
      if (nowMs < gesture.lockUntil) {
        gesture.accumulated = 0;
        // 事件還在連續進來 → 同一次手勢（含慣性尾巴）還沒結束，把鎖往後推；
        // 但不超過 lockCap，否則一直轉滾輪的人會永遠停在同一頁。
        gesture.lockUntil = Math.min(
          gesture.lockCap,
          Math.max(gesture.lockUntil, nowMs + WHEEL_GESTURE_GAP_MS),
        );
        return;
      }
      gesture.accumulated += normalizeWheelDelta(event);
      if (Math.abs(gesture.accumulated) < WHEEL_PAGE_THRESHOLD_PX) return;
      const forward = gesture.accumulated > 0;
      gesture.accumulated = 0;
      gesture.lockUntil = nowMs + WHEEL_PAGE_LOCK_MS;
      gesture.lockCap = nowMs + WHEEL_MAX_LOCK_MS;
      // 邊界與跳過隱藏頁的規則與鍵盤換頁共用同一支 nextVisibleIndex；
      // 沒有下一張可見頁時 nextIndex 不變，不迴圈。
      const nextIndex = nextVisibleIndex(slides, presentationIndex, forward ? 1 : -1);
      if (nextIndex !== undefined && nextIndex !== presentationIndex)
        setPresentationIndex(nextIndex);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
    // 直接依賴整個 `project`（與 Editor 那條 keydown effect 相同）而不是挑幾個欄位：listener
    // 是閉包，捕住的是掛載當下那份 slides，只看 `slides.length` 會讓它拿著過期的可見頁
    // 清單換頁。手寫的逐頁 key 修得了「現在讀到的欄位」，但下一個讀 slide 欄位的人不會
    // 記得回來加，編譯器也不會提醒。重掛 listener 是免費的：手勢狀態放在 ref 裡。
  }, [presentationIndex, project]);
  // `presentationSlide` 為真就代表 project 存在（它是從 `project?.slides` 取出來的）；
  // 下面幾處多寫的 `project` 判斷只是讓型別看得出這件事，不改任何行為。
  const presentationSlide =
    presentationIndex === null ? undefined : project?.slides[presentationIndex];
  // 正在預覽歷史版本時，簡報模式的該頁要跟編輯畫布一致，顯示預覽中的版本。
  const presentationImage =
    presentationSlide && project
      ? presentationSlide.id === selected?.id && previewVersion
        ? imageUrl(project.id, previewVersion.imagePath)
        : currentImage(project, presentationSlide)
      : undefined;
  // 點擊舞台與控制列兩條路徑同樣走 nextVisibleIndex；`undefined` 直接就是按鈕的 disabled 條件。
  const presentationPrev =
    presentationIndex === null || !project
      ? undefined
      : nextVisibleIndex(project.slides, presentationIndex, -1);
  const presentationNext =
    presentationIndex === null || !project
      ? undefined
      : nextVisibleIndex(project.slides, presentationIndex, 1);
  /**
   * 控制列的「第幾頁 / 共幾頁」。與頁碼疊層**只**共用「隱藏頁不算」這一條，刻意不套
   * `startAt`／`skipFirstSlide`：那兩個是印在成品上的 chrome 設定（`skipFirstSlide` 開、
   * `startAt: 10` 時，色塊寫「第 10 頁」而這裡寫「1 / 4」，兩者都對），控制列則是放映進度，
   * 必須從 1 數到可見頁數。不要「統一」成呼叫 `pageNumberSlideLabel()`——那會讓進度指示
   * 在關閉頁碼時整個消失、開啟 skipFirstSlide 時第一頁變成空白。
   *
   * 夾到至少 1：放映中的那頁若在別的分頁被改成隱藏、而它又正好是 index 0，未夾制時
   * 這裡會算出 `0 / 3`（`alt` 也會變成「簡報第 0 頁」）。落差只在顯示上，不值得為它在
   * 簡報途中強制跳頁，但「第 0 頁」是明顯錯的字。
   */
  const presentationPosition =
    presentationIndex === null || !project
      ? 0
      : Math.max(
          1,
          project.slides.slice(0, presentationIndex + 1).filter((slide) => !slide.hidden).length,
        );
  const startPresentation = () => {
    if (!project) return;
    const preferred = Math.max(
      0,
      project.slides.findIndex((slide) => slide.id === selected?.id),
    );
    // 選取的那頁被隱藏時落到最近的可見頁；一張可見頁都沒有就不進場——空的簡報模式
    // 只會是一片黑幕加上「0 / 0」，離開的唯一辦法還是 Esc。
    const index = firstPresentableIndex(project.slides, preferred);
    if (index === undefined) {
      setError("所有頁面都已隱藏，無法開始簡報。請先取消隱藏至少一頁。");
      return;
    }
    // 手勢狀態跟著這次簡報從零開始：上一輪留下的冷卻會把進場後第一下滾輪吃掉。
    presentationWheel.current = { accumulated: 0, lastEventAt: 0, lockUntil: 0, lockCap: 0 };
    setPresentationIndex(index);
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => undefined);
  };
  return {
    presentationIndex,
    setPresentationIndex,
    presentationSlide,
    presentationImage,
    presentationPrev,
    presentationNext,
    presentationPosition,
    exitPresentation,
    startPresentation,
  };
}
