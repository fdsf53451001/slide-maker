import type { Response } from "express";
import { logWarn } from "@slide-maker/core";

/**
 * 串流回應的分塊大小。
 *
 * 1 MiB 遠大於 socket 的預設 highWaterMark（64 KiB），所以每寫一塊幾乎都會觸發
 * backpressure，讓 `sendChunked` 有機會等 drain；同時又大到讓一份數十 MiB 的匯出
 * 只需要幾十次 write，不至於把時間花在迴圈本身。
 */
export const RESPONSE_CHUNK_BYTES = 1024 * 1024;

/** 連線已終結：再也不會有 'drain' 或 'close'，繼續等只會永遠 pending。 */
function isFinished(response: Response): boolean {
  return response.destroyed || response.writableEnded;
}

/**
 * 等待 socket 排空。回傳 false 代表連線在排空前就結束了（使用者取消下載、或寫入
 * 出錯——'error' 之後必定跟著 'close'），呼叫端應停止繼續寫。
 *
 * 訂閱前必須先檢查已終結狀態：若客戶端在寫入之前就斷線，`write()` 走的是 Node 的
 * destroyed 分支——直接回 false 且不 emit 'error'，而 'close' 早在訂閱之前就發射完了，
 * 兩個事件都不會再來，少了這道檢查 promise 會永遠 pending。
 */
function waitForDrain(response: Response): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (isFinished(response)) return resolve(false);
    const settle = (drained: boolean) => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      resolve(drained);
    };
    const onDrain = () => settle(true);
    const onClose = () => settle(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

/**
 * 以 chunked transfer-encoding 串流寫出整個 body，不設 `Content-Length`。
 *
 * 為什麼不能用 `response.send()`：Express 的 `send()` 會補上 `Content-Length`，回應
 * 因此屬於「non-streamed」，而 Cloud Run 對這種回應有 32 MiB 的硬上限
 * （https://docs.cloud.google.com/run/quotas：「Maximum HTTP/1 response size: 32 MiB
 * if not using Transfer-Encoding: chunked or streaming mechanisms」），超過就回
 * "Response size was too large."。匯出 PDF／png.zip／slide-project 內嵌的是無損 PNG，
 * 二十頁上下就會撞到這條線。改走 chunked 之後該上限不適用，請勿「簡化」回 send()。
 *
 * 呼叫端必須在此之前設好所有 header（一旦寫出第一塊就 flush 了）。
 *
 * 呼叫端契約：`bytes`（及其底層 ArrayBuffer）在本函式 resolve 之前不得被改寫。這裡
 * 用的是零拷貝視圖（`Buffer.from(buffer, byteOffset, byteLength)`），而 Node 的 socket
 * write queue 也只以參考持有 Buffer、不複製，所以中途改寫來源會直接改到還沒送出去的
 * 位元組——症狀是「偶爾下載到壞檔」。若日後 exporter 改成回傳 pool 或 subarray 視圖，
 * 就必須在這裡改成複製，或由呼叫端保證交出所有權。
 */
export async function sendChunked(response: Response, bytes: Uint8Array): Promise<void> {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const abort = (sent: number) => logWarn("response_stream_aborted", { sent, total: body.length });
  for (let offset = 0; offset < body.length; offset += RESPONSE_CHUNK_BYTES) {
    // 分塊寫的理由是「能在中途察覺客戶端斷線並提早停止」，順帶避免單一 pending write
    // 綁住整塊記憶體直到 flush 完成——不是為了省記憶體：Node 的 socket queue 以參考
    // 持有 Buffer，不複製，整份塞進去並不會讓檔案在記憶體裡多存一份。
    if (isFinished(response)) return abort(offset);
    if (!response.write(body.subarray(offset, offset + RESPONSE_CHUNK_BYTES))) {
      if (await waitForDrain(response)) continue;
      return abort(offset);
    }
  }
  response.end();
}
