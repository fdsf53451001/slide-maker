/**
 * 簡報模式滾輪換頁的門檻（正規化後的像素）。
 *
 * 取 40 是夾在兩個實測量級之間：滑鼠一格 notch 最小的情況是 Firefox 的
 * `deltaMode=1`／3 行（正規化後 48px，Chrome 的像素模式一格是 100px），所以門檻低於 48
 * 才能保證「轉一格＝換一頁」；而觸控板一個 frame 只送個位數 px，40px 又高到不會被
 * 手指靠上去的微小位移誤觸。
 */
export const WHEEL_PAGE_THRESHOLD_PX = 40;

/** `deltaMode=1`（行）換算成像素用的行高；瀏覽器自己的預設行高也是這個量級。 */
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * 換頁後的冷卻時間：這段時間內的滾輪事件一律丟棄。
 *
 * 觸控板一次輕滑會連送數十個事件，沒有這道鎖會一口氣跳完整份簡報。
 * 320ms 與編輯區滾輪換頁（`handleStageWheel`）用同一個量級，兩處手感一致。
 */
export const WHEEL_PAGE_LOCK_MS = 320;

/**
 * 判定「同一個手勢」的事件間隔。
 *
 * 慣性滾動的事件是 ~60Hz 連續進來的（間隔 <20ms），只要還沒斷過這麼久就當成同一次
 * 手勢：冷卻期會被一路往後推，尾巴才不會在鎖解開後又湊滿門檻多切一頁。
 * 反過來，間隔超過這個值代表使用者重新出手，累積量歸零，免得兩次沒湊滿門檻的
 * 輕碰隔了幾秒還被加在一起。
 */
export const WHEEL_GESTURE_GAP_MS = 140;

/**
 * 冷卻可以被慣性尾巴往後推的上限（自換頁那一刻起算）。
 *
 * 沒有這個上限的話，持續轉滾輪的使用者（notch 間隔可能只有幾十毫秒）會被判成
 * 「同一個手勢永遠沒結束」而卡在同一頁；有了上限，最壞情況仍能每 900ms 換一頁，
 * 而 900ms 足以蓋掉一般觸控板甩動的慣性尾巴。
 */
export const WHEEL_MAX_LOCK_MS = 900;

/**
 * 把滾輪位移正規化成像素，並取軸向位移較大的那一軸。
 *
 * `deltaMode` 不同時 delta 的量級差很多（行／頁 vs 像素），不換算就沒辦法用同一個門檻比。
 */
export function normalizeWheelDelta(event: WheelEvent): number {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return delta * WHEEL_LINE_HEIGHT_PX;
  if (event.deltaMode === 2) return delta * window.innerHeight;
  return delta;
}
