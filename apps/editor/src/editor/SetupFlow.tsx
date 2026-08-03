import { Fragment, useEffect, useRef, useState } from "react";
import type { PresentationProject, StylePreset } from "@slide-maker/core";
import { api, type ProviderReadiness, type ProviderSummary } from "../api.js";
import { SourcePanel } from "../SourcePanel.js";
import { toggleSourcePin } from "../sourceSelection.js";
import { hiddenSlideCount, visibleSlideIds } from "./slideVisibility.js";
import {
  briefPatchWithoutWebSearch,
  confirmStyleReplacement,
  styleOptions,
} from "./projectHelpers.js";
import { useWebSearchToggle, WebSearchToggle } from "./webSearch.js";
import { SlideSourceChips } from "./SlideSourceChips.js";
import { BatchGenerateDialog, type BatchGenerateChoice } from "./BatchGenerateDialog.js";

export function SetupFlow({
  project,
  providers,
  styles,
  acceptUnknownReadiness,
  onAcceptUnknownReadiness,
  onProject,
  onExit,
  onError,
}: {
  project: PresentationProject;
  providers: ProviderSummary[];
  styles: StylePreset[];
  acceptUnknownReadiness: boolean;
  onAcceptUnknownReadiness: (value: boolean) => void;
  onProject: (value: PresentationProject) => void;
  onExit: () => void;
  onError: (message: string) => void;
}) {
  const [brief, setBrief] = useState(() => structuredClone(project.brief));
  const [outline, setOutline] = useState(() => structuredClone(project.slides));
  const [busy, setBusy] = useState(false);
  // 隱藏頁只有「返回修改需求」回到精靈時才可能存在（大綱是在編輯器裡才隱藏得了頁面的）。
  // 數的是 project.slides 而不是 outline 草稿：`generateAll` 作用的是伺服器上那一份。
  const hiddenCount = hiddenSlideCount(project.slides);
  const [askBatchChoice, setAskBatchChoice] = useState(false);
  const [showRequirements, setShowRequirements] = useState(
    project.workflowStage === "requirements",
  );
  // requirements 階段拆成兩個客戶端子步驟：false=填需求（brief），true=上傳素材。
  // 素材上傳後才產大綱，讓大綱一開始就被素材 grounding。
  const [materialsSubstep, setMaterialsSubstep] = useState(false);
  const providerRef = useRef<HTMLElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const webSearch = useWebSearchToggle(project, onProject, onError);
  const [combinations, setCombinations] = useState<
    { id: string; name: string; isDefault: boolean; imageModelRef?: string }[]
  >([]);
  // 生成流程改為「選組合」：影像 provider 由組合（或預設組合）解析，不再單獨選 provider。
  const defaultImageRef = combinations.find((item) => item.isDefault)?.imageModelRef;
  const boundCombination = combinations.find((item) => item.id === project.combinationId);
  const effectiveImageProviderId =
    boundCombination?.imageModelRef ?? defaultImageRef ?? "mock-image";
  const effectiveImageProvider = providers.find(
    (candidate) => candidate.id === effectiveImageProviderId,
  );
  // readiness 追蹤「實際會用到的影像 provider」（由組合解析），不是舊的 system providerId。
  const [readiness, setReadiness] = useState<ProviderReadiness>();
  const [readinessBusy, setReadinessBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setReadiness(undefined);
    setReadinessBusy(true);
    void api
      .readiness(effectiveImageProviderId)
      .then((value) => {
        if (alive) setReadiness(value);
      })
      .catch(() => {
        if (alive) setReadiness(undefined);
      })
      .finally(() => {
        if (alive) setReadinessBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [effectiveImageProviderId]);
  // 生成前先檢查影像模型能力 vs 風格參考圖，讓衝突在此步就顯示、而非生成時才報錯。
  const styleRefCount = project.styleSnapshot.referenceImages.length;
  const referenceIssue =
    effectiveImageProvider &&
    styleRefCount > 0 &&
    !effectiveImageProvider.capabilities.referenceImages
      ? "此組合的影像模型不支援參考圖。請改用支援參考圖的影像模型（OpenAI 影像 API 設為 chat），或移除風格的參考圖。"
      : effectiveImageProvider &&
          styleRefCount > 1 &&
          !effectiveImageProvider.capabilities.multipleReferenceImages
        ? "此組合的影像模型只支援單張參考圖。請把風格的參考圖減到 1 張，或改用支援多張參考圖的影像模型。"
        : undefined;

  useEffect(() => {
    void api
      .modelLibrary()
      .then((library) =>
        setCombinations(
          library.combinations.map((combination) => ({
            id: combination.id,
            name: combination.name,
            isDefault: combination.id === library.defaultCombinationId,
            ...(combination.imageModelRef ? { imageModelRef: combination.imageModelRef } : {}),
          })),
        ),
      )
      .catch(() => setCombinations([]));
  }, []);
  /*
    重新播種 brief 草稿的依賴是「伺服器上這份 brief 的**草稿欄位**指紋」，而不是 `project.brief`
    的物件識別：那個物件每次 `onProject` 都是新的，於是 STEP 3 的任何動作（上傳素材、切換自動
    搜尋）都會把使用者在 STEP 2 打到一半、還沒按「下一步」的輸入洗掉。`webSearchMode` 不列入
    指紋——它由勾選框獨佔、不屬於這份草稿（送出時也會被 `briefPatchWithoutWebSearch` 剝掉），
    列進去等於讓「切換自動搜尋」重新獲得清空草稿的能力。
  */
  const serverBriefKey = JSON.stringify({ ...project.brief, webSearchMode: null });
  useEffect(() => {
    setBrief(structuredClone(project.brief));
  }, [project.id, serverBriefKey]);
  useEffect(() => {
    setOutline(structuredClone(project.slides));
  }, [project.id, project.workflowStage]);
  useEffect(() => {
    if (project.workflowStage === "requirements") setShowRequirements(true);
  }, [project.id, project.workflowStage]);

  // 關閉自動搜尋時網路來源不存在，沒有素材就沒有任何可 grounding 的內容，故擋住產生大綱。
  // 解析失敗（status: "failed"）的素材抽不出任何內容，不算數；圖片等其他狀態都算。
  const materialsRequired =
    !webSearch.enabled && !project.sources.some((source) => source.status !== "failed");
  /*
   * 主畫面允許不填需求就建立專案（`brief.topic` 可以是空字串），所以「還沒填主題」是這裡
   * 的常態而非例外：STEP 2 把欄位框成橘色、STEP 3 說明要回去補，兩步都不讓大綱產生——
   * 沒有主題就沒有東西可以規劃。
   */
  const topicMissing = !brief.topic.trim();
  const topicHintId = "setup-topic-hint";

  const produceOutline = async () => {
    setBusy(true);
    onError("");
    try {
      const withBrief = await api.updateBrief(project.id, briefPatchWithoutWebSearch(brief));
      onProject(withBrief);
      // 文字模型由專案組合決定（server 端解析），前端不再傳 textEngine。
      const withOutline = await api.regenerateOutline(project.id, true);
      onProject(withOutline);
      // 明確以新大綱同步 outline：若是「返回修改需求」後再生成，workflowStage 仍是
      // "settings" 不變，倚賴 workflowStage 變化的同步 effect 不會觸發，會殘留舊 slide id
      // 導致確認生成時 updateSlide 打到不存在的頁面（NOT_FOUND）。
      setOutline(structuredClone(withOutline.slides));
      setShowRequirements(false);
      setMaterialsSubstep(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "產生大綱失敗");
    } finally {
      setBusy(false);
    }
  };

  const confirmAndGenerate = async (choice: BatchGenerateChoice = "all") => {
    setBusy(true);
    onError("");
    try {
      let updated = project;
      for (const slide of outline) {
        updated = await api.updateSlide(project.id, slide.id, {
          purpose: slide.purpose,
          content: slide.content,
          narrative: slide.narrative,
          layoutHint: slide.layoutHint,
          imagePrompt: slide.imagePrompt,
          sourceIds: slide.sourceIds,
          pinnedSourceIds: slide.pinnedSourceIds,
        });
      }
      onProject(updated);
      if (referenceIssue) throw new Error(referenceIssue);
      const currentReadiness = await api.readiness(effectiveImageProviderId);
      if (
        currentReadiness.blocking ||
        (currentReadiness.requiresAcknowledgement && !acceptUnknownReadiness)
      ) {
        throw new Error(currentReadiness.message);
      }
      // 不傳 providerId：server 依專案組合（或預設組合）解析影像模型。
      // slideIds 同理只在「只生成可見頁」時才傳，"all" 走的是加入隱藏頁之前的同一條路。
      await api.generateAll(
        project.id,
        undefined,
        acceptUnknownReadiness,
        choice === "visible-only" ? visibleSlideIds(updated.slides) : undefined,
      );
      onProject(await api.getProject(project.id));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "生成簡報失敗");
    } finally {
      setBusy(false);
    }
  };

  const requirementsStep = project.workflowStage === "requirements" || showRequirements;
  // 進度列可回跳：已產生過大綱（outlineExists）後任一步都能點回去改，否則只能點到目前步驟為止。
  const outlineExists = project.slides.length > 0;
  const currentStep = !requirementsStep ? 4 : materialsSubstep ? 3 : 2;
  const stepClickable = (step: number) => step === 1 || step <= currentStep || outlineExists;
  const goToStep = (step: number) => {
    if (step === 1) {
      providerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (step === 2) {
      setShowRequirements(true);
      setMaterialsSubstep(false);
    } else if (step === 3) {
      setShowRequirements(true);
      setMaterialsSubstep(true);
    } else if (step === 4 && outlineExists) {
      setShowRequirements(false);
    }
  };
  return (
    <main className="setup-page">
      <header className="setup-header">
        <button className="brand" onClick={onExit}>
          SM<span>↗</span>
        </button>
        <div>
          <strong>{project.name}</strong>
          <small>四步完成整份簡報</small>
        </div>
      </header>
      <div className="setup-steps" aria-label="建立簡報流程">
        {[
          { step: 1, label: "選擇模型" },
          { step: 2, label: "需求" },
          { step: 3, label: "上傳素材" },
          { step: 4, label: "確認生成" },
        ].map(({ step, label }, index) => (
          <Fragment key={step}>
            {index > 0 && <i />}
            <button
              type="button"
              className={step === currentStep ? "active" : step < currentStep ? "done" : ""}
              disabled={busy || !stepClickable(step)}
              aria-current={step === currentStep ? "step" : undefined}
              onClick={() => goToStep(step)}
            >
              <b>{step}</b>
              <span>{label}</span>
            </button>
          </Fragment>
        ))}
      </div>
      <section className="setup-card setup-provider" aria-label="選擇模型組合" ref={providerRef}>
        <div className="section-label">STEP 1 · 選擇模型組合</div>
        <p>影像／文字／搜尋模型都由組合決定。要調整或新增組合，請到模型庫。</p>
        <div className="setup-grid">
          <label>
            專案模型組合
            <select
              value={project.combinationId ?? ""}
              disabled={combinations.length === 0}
              onChange={(event) => {
                const combinationId = event.target.value;
                if (!combinationId) return;
                void api
                  .setProjectCombination(project.id, combinationId)
                  .then(onProject)
                  .catch((reason: unknown) =>
                    onError(reason instanceof Error ? reason.message : "設定組合失敗"),
                  );
              }}
            >
              <option value="">
                {`跟隨預設${
                  combinations.find((item) => item.isDefault)
                    ? `（${combinations.find((item) => item.isDefault)!.name}）`
                    : ""
                }`}
              </option>
              {combinations.map((combination) => (
                <option key={combination.id} value={combination.id}>
                  {combination.name}
                  {combination.isDefault ? "（預設）" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {effectiveImageProviderId === "mock-image" && (
          <p className="setup-provider-hint">
            此組合的影像模型是
            Mock（不消耗配額、非真實生成）。要用真實模型出圖，請到模型庫調整組合。
          </p>
        )}
        {referenceIssue && <p className="provider-note">{referenceIssue}</p>}
      </section>
      {requirementsStep ? (
        materialsSubstep ? (
          <section className="setup-card setup-materials">
            <div className="section-label">STEP 3 · 上傳素材</div>
            <h1>上傳生成會用到的素材</h1>
            <p>
              文件、圖片、貼上文字或加入搜尋資料都會建立索引；產生大綱與後續生成時即可引用。開啟自動搜尋網路資源時，這一步可略過；關閉時必須至少提供一項素材。
            </p>
            <SourcePanel project={project} onProject={onProject} onError={onError} />
            {materialsRequired && (
              <p className="setup-materials-hint" id="setup-materials-hint">
                已關閉自動搜尋，請先上傳或貼上至少一項素材再產生大綱。
              </p>
            )}
            {/* 不填需求就開始的專案，可以直接從步驟列跳到這一步；此時大綱一樣產不出來。 */}
            {topicMissing && (
              <p className="setup-materials-hint" id="setup-topic-missing-hint">
                尚未填寫簡報需求，請回到「需求」步驟補上再產生大綱。
              </p>
            )}
            <div className="setup-materials-actions">
              <button
                type="button"
                className="setup-back"
                disabled={busy}
                onClick={() => setMaterialsSubstep(false)}
              >
                <span>←</span> 上一步
              </button>
              <div className="setup-materials-submit">
                <WebSearchToggle
                  className="setup-websearch-toggle"
                  enabled={webSearch.enabled}
                  busy={webSearch.busy}
                  disabled={busy}
                  onToggle={webSearch.toggle}
                />
                <button
                  className="primary setup-submit"
                  disabled={busy || topicMissing || materialsRequired}
                  // 停用按鈕本身不會說明原因，讀屏使用者需要指回那句提示；兩個原因可能同時
                  // 成立（既沒填需求也沒素材），所以 id 是串起來的而不是二選一。
                  aria-describedby={
                    [
                      materialsRequired ? "setup-materials-hint" : "",
                      topicMissing ? "setup-topic-missing-hint" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  onClick={() => void produceOutline()}
                >
                  {busy ? "正在產生大綱…" : `產生 ${brief.desiredSlideCount} 頁大綱`}
                  <span>→</span>
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="setup-card">
            <div className="section-label">STEP 2 · 需求</div>
            <h1>先確認這份簡報要說什麼</h1>
            <p>系統會依下列需求建立大綱；頁數以這裡確認的數字為準。</p>
            <div className="setup-grid">
              {/*
                主畫面允許不填需求就開始，所以這一格常常是空的——空著時用橘色外框把它標出來
                並說明下一步為什麼停用。停用的按鈕自己不會說話，這句提示就是它的理由。
              */}
              {/* 提示句刻意放在 `<label>` **外面**：包在裡面會被算進欄位的無障礙名稱，
                  螢幕閱讀器會把它念成「簡報需求 尚未填寫：…」，而 aria-describedby 隨即
                  再念一次。 */}
              <div className={`wide${topicMissing ? " field-needs-input" : ""}`}>
                <label>
                  簡報需求
                  <textarea
                    rows={4}
                    value={brief.topic}
                    aria-describedby={topicMissing ? topicHintId : undefined}
                    onChange={(event) => setBrief({ ...brief, topic: event.target.value })}
                  />
                </label>
                {topicMissing && (
                  <small className="field-needs-input-hint" id={topicHintId}>
                    尚未填寫：描述這份簡報要說什麼，才能產生大綱。
                  </small>
                )}
              </div>
              <label>
                目標觀眾
                <input
                  value={brief.audience}
                  onChange={(event) => setBrief({ ...brief, audience: event.target.value })}
                />
              </label>
              <label>
                簡報目的
                <input
                  value={brief.purpose}
                  onChange={(event) => setBrief({ ...brief, purpose: event.target.value })}
                />
              </label>
              <label>
                頁數
                <input
                  aria-label="簡報頁數"
                  type="number"
                  min={1}
                  max={100}
                  value={brief.desiredSlideCount}
                  onChange={(event) =>
                    setBrief({ ...brief, desiredSlideCount: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                語言
                <input
                  value={brief.language}
                  onChange={(event) => setBrief({ ...brief, language: event.target.value })}
                />
              </label>
              <label>
                語氣
                <input
                  value={brief.tone}
                  onChange={(event) => setBrief({ ...brief, tone: event.target.value })}
                />
              </label>
              <label>
                演講時間（分鐘）
                <input
                  type="number"
                  min={1}
                  value={brief.durationMinutes ?? ""}
                  onChange={(event) =>
                    setBrief({
                      ...brief,
                      durationMinutes: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
            </div>
            <button
              className="primary setup-submit"
              disabled={
                busy || topicMissing || brief.desiredSlideCount < 1 || brief.desiredSlideCount > 100
              }
              // 停用按鈕本身不會說明原因，讀屏使用者需要指回欄位下方那句提示。
              aria-describedby={topicMissing ? topicHintId : undefined}
              onClick={() => {
                void api
                  .updateBrief(project.id, briefPatchWithoutWebSearch(brief))
                  .then(onProject)
                  .catch(() => undefined);
                setMaterialsSubstep(true);
              }}
            >
              下一步：上傳素材
              <span>→</span>
            </button>
          </section>
        )
      ) : (
        <section className="setup-card setup-settings">
          <header className="setup-settings-header">
            <div>
              <div className="section-label">STEP 4 · 確認大綱與生成設定</div>
              <h1>確認大綱與生成設定</h1>
              <p>逐頁檢查內容與敘事，確認後會立即排程全部 {outline.length} 頁。</p>
            </div>
            <div className="outline-count" aria-label={`共 ${outline.length} 頁`}>
              <strong>{outline.length}</strong>
              <span>頁簡報</span>
            </div>
          </header>
          {project.outlineRationale && (
            <div className="outline-rationale">
              <strong>AI 頁數與敘事說明</strong>
              <p>{project.outlineRationale}</p>
            </div>
          )}
          <div className="outline-review">
            {outline.map((slide, index) => (
              <article key={slide.id}>
                <div className="outline-card-header">
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <span>第 {index + 1} 頁</span>
                  <div className="outline-actions" aria-label={`第 ${index + 1} 頁操作`}>
                    <button
                      aria-label="往上移動"
                      title="往上移動"
                      disabled={busy || index === 0}
                      onClick={() => {
                        const ids = outline.map((item) => item.id);
                        [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                        setBusy(true);
                        void api
                          .reorderSlides(project.id, ids)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "排序失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      aria-label="往下移動"
                      title="往下移動"
                      disabled={busy || index === outline.length - 1}
                      onClick={() => {
                        const ids = outline.map((item) => item.id);
                        [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
                        setBusy(true);
                        void api
                          .reorderSlides(project.id, ids)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "排序失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      ↓
                    </button>
                    <button
                      className="outline-delete"
                      disabled={busy || outline.length === 1}
                      onClick={() => {
                        setBusy(true);
                        void api
                          .deleteSlide(project.id, slide.id)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "刪除失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      刪除
                    </button>
                  </div>
                </div>
                <div className="outline-fields">
                  <label className="outline-purpose">
                    頁面目的
                    <input
                      value={slide.purpose}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? { ...item, purpose: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="outline-content">
                    頁面內容
                    <textarea
                      rows={2}
                      value={slide.content}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? { ...item, content: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    敘事
                    <textarea
                      rows={2}
                      value={slide.narrative}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id
                              ? { ...item, narrative: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    構圖
                    <textarea
                      rows={2}
                      value={slide.layoutHint}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id
                              ? { ...item, layoutHint: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {project.sources.length > 0 && (
                    <SlideSourceChips
                      groupId={slide.id}
                      sources={project.sources}
                      selection={slide}
                      onToggle={(sourceId) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? toggleSourcePin(item, sourceId) : item,
                          ),
                        )
                      }
                    />
                  )}
                </div>
              </article>
            ))}
          </div>
          <button
            className="add-outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onError("");
              const last = outline.at(-1)?.id;
              void api
                .addSlide(project.id, last ? { afterSlideId: last } : {})
                .then((updated) => {
                  onProject(updated);
                  setOutline(structuredClone(updated.slides));
                })
                .catch((reason: unknown) =>
                  onError(reason instanceof Error ? reason.message : "新增頁面失敗"),
                )
                .finally(() => setBusy(false));
            }}
          >
            ＋ 新增一頁
          </button>
          <div className="generation-panel">
            <div className="generation-panel-copy">
              <span className="section-label">FINAL CHECK</span>
              <strong>準備生成 {outline.length} 頁簡報</strong>
              <p>選擇視覺風格後，即可建立全部頁面的生成工作。</p>
            </div>
            <div className="generation-settings">
              <label>
                簡報風格
                <select
                  value={project.styleSnapshot.id}
                  onChange={(event) => {
                    if (!confirmStyleReplacement(styles, project.styleSnapshot, event.target.value))
                      return;
                    setBusy(true);
                    void api
                      .applyStyle(project.id, event.target.value)
                      .then(onProject)
                      .catch((reason: unknown) =>
                        onError(reason instanceof Error ? reason.message : "套用風格失敗"),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {styleOptions(styles, project.styleSnapshot)}
                </select>
              </label>
            </div>
          </div>
          {effectiveImageProvider?.availability.status === "unavailable" && (
            <div className="provider-note">{effectiveImageProvider.availability.reason}</div>
          )}
          {effectiveImageProvider?.availability.status === "available" &&
            effectiveImageProvider.availability.warning && (
              <div className="provider-warning">
                ⚠ {effectiveImageProvider.availability.warning}
              </div>
            )}
          {readinessBusy && (
            <div className="provider-note" role="status">
              正在檢查 provider readiness…
            </div>
          )}
          {readiness && readiness.status !== "ready" && (
            <div
              className={readiness.blocking ? "provider-note" : "provider-warning"}
              role="status"
            >
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
          <div className="setup-actions">
            <button onClick={() => setShowRequirements(true)} disabled={busy}>
              返回修改需求
            </button>
            <button
              className="primary"
              // 有隱藏頁就先問，而且是在整條 async 鏈**開始之前**問掉：鏈中途彈窗會讓
              // 「已經寫回去的大綱」與「還沒決定要不要生成」兩件事同時懸在半空。
              // 沒有隱藏頁時完全不多一次點擊，與加入這個對話框之前一致。
              onClick={() => {
                if (hiddenCount > 0) setAskBatchChoice(true);
                else void confirmAndGenerate("all");
              }}
              disabled={
                busy ||
                outline.length === 0 ||
                !!referenceIssue ||
                effectiveImageProvider?.availability.status !== "available" ||
                readinessBusy ||
                !readiness ||
                readiness.blocking ||
                (readiness.requiresAcknowledgement && !acceptUnknownReadiness)
              }
            >
              {busy ? "正在建立生成工作…" : `確認設定並生成 ${outline.length} 頁簡報`}
              <span>→</span>
            </button>
          </div>
        </section>
      )}
      {askBatchChoice && (
        <BatchGenerateDialog
          total={project.slides.length}
          hiddenCount={hiddenCount}
          busy={busy}
          onCancel={() => setAskBatchChoice(false)}
          onChoose={(choice) => {
            setAskBatchChoice(false);
            void confirmAndGenerate(choice);
          }}
        />
      )}
    </main>
  );
}
