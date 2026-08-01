import type { PresentationProject, SlideSpec, SlideVersion } from "@slide-maker/core";
import { api, imageUrl } from "../api.js";
import { versionDeleteConfirmText, VERSION_DELETE_MESSAGES } from "./projectHelpers.js";

/**
 * 版本歷史的縮圖卡片列。
 *
 * 刻意不放「版本歷史」標題：縮圖卡片本身已帶時間戳與「使用中」標記，省下的高度全部
 * 讓給畫布。無障礙資訊仍在每張卡片的 aria-label 上。
 *
 * `previewVersion` 與 `previewVersionId` 兩個都要收，不可收斂成一個：前者是**已解析且
 * 不等於目前版本**的那一份（決定卡片要不要標「預覽」），後者是使用者點過的原始 id
 * （刪除後要清掉的就是它）。點到目前版本時前者是 undefined 而後者不是。
 */
export function VersionStrip({
  projectId,
  selected,
  previewVersion,
  previewVersionId,
  deletingVersionId,
  onPreviewVersionId,
  onDeletingVersionId,
  run,
}: {
  projectId: string;
  selected: SlideSpec | undefined;
  previewVersion: SlideVersion | undefined;
  previewVersionId: string | undefined;
  deletingVersionId: string | undefined;
  onPreviewVersionId: (versionId: string | undefined) => void;
  onDeletingVersionId: (versionId: string | undefined) => void;
  run: (operation: () => Promise<PresentationProject>) => Promise<PresentationProject | undefined>;
}) {
  return (
    <div className="versions">
      <div className="version-list">
        {selected?.versions.length === 0 && <span className="empty-inline">尚無版本</span>}
        {[...(selected?.versions ?? [])].reverse().map((version) => {
          const isCurrent = version.id === selected?.currentVersionId;
          const isPreviewing = version.id === previewVersion?.id;
          const versionNumber =
            (selected?.versions.findIndex((candidate) => candidate.id === version.id) ?? 0) + 1;
          return (
            // 刪除鈕必須是獨立的 button，巢狀 button 是無效 HTML；因此外層改用 div
            // 當定位容器，預覽仍然是裡面那顆原本的 button。
            <div className="version-item" key={version.id}>
              <button
                aria-label={`版本 ${versionNumber}${version.label ? `：${version.label}` : ""}${isCurrent ? "（目前）" : ""}`}
                className={`${isCurrent ? "current" : ""} ${isPreviewing ? "previewing" : ""}`.trim()}
                onClick={() => onPreviewVersionId(isCurrent ? undefined : version.id)}
              >
                <img src={imageUrl(projectId, version.imagePath)} alt="version" />
                {/*
                PDF 匯入的兩個版本是同一秒建立的，只看時間戳分不出哪個是原圖、
                哪個是可編輯文字，所以有 label 就顯示 label。
              */}
                {version.label && <span className="version-label">{version.label}</span>}
                <span>
                  {(() => {
                    const d = new Date(version.createdAt);
                    const p2 = (n: number) => String(n).padStart(2, "0");
                    return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(
                      d.getMinutes(),
                    )}`;
                  })()}
                  {isCurrent ? " · 使用中" : isPreviewing ? " · 預覽" : ""}
                </span>
              </button>
              {/* 使用中的版本刪不掉（伺服器也擋），不顯示按鈕免得使用者白按一次。 */}
              {!isCurrent && selected && (
                <button
                  type="button"
                  className="version-delete"
                  aria-label={`刪除版本 ${versionNumber}`}
                  disabled={!!deletingVersionId}
                  onClick={() => {
                    if (deletingVersionId) return;
                    if (!window.confirm(versionDeleteConfirmText(version))) return;
                    onDeletingVersionId(version.id);
                    void run(async () => {
                      try {
                        return await api.deleteVersion(projectId, selected.id, version.id);
                      } catch (reason) {
                        const code = reason instanceof Error ? reason.message : "";
                        throw new Error(VERSION_DELETE_MESSAGES[code] ?? (code || "刪除版本失敗"));
                      }
                    })
                      .then((updated) => {
                        // 預覽中的版本被刪掉後，這個 id 已經指不到任何版本了；留著它
                        // 只會讓下一次點同一張卡片的切換行為看起來時靈時不靈。
                        if (updated && previewVersionId === version.id)
                          onPreviewVersionId(undefined);
                      })
                      .finally(() => onDeletingVersionId(undefined));
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
