import {
  pageNumberFormatSchema,
  pageNumberPositionSchema,
  type PageNumberSettings,
} from "@slide-maker/core";
import { ClampedNumberField } from "./ClampedNumberField.js";
import type { PageNumberPatch } from "./pageNumberModel.js";

/**
 * 專案面板的 PAGE NUMBER 設定區。
 *
 * 收的是 `usePageNumberDraft` 的**樂觀值**與它的 `patchPageNumber`（此處為 `onPatch`）：
 * 滑桿拖到一半時畫布要即時跟著動，讀伺服器上那份就會卡在 debounce 之後才更新。
 * 這裡不持有狀態，也不決定哪些欄位要 debounce——那是 `onPatch` 呼叫點各自帶的旗標。
 */
export function PageNumberFields({
  pageNumber,
  onPatch,
}: {
  pageNumber: PageNumberSettings;
  onPatch: (patch: PageNumberPatch, options?: { debounce?: boolean }) => void;
}) {
  return (
    <>
      <div className="inspector-heading page-number-heading">
        <span>PAGE NUMBER</span>
      </div>
      {/* 頁碼是專案級設定，改了立即套用，不併進「儲存 Brief」——它與大綱無關，
          而且畫布上的預覽要馬上跟著動才看得出調整效果。
          滑桿與色票走 debounce（見 patchPageNumber），其餘控制項一次一個值即時送出。 */}
      <label className="check-row page-number-toggle">
        <input
          type="checkbox"
          checked={pageNumber.enabled}
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        顯示頁碼
      </label>
      {pageNumber.enabled && (
        <div className="page-number-fields">
          <label>
            位置
            <select
              value={pageNumber.position}
              onChange={(event) =>
                onPatch({
                  position: pageNumberPositionSchema.parse(event.target.value),
                })
              }
            >
              <option value="bottom-left">左下</option>
              <option value="bottom-center">置中</option>
              <option value="bottom-right">右下</option>
            </select>
          </label>
          <label>
            格式
            <select
              value={pageNumber.format}
              onChange={(event) =>
                onPatch({ format: pageNumberFormatSchema.parse(event.target.value) })
              }
            >
              <option value="number">3</option>
              <option value="number-total">3 / 12</option>
              <option value="zh-page">第 3 頁</option>
            </select>
          </label>
          <ClampedNumberField
            label="起始頁碼"
            value={pageNumber.startAt}
            min={1}
            max={999}
            onCommit={(startAt) => onPatch({ startAt })}
          />
          <label className="check-row page-number-toggle">
            <input
              type="checkbox"
              checked={pageNumber.skipFirstSlide}
              onChange={(event) => onPatch({ skipFirstSlide: event.target.checked })}
            />
            封面不編號
          </label>
          <ClampedNumberField
            label="字級"
            value={pageNumber.fontSize}
            min={12}
            max={120}
            onCommit={(fontSize) => onPatch({ fontSize })}
          />
          <label>
            顏色
            <input
              type="color"
              value={pageNumber.color}
              onChange={(event) => onPatch({ color: event.target.value }, { debounce: true })}
            />
          </label>
          <label>
            透明度
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={pageNumber.opacity}
              onChange={(event) =>
                onPatch({ opacity: Number(event.target.value) }, { debounce: true })
              }
            />
          </label>
          <label className="check-row page-number-toggle">
            <input
              type="checkbox"
              checked={pageNumber.background.enabled}
              onChange={(event) => onPatch({ background: { enabled: event.target.checked } })}
            />
            加上背景色塊
          </label>
          {pageNumber.background.enabled && (
            <>
              <label>
                色塊顏色
                <input
                  type="color"
                  value={pageNumber.background.color}
                  onChange={(event) =>
                    onPatch({ background: { color: event.target.value } }, { debounce: true })
                  }
                />
              </label>
              <label>
                色塊透明度
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={pageNumber.background.opacity}
                  onChange={(event) =>
                    onPatch(
                      { background: { opacity: Number(event.target.value) } },
                      { debounce: true },
                    )
                  }
                />
              </label>
            </>
          )}
        </div>
      )}
    </>
  );
}
