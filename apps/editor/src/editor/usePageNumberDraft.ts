import { useEffect, useRef, useState } from "react";
import type { PageNumberSettings, PresentationProject } from "@slide-maker/core";
import { api } from "../api.js";
import {
  mergePageNumber,
  PAGE_NUMBER_DEBOUNCE_MS,
  type PageNumberPatch,
} from "./pageNumberModel.js";

/**
 * 頁碼設定的樂觀本地值與 debounce 寫回（面板、畫布疊層、簡報疊層共用同一份）。
 *
 * `project` 可空只因為呼叫點必須排在 `Editor` 那幾條 early return **之前**（hook 順序不可
 * 條件化）。頁碼面板本身只在專案存在時才渲染，所以下面兩道 `!project` 守衛實務上不會成立，
 * 純粹是把「宣告在 early return 之後、閉包直接吃非空 project」那個前提寫成程式碼。
 *
 * 回傳的是**草稿**而不是 `pageNumber`／`pageNumberProject`：那兩個要拿非空的 project 當
 * 底值，型別上得等 early return narrow 過才成立，留在 `Editor` 算才不必到處補非空斷言。
 */
export function usePageNumberDraft(
  project: PresentationProject | undefined,
  setProject: (value: PresentationProject) => void,
  setError: (message: string | undefined) => void,
): {
  pageNumberDraft: PageNumberSettings | undefined;
  patchPageNumber: (patch: PageNumberPatch, options?: { debounce?: boolean }) => void;
} {
  /**
   * 頁碼設定的樂觀本地值（未定義代表「就用伺服器上那份」）。
   *
   * 滑桿拖一次會連發數十個 change，每一次都送 PATCH 等於讓
   * `repository.updateProject`（取檔鎖 → 讀 project.json → 全量 zod 驗證 → 原子寫）跑數十趟；
   * 150 頁 PDF 匯入專案的 project.json 相當大。連續型控制項因此先寫進這裡讓畫布即時反應，
   * 真正的請求 debounce 之後只送最後一次。
   */
  const [pageNumberDraft, setPageNumberDraft] = useState<PageNumberSettings>();
  /** 遞增的請求序號：debounce 之後仍可能兩筆在途，回應亂序時只認最新那一筆。 */
  const pageNumberSeq = useRef(0);
  const pageNumberTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 還沒送出的欄位。debounce 期間改到別的欄位要併進同一筆，否則前一筆會被計時器取消掉。 */
  const pageNumberPending = useRef<PageNumberPatch>({});
  // 換專案時丟掉樂觀值與在途請求，免得上一份專案的頁碼設定套到下一份上。
  useEffect(() => {
    setPageNumberDraft(undefined);
    pageNumberPending.current = {};
    return () => {
      pageNumberSeq.current += 1;
      pageNumberPending.current = {};
      if (pageNumberTimer.current === undefined) return;
      clearTimeout(pageNumberTimer.current);
      pageNumberTimer.current = undefined;
    };
  }, [project?.id]);
  const flushPageNumber = async () => {
    if (pageNumberTimer.current !== undefined) {
      clearTimeout(pageNumberTimer.current);
      pageNumberTimer.current = undefined;
    }
    const patch = pageNumberPending.current;
    pageNumberPending.current = {};
    if (!Object.keys(patch).length) return;
    if (!project) return;
    const seq = (pageNumberSeq.current += 1);
    setError(undefined);
    try {
      const updated = await api.updatePageNumber(project.id, patch);
      // 更晚送出的一筆已經在途（或已回來）時，這筆是舊資料，寫進去就是 UI 跳回舊值。
      if (seq !== pageNumberSeq.current) return;
      setProject(updated);
      // 還有排隊中的變更時樂觀值比伺服器新，留著等下一輪回應再收。
      if (pageNumberTimer.current === undefined) setPageNumberDraft(undefined);
    } catch (reason) {
      if (seq !== pageNumberSeq.current) return;
      // 失敗就退回伺服器上那份，不讓畫布停在一個沒被接受的狀態。
      setPageNumberDraft(undefined);
      setError(reason instanceof Error ? reason.message : "操作失敗");
    }
  };
  /**
   * `debounce` 給滑桿與色票這種一次操作連發數十個 change 的控制項；其餘控制項一次一個值，
   * 立刻送出。兩者都先寫樂觀值，畫布因此永遠是即時的。
   */
  const patchPageNumber = (patch: PageNumberPatch, options: { debounce?: boolean } = {}) => {
    if (!project) return;
    setPageNumberDraft((current) => mergePageNumber(current ?? project.pageNumber, patch));
    const pending = pageNumberPending.current;
    // 巢狀欄位逐欄併：整個換掉的話，同一輪裡先改的 background.color 會被後改的 opacity 蓋掉。
    const background = { ...pending.background, ...patch.background };
    pageNumberPending.current = {
      ...pending,
      ...patch,
      ...(Object.keys(background).length ? { background } : {}),
    };
    if (pageNumberTimer.current !== undefined) clearTimeout(pageNumberTimer.current);
    pageNumberTimer.current = undefined;
    if (!options.debounce) {
      void flushPageNumber();
      return;
    }
    pageNumberTimer.current = setTimeout(() => {
      pageNumberTimer.current = undefined;
      void flushPageNumber();
    }, PAGE_NUMBER_DEBOUNCE_MS);
  };
  return { pageNumberDraft, patchPageNumber };
}
