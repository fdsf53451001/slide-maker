import type { SlideSpec } from "@slide-maker/core";

/**
 * 匯出面板。四種格式的下載連結都是裸 `<a href>`（瀏覽器直接接手串流回應），所以
 * 「伺服器會回 400」的那兩種情形必須在這裡就擋掉並就地說明——按下去只會得到一段 JSON。
 */
export function ExportPanel({
  projectId,
  selected,
  activeImage,
  hiddenCount,
  visibleSlideCount,
}: {
  projectId: string;
  selected: SlideSpec | undefined;
  activeImage: string | undefined;
  hiddenCount: number;
  visibleSlideCount: number;
}) {
  return (
    <div className="panel-content export-panel">
      <div className="inspector-heading">
        <span>EXPORT</span>
      </div>
      <section className="export-group">
        <h3>專案</h3>
        {/*
        靜態的匯出規則說明已依使用者要求移除；只留「這份簡報實際上有隱藏頁」這一句，
        因為那不是通則而是當下狀態，且 pptx／pdf 的頁數會與畫面上看到的不同——
        「哪些頁面會進成品」在有差異時仍必須寫在下載點旁邊（縮圖列那顆 23px 按鈕的
        tooltip 在使用者按下「下載 PowerPoint」時是看不到的）。
      */}
        {hiddenCount > 0 && (
          <p>
            有 <strong>{hiddenCount}</strong> 頁隱藏：pptx／pdf 只含可見的{" "}
            <strong>{visibleSlideCount}</strong> 頁。
          </p>
        )}
        {visibleSlideCount === 0 ? (
          // 全部隱藏時伺服器會回 400；匯出連結是裸 `<a href>`，讓它按下去等於把一段
          // JSON 丟進瀏覽器分頁。這裡先擋住並就地說明。
          <p className="export-blocked" role="status">
            所有頁面都已隱藏，pptx／pdf 沒有可以匯出的頁面。請先取消隱藏至少一頁；
            下方兩種格式仍會收錄全部頁面。
          </p>
        ) : (
          <>
            <a href={`/api/projects/${encodeURIComponent(projectId)}/export/pptx`}>
              下載 PowerPoint (.pptx)
            </a>
            <a href={`/api/projects/${encodeURIComponent(projectId)}/export/pdf`}>
              下載 PDF (.pdf)
            </a>
          </>
        )}
        <a href={`/api/projects/${encodeURIComponent(projectId)}/export/png.zip`}>
          下載每頁 PNG (.zip)
        </a>
        <a href={`/api/projects/${encodeURIComponent(projectId)}/export/slide-project`}>
          備份完整專案 (.slide-project.zip)
        </a>
      </section>
      <section className="export-group">
        <h3>
          <span>當前頁面</span>
          {selected && <b>第 {selected.order + 1} 頁</b>}
        </h3>
        {/*
        隱藏頁照樣給連結：`hidden` 的語意是「這一頁不上場」而不是「不要這張圖」，
        png.zip 本來就收錄它。沒有目前版本時整個不給連結——伺服器會回 400，而這是
        裸 `<a href>`，按下去只會得到一段 JSON。
      */}
        {selected && activeImage ? (
          <a
            href={`/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(selected.id)}/export/png`}
          >
            下載此頁 PNG (.png)
          </a>
        ) : (
          <p className="export-blocked" role="status">
            這一頁還沒有圖片，沒有可以下載的 PNG。請先生成這一頁。
          </p>
        )}
      </section>
    </div>
  );
}
