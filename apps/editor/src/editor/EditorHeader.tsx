import { useState } from "react";
import type { PresentationProject } from "@slide-maker/core";
import { api } from "../api.js";

/**
 * 編輯器頂欄：品牌鈕（回專案列表）、專案名稱與 inline 改名、簡報模式、自動儲存狀態、系統設定。
 *
 * `editingName`／`nameDraft` 是這裡的**內部狀態**：整個編輯器只有這一塊 JSX 讀寫它們，
 * 放在 `Editor` 那層只是讓每一次打字都重畫整個編輯器。改名的送出時序刻意保持原樣——
 * 先關掉編輯態、再讀當下的草稿、最後才發請求。
 */
export function EditorHeader({
  project,
  saving,
  onProject,
  onError,
  onHome,
  onStartPresentation,
  onOpenSettings,
}: {
  project: PresentationProject;
  saving: boolean;
  onProject: (project: PresentationProject) => void;
  onError: (message: string) => void;
  onHome: () => void;
  onStartPresentation: () => void;
  onOpenSettings: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  return (
    <header>
      <button className="brand" onClick={onHome}>
        SM<span>↗</span>
      </button>
      <div className="title-block">
        {editingName ? (
          <input
            className="title-name-input"
            // 沒有 label、沒有 placeholder，螢幕閱讀器只念得到一個空的文字框——而它一進場
            // 就 autoFocus，使用者聽到的第一句話會是「編輯」兩個字。
            aria-label="專案名稱"
            autoFocus
            value={nameDraft}
            maxLength={200}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              setEditingName(false);
              const next = nameDraft.trim();
              if (next && next !== project.name) {
                void api
                  .updateProjectName(project.id, next)
                  .then((updated) => onProject(updated))
                  .catch((reason: unknown) =>
                    onError(reason instanceof Error ? reason.message : "重新命名失敗"),
                  );
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.currentTarget as HTMLInputElement).blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditingName(false);
              }
            }}
          />
        ) : (
          <strong
            className="title-name"
            role="button"
            tabIndex={0}
            // 長名字在 header 會被 ellipsis 截斷，tooltip 是看到全名的唯一途徑。
            title={`${project.name}\n點一下重新命名`}
            onClick={() => {
              setNameDraft(project.name);
              setEditingName(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setNameDraft(project.name);
                setEditingName(true);
              }
            }}
          >
            {project.name}
          </strong>
        )}
        <small>
          {project.canvas.width} × {project.canvas.height} · {project.styleSnapshot.name}
        </small>
      </div>
      {/* 專案／來源／匯出三個面板的唯一入口是右側 inspector 的分頁；header 只留簡報模式。 */}
      <nav className="workspace-nav">
        <button className="present-button" onClick={onStartPresentation}>
          ▶ 簡報模式
        </button>
      </nav>
      {/* 自動儲存是「不用你按存檔」的唯一證據，而它只有一個色點加一句文字；沒有
        live region 時，看不到畫面的人不會知道自己的編輯到底送出去了沒有。
        已知取捨：每次自動儲存會播報兩次（「正在…」→「已…」），編輯文字層時偏吵；
        但相對於完全不知道存了沒有，吵是比較小的錯。 */}
      <div className="header-status" role="status">
        <span className="status-dot" />
        {saving ? "正在自動儲存…" : "已自動儲存"}
      </div>
      <button
        className="system-settings-button"
        aria-label="系統設定"
        title="系統設定"
        onClick={onOpenSettings}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </header>
  );
}
