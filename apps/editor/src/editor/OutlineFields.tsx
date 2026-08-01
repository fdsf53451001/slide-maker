import type { SlideSpec, SourceAsset } from "@slide-maker/core";
import type { ProviderReadiness, ProviderSummary } from "../api.js";
import { toggleSourcePin } from "../sourceSelection.js";
import { duration } from "./projectHelpers.js";
import { SlideSourceChips } from "./SlideSourceChips.js";

/**
 * 單頁大綱的五個欄位、此頁來源指定，以及 provider／readiness 的提示與確認勾選。
 *
 * `outlineView` 與 `draft` 兩個都要收，不可收斂成一個：預覽歷史版本時畫面上顯示的是
 * 舊快照（`outlineView`），而編輯要寫回的仍是目前草稿（`draft`）——來源指定的切換
 * 一律以**畫面上顯示的那份**為準（見 `onToggle`）。
 *
 * 逐欄的橘框由呼叫端的 `fieldDirty()` 判定並傳進來，這裡不自己比對快照。
 */
export function OutlineFields({
  outlineView,
  draft,
  onDraft,
  readOnly,
  fieldDirty,
  dirtyFieldLabels,
  dirtyNoteId,
  sources,
  provider,
  readiness,
  readinessBusy,
  acceptUnknownReadiness,
  onAcceptUnknownReadiness,
}: {
  outlineView: SlideSpec;
  draft: SlideSpec;
  onDraft: (draft: SlideSpec) => void;
  readOnly: boolean;
  fieldDirty: (field: "content" | "narrative" | "layoutHint" | "imagePrompt") => boolean;
  dirtyFieldLabels: string[];
  dirtyNoteId: string;
  sources: SourceAsset[];
  provider: ProviderSummary | undefined;
  readiness: ProviderReadiness | undefined;
  readinessBusy: boolean;
  acceptUnknownReadiness: boolean;
  onAcceptUnknownReadiness: (accept: boolean) => void;
}) {
  return (
    <div className="fields">
      <label>
        頁面目的
        <input
          readOnly={readOnly}
          value={outlineView.purpose}
          onChange={(event) => onDraft({ ...draft, purpose: event.target.value })}
        />
      </label>
      {/* 橘框的文字版本。用既有的 `.provider-note` 提示樣式，沒有新增 class。 */}
      {dirtyFieldLabels.length > 0 && (
        <div className="provider-note" id={dirtyNoteId}>
          {dirtyFieldLabels.join("、")}
          ：這幾欄已修改，尚未反映到目前的圖片——重新生成才會套用。
        </div>
      )}
      <label className={fieldDirty("content") ? "outline-dirty" : ""}>
        內容
        <textarea
          readOnly={readOnly}
          rows={4}
          value={outlineView.content}
          {...(fieldDirty("content") ? { "aria-describedby": dirtyNoteId } : {})}
          onChange={(event) => onDraft({ ...draft, content: event.target.value })}
        />
      </label>
      <label className={fieldDirty("narrative") ? "outline-dirty" : ""}>
        敘事
        <textarea
          readOnly={readOnly}
          rows={3}
          value={outlineView.narrative}
          {...(fieldDirty("narrative") ? { "aria-describedby": dirtyNoteId } : {})}
          onChange={(event) => onDraft({ ...draft, narrative: event.target.value })}
        />
      </label>
      <label className={fieldDirty("layoutHint") ? "outline-dirty" : ""}>
        構圖提示
        <textarea
          readOnly={readOnly}
          rows={3}
          value={outlineView.layoutHint}
          {...(fieldDirty("layoutHint") ? { "aria-describedby": dirtyNoteId } : {})}
          onChange={(event) => onDraft({ ...draft, layoutHint: event.target.value })}
        />
      </label>
      <label className={fieldDirty("imagePrompt") ? "outline-dirty" : ""}>
        完整圖片提示詞
        <textarea
          readOnly={readOnly}
          className="prompt"
          rows={6}
          value={outlineView.imagePrompt}
          {...(fieldDirty("imagePrompt") ? { "aria-describedby": dirtyNoteId } : {})}
          onChange={(event) => onDraft({ ...draft, imagePrompt: event.target.value })}
        />
      </label>
      <fieldset>
        <legend>此頁來源</legend>
        {sources.length === 0 ? (
          <small>請先在「來源」上傳資料。</small>
        ) : (
          <SlideSourceChips
            groupId={outlineView.id}
            sources={sources}
            selection={outlineView}
            disabled={readOnly}
            layout="stack"
            // 一律以畫面上顯示的那份選取為準來切換。預覽歷史版本時 outlineView 是
            // 舊快照、draft 是目前草稿，兩者的 sourceIds 並不一致；雖然唯讀時點不到，
            // 讀 draft 會讓「看到的」與「改到的」不是同一份，是留給後人的地雷。
            onToggle={(sourceId) => onDraft(toggleSourcePin(outlineView, sourceId))}
          />
        )}
      </fieldset>
      {provider?.availability.status === "unavailable" && (
        <div className="provider-note">{provider.availability.reason}</div>
      )}
      {provider?.availability.status === "available" && provider.availability.warning && (
        <div className="provider-warning">⚠ {provider.availability.warning}</div>
      )}
      {readinessBusy && (
        <div className="provider-note" role="status">
          正在檢查 provider readiness…
        </div>
      )}
      {readiness && readiness.status !== "ready" && (
        <div className={readiness.blocking ? "provider-note" : "provider-warning"} role="status">
          {readiness.status === "ready_experimental" ? "⚠ " : ""}
          {readiness.message}
        </div>
      )}
      {readiness?.requiresAcknowledgement && (
        <label className="readiness-ack">
          <input
            type="checkbox"
            checked={acceptUnknownReadiness}
            onChange={(event) => onAcceptUnknownReadiness(event.target.checked)}
          />
          我了解 readiness 無法確認，仍要嘗試生成
        </label>
      )}
      {provider?.timeoutMs && (
        <div className="provider-timeout">單頁逾時：{duration(provider.timeoutMs)}</div>
      )}
    </div>
  );
}
