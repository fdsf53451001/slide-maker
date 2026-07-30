/**
 * 事件發生的**當下**，畫面上有沒有 modal 對話框。
 *
 * 問 DOM 而不是逐一列舉 state，是因為要閃避的對話框散在多個元件裡：`SourcePanel` 的預覽／
 * 搜尋／貼網址／貼文字四個、`Editor` 的系統設定與三選一、`PdfDeckImportModal`、
 * `RecentUpdates`。任何一條全域 keydown handler 都看不到別人的 state，於是「對話框開著時
 * ↑↓ 在背後換頁、Delete 無聲刪掉背後選中的文字框、Escape 無聲清掉背後的搜尋框」這個失敗
 * 模式，每新增一個對話框就會再犯一次。`aria-modal="true"` 本來就是「底下那片頁面現在不存在」
 * 的宣告，拿它當判準等於讓無障礙語意與鍵盤行為共用同一個真相。
 *
 * 必須在 handler 裡**即時**呼叫，不可併進 render 期算出來的布林：別的元件開對話框不會讓
 * 這個元件重新 render，那個值會停在對話框開啟前的答案。
 *
 * 住在獨立模組而不是 `Editor.tsx`：這個檔案裡的三條 handler 加上 `SourcePanel` 的 Escape 鏈
 * 一共四條全域 keydown listener，抄第二份等於留一個遲早漂移的第二真相——而漏掉這道 gate 的
 * 症狀（背後的狀態被無聲改掉）正是最難被回報的那一種。
 *
 * 呼叫點的順序有講究：簡報模式本身也是 `aria-modal` 的對話框，而它要吃方向鍵，所以
 * `Editor` 的呼叫點一律排在簡報那條分支**之後**。另外，這是一次 DOM 查詢，要排在便宜的
 * `event.key`／修飾鍵判斷之後，否則使用者每按一次鍵都要掃一次 document。
 */
export function modalDialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]');
}
