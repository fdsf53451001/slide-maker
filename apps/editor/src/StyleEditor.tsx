import { useEffect, useMemo, useState } from "react";
import type { StylePreset, StyleReferenceImage } from "@slide-maker/core";
import { api, styleAssetUrl } from "./api.js";
import { PdfImportModal } from "./PdfImportModal.js";
import { ErrorToast } from "./ErrorToast.js";

type Draft = Pick<
  StylePreset,
  | "name"
  | "description"
  | "density"
  | "imageDirection"
  | "avoid"
  | "promptTemplate"
  | "designSystem"
  | "referenceImages"
> & { coverImageId: string | undefined };

function fromStyle(style?: StylePreset): Draft {
  return style
    ? {
        name: style.name,
        description: style.description,
        density: style.density,
        imageDirection: style.imageDirection,
        avoid: [...style.avoid],
        promptTemplate: style.promptTemplate,
        designSystem: style.designSystem,
        referenceImages: [...style.referenceImages],
        coverImageId: style.coverImageId ?? style.referenceImages[0]?.id,
      }
    : {
        name: "",
        description: "",
        density: "high",
        imageDirection: "",
        avoid: [],
        promptTemplate: "",
        designSystem: "",
        referenceImages: [],
        coverImageId: undefined,
      };
}

/**
 * 拿一句一定不是空字串的失敗訊息。
 *
 * 這一頁的 toast 是 `{toast && <ErrorToast/>}`、復原面板是 `{loadError ? … }`：訊息若是空字串，
 * 整塊東西不會出現，於是「儲存失敗」在畫面上與「儲存成功」長得一模一樣。`api.ts` 的
 * `failureMessage()` 已經在來源端保證非空，但這裡收的是任意 `unknown`（第三方庫、`new Error()`
 * 沒帶訊息的網路失敗都到得了），所以顯示端再收一次口，而不是靠上游的善意。
 */
function failureText(reason: unknown, fallback: string): string {
  return (reason instanceof Error && reason.message.trim()) || fallback;
}

/** 這一頁五條互斥的進行中路徑。 */
type BusyKind = "save" | "duplicate" | "restore" | "upload" | "analyze";

/**
 * 「要求的版本不在清單裡」。
 *
 * 與其他載入失敗分開，因為它**重試不會變好**：`api.styleVersions()` 已經成功回來了，只是
 * 裡面沒有這個版本，再打一次必然得到同一份清單、落在同一條分支。給一顆按了沒有任何進展的
 * 「重試載入」比不給更糟——使用者會反覆按它，而唯一的出路（返回風格庫）就在旁邊。
 */
class StyleVersionMissingError extends Error {}

export function StyleEditor({
  styleId,
  historicalVersion,
  onSaved,
  onExit,
}: {
  styleId?: string;
  historicalVersion?: number;
  onSaved: (style: StylePreset) => void;
  onExit: () => void;
}) {
  const [style, setStyle] = useState<StylePreset>();
  const [versions, setVersions] = useState<StylePreset[]>([]);
  const [draft, setDraft] = useState<Draft>(() => fromStyle());
  const [baseline, setBaseline] = useState(() => JSON.stringify(fromStyle()));
  /**
   * 正在進行的動作：`kind`（在跑的是哪一件）＋ `label`（播報用的一句話）。
   *
   * 兩個欄位缺一不可。舊版只有一顆全頁共用的 `busy` boolean，卻同時驅動五個標籤的文案，
   * 於是五個之中有四個在說謊：上傳參考圖時「儲存」寫著「儲存中…」（什麼都沒在儲存），
   * 按下 AI 分析（多秒的模型呼叫）時參考圖控制項立刻寫「＋ 上傳中…」、複製鈕寫「處理中…」，
   * 使用者會去等一個永遠不會完成的上傳。同一時間 live region 卻正確地念出真正在跑的那件事，
   * 視覺與聽覺兩個管道互相矛盾；而上傳那顆是 `<label>` 包 `<input type="file">`，它的
   * 可及名稱會直接變成「＋ 上傳中…」——用無障礙修正製造出的無障礙退步。
   *
   * `kind` 讓每個標籤只認自己那一種（同 `ModelLibrary.tsx` 的 `useRowAction`），`label` 讓
   * 單一 live region 就服務得了五條路。互斥仍由 `busy` 一顆統一負責：同時只准跑一件事是對的，
   * 需要分辨的只有文案。`busy` 因此改成從 `busyAction` 導出而不是另存一份 state——兩份
   * 各自 set 的布林遲早會有一條路只更新其中一份。
   */
  const [busyAction, setBusyAction] = useState<{ kind: BusyKind; label: string }>();
  const busy = !!busyAction;
  const running = (kind: BusyKind) => busyAction?.kind === kind;
  const begin = (kind: BusyKind, label: string) => setBusyAction({ kind, label });
  const finish = () => setBusyAction(undefined);
  const [error, setError] = useState<string>();
  /**
   * 載入這份風格失敗。與 `error`（toast）分開：toast 是可關掉的通知，而載入失敗之後畫面
   * 上只剩一份空表單配著標題「載入中…」，關掉 toast 等於什麼線索都不剩，使用者只能按
   * 瀏覽器上一頁。這個狀態換掉整塊表單，並給出重試與離開兩條路。
   */
  const [loadError, setLoadError] = useState<string>();
  /** 這次的載入失敗重試有沒有意義（見 `StyleVersionMissingError`）。 */
  const [loadRetryable, setLoadRetryable] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pdfImport, setPdfImport] = useState(false);
  // 風格分析無專案脈絡，故在此自選模型組合；空字串＝跟隨模型庫預設。
  const [combinations, setCombinations] = useState<
    { id: string; name: string; isDefault: boolean }[]
  >([]);
  const [analysisCombinationId, setAnalysisCombinationId] = useState("");
  const dirty = JSON.stringify(draft) !== baseline;
  const readOnly = !!historicalVersion || !!style?.system;

  useEffect(() => {
    let current = true;
    const load = async () => {
      if (!styleId) return;
      const all = await api.styleVersions(styleId);
      const selected = historicalVersion
        ? all.find((item) => item.version === historicalVersion)
        : all.at(-1);
      if (!selected)
        throw new StyleVersionMissingError(
          historicalVersion
            ? `這份風格沒有 v${historicalVersion}，它可能已被刪除。請回到風格庫改選一個版本。`
            : "這份風格沒有任何版本可以載入。請回到風格庫確認它還在。",
        );
      if (current) {
        setVersions(all);
        setStyle(selected);
        setDraft(fromStyle(selected));
        setBaseline(JSON.stringify(fromStyle(selected)));
        setLoadError(undefined);
      }
    };
    void load().catch((reason: unknown) => {
      if (!current) return;
      setLoadError(failureText(reason, "載入風格失敗"));
      setLoadRetryable(!(reason instanceof StyleVersionMissingError));
    });
    return () => {
      current = false;
    };
  }, [styleId, historicalVersion, loadAttempt]);

  useEffect(() => {
    const serialized = sessionStorage.getItem("pendingStyleReference");
    if (!serialized || readOnly || (styleId && !style)) return;
    sessionStorage.removeItem("pendingStyleReference");
    try {
      const reference = JSON.parse(serialized) as StyleReferenceImage;
      setDraft((value) =>
        value.referenceImages.length >= 4
          ? value
          : {
              ...value,
              referenceImages: [...value.referenceImages, reference],
              coverImageId: value.coverImageId ?? reference.id,
            },
      );
    } catch {
      /* ignore stale session data */
    }
  }, [styleId, style, readOnly]);

  useEffect(() => {
    let current = true;
    void api
      .modelLibrary()
      .then((library) => {
        if (!current) return;
        setCombinations(
          library.combinations.map((combination) => ({
            id: combination.id,
            name: combination.name,
            isDefault: combination.id === library.defaultCombinationId,
          })),
        );
      })
      // 組合清單載入失敗不擋編輯：下拉留空，分析仍走預設組合。
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const cover = useMemo(
    () =>
      draft.referenceImages.find((item) => item.id === draft.coverImageId) ??
      draft.referenceImages[0],
    [draft],
  );
  const leave = () => {
    if (!dirty || confirm("尚未儲存的風格變更會消失，確定離開？")) onExit();
  };
  const save = async () => {
    begin("save", styleId ? "正在儲存新版本" : "正在建立風格");
    setError(undefined);
    try {
      const saved = styleId ? await api.updateStyle(styleId, draft) : await api.createStyle(draft);
      setStyle(saved);
      setDraft(fromStyle(saved));
      setBaseline(JSON.stringify(fromStyle(saved)));
      onSaved(saved);
    } catch (reason) {
      setError(failureText(reason, "儲存失敗"));
    } finally {
      finish();
    }
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = [...draft.referenceImages];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft({ ...draft, referenceImages: next });
  };

  /**
   * 載入失敗有兩種畫面：手上還沒有任何內容時換成下面那塊復原面板；已經載入過一份、只是
   * 切換版本失敗時，表單還在（復原面板不會出現），這時仍要用 toast 講出來——否則按下版本
   * 連結之後畫面完全沒有反應，看起來像連結壞掉。
   */
  const toast = error ?? (style ? loadError : undefined);

  return (
    <main className="style-editor-page">
      <header className="style-header">
        <button className="brand" onClick={leave}>
          SM<span>↗</span>
        </button>
        <div>
          <strong>
            {styleId ? (style?.name ?? (loadError ? "無法載入風格" : "載入中…")) : "建立風格"}
          </strong>
          <small>
            進階風格設定 ·{" "}
            {historicalVersion
              ? `歷史 v${historicalVersion}`
              : style
                ? `v${style.version}`
                : "新風格"}
          </small>
        </div>
      </header>
      {/*
        載入失敗時整塊表單換成復原面板，而不是讓使用者對著一份「載入中…」的空表單發呆——
        那份表單是可以打字的，存下去等於用空白覆蓋掉一個好好的風格。
      */}
      {styleId && !style && loadError ? (
        <section className="style-editor-grid">
          <div className="style-form">
            <div className="section-label">STYLE SETTINGS</div>
            <h1>無法載入這份風格</h1>
            <div className="provider-note" role="alert">
              {loadError}
            </div>
            <div className="style-actions">
              {/* 重試只在「再打一次可能會不一樣」時才出現（見 `StyleVersionMissingError`）。 */}
              {loadRetryable && (
                <button
                  className="primary"
                  onClick={() => {
                    setLoadError(undefined);
                    setLoadAttempt((value) => value + 1);
                  }}
                >
                  重試載入
                </button>
              )}
              <button className={loadRetryable ? undefined : "primary"} onClick={onExit}>
                返回風格庫
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="style-editor-grid">
          <div className="style-form">
            <div className="section-label">STYLE SETTINGS</div>
            <h1>{readOnly ? "檢視風格版本" : "定義視覺語言"}</h1>
            {style?.system && (
              <div className="provider-note">「AI 自由設計」是唯讀系統風格；可複製後再編輯。</div>
            )}
            <label>
              名稱
              <input
                disabled={readOnly}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              描述
              <textarea
                disabled={readOnly}
                rows={3}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label>
              資訊密度
              <select
                disabled={readOnly}
                value={draft.density}
                onChange={(event) =>
                  setDraft({ ...draft, density: event.target.value as Draft["density"] })
                }
              >
                <option value="low">低（視覺優先）</option>
                <option value="medium">中（圖文平衡）</option>
                <option value="high">高（文字／數據優先，預設）</option>
              </select>
              <small className="density-help">
                高密度會要求更多可讀資訊區塊，並降低裝飾圖片占比。
              </small>
            </label>
            <label>
              設計系統
              <textarea
                disabled={readOnly}
                rows={12}
                value={draft.designSystem}
                onChange={(event) => setDraft({ ...draft, designSystem: event.target.value })}
                placeholder="按下方「AI 分析風格」由參考圖產生；也可自行撰寫。色票、字型、版面與頁型規則以此為準。"
              />
              <small>
                生成時，底色、色票、字級、網格、頁型規則以這裡為準；質感、圖片處理、陰影與收邊則以參考圖為準。
              </small>
            </label>
            <label>
              圖片方向
              <textarea
                disabled={readOnly}
                rows={5}
                value={draft.imageDirection}
                onChange={(event) => setDraft({ ...draft, imageDirection: event.target.value })}
                placeholder="描述影像質感、構圖、光線與視覺節奏"
              />
            </label>
            <label>
              提示詞模板
              <textarea
                disabled={readOnly}
                rows={6}
                value={draft.promptTemplate}
                onChange={(event) => setDraft({ ...draft, promptTemplate: event.target.value })}
              />
            </label>
            <label>
              避免項目（每行一項）
              <textarea
                disabled={readOnly}
                rows={4}
                value={draft.avoid.join("\n")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    avoid: event.target.value
                      .split(/\n/)
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <div className="style-actions">
              {/*
                這兩顆都會**新建一份風格**：少了 disabled，連點兩下就是兩份一模一樣的自訂
                風格躺在風格庫裡，使用者得自己認出哪一份是多的再刪掉。旁邊的「儲存」早就
                擋了 busy，這兩顆只是漏掉。
              */}
              {style?.system && (
                <button
                  disabled={busy}
                  onClick={() => {
                    begin("duplicate", "正在複製為自訂風格");
                    void api
                      .duplicateStyle(style.id)
                      .then(onSaved)
                      .catch((reason: unknown) => setError(failureText(reason, "複製失敗")))
                      .finally(finish);
                  }}
                >
                  {running("duplicate") ? "處理中…" : "複製為自訂風格"}
                </button>
              )}
              {historicalVersion && styleId && (
                <button
                  disabled={busy}
                  onClick={() => {
                    begin("restore", "正在以此版本建立最新版本");
                    void api
                      .restoreStyle(styleId, historicalVersion)
                      .then(onSaved)
                      .catch((reason: unknown) => setError(failureText(reason, "還原失敗")))
                      .finally(finish);
                  }}
                >
                  {running("restore") ? "處理中…" : "以此版本建立最新版本"}
                </button>
              )}
              {!readOnly && (
                <button
                  className="primary"
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  {running("save") ? "儲存中…" : styleId ? "儲存新版本" : "建立風格"}
                </button>
              )}
              {/*
                「儲存中…」「AI 分析中…」都只寫在按鈕文字裡，而參考圖上傳連文字都沒有。
                一個 .visually-hidden 的 live region 覆蓋全部五條路，說得出在跑的是哪一件事；
                視覺回饋仍由各按鈕自己負責（讀屏使用者不需要看見這一行）。與各按鈕的文案
                同源於 `busyAction`，兩個管道因此不可能再互相矛盾。
              */}
              <span className="visually-hidden" role="status">
                {busyAction ? `${busyAction.label}，請稍候。` : ""}
              </span>
            </div>
          </div>
          <aside className="reference-panel">
            <div
              className="style-preview"
              style={cover ? { backgroundImage: `url(${styleAssetUrl(cover.id)})` } : undefined}
            >
              <span>{cover ? "封面參考圖" : draft.name || "風格預覽"}</span>
            </div>
            <div className="section-label">REFERENCE IMAGES · {draft.referenceImages.length}/4</div>
            {!readOnly && (
              /*
                disabled 原本只看「是否已滿 4 張」：上傳期間這顆仍然可按，文字也還寫著
                「＋ 加入 PNG / JPG 參考圖」，於是連選兩個檔會有兩筆上傳同時在跑，兩份
                setDraft 依回應先後把清單擠到 4 張以上或互相覆蓋。旁邊的「從 PDF 匯入」
                早就擋了 busy，這顆只是漏掉。
              */
              <label
                className={`upload-source ${busy || draft.referenceImages.length >= 4 ? "disabled" : ""}`}
              >
                ＋ {running("upload") ? "上傳中…" : "加入 PNG / JPG 參考圖"}
                <input
                  disabled={busy || draft.referenceImages.length >= 4}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    begin("upload", "正在上傳參考圖");
                    void api
                      .uploadStyleReference(file)
                      .then((reference) =>
                        setDraft((value) => ({
                          ...value,
                          referenceImages: [...value.referenceImages, reference],
                          coverImageId: value.coverImageId ?? reference.id,
                        })),
                      )
                      .catch((reason: unknown) => setError(failureText(reason, "上傳失敗")))
                      .finally(finish);
                  }}
                />
              </label>
            )}
            {!readOnly && (
              <button
                type="button"
                className={`upload-source pdf-source ${draft.referenceImages.length >= 4 ? "disabled" : ""}`}
                disabled={busy || draft.referenceImages.length >= 4}
                onClick={() => setPdfImport(true)}
              >
                ＋ 從 PDF 匯入參考圖
              </button>
            )}
            <div className="reference-list">
              {draft.referenceImages.map((reference, index) => (
                <article key={reference.id}>
                  <img src={styleAssetUrl(reference.id)} alt={reference.name} />
                  <div>
                    <strong>{reference.name}</strong>
                    <label>
                      <input
                        disabled={readOnly}
                        type="radio"
                        checked={draft.coverImageId === reference.id}
                        onChange={() => setDraft({ ...draft, coverImageId: reference.id })}
                      />
                      設為卡片封面
                    </label>
                  </div>
                  {!readOnly && (
                    /*
                      三顆按鈕原本只有「↑」「↓」「×」當可及名稱，螢幕閱讀器念的是符號名
                      （或直接跳過）。順序有語意（coverImageId 依賴它）、第三顆會刪掉一張
                      參考圖而上限只有 4 張，猜錯的代價是實際的資料損失。名稱與 Editor.tsx
                      大綱頁那組同功能按鈕一致（往上移動／往下移動），刪除則帶上是哪一張。
                    */
                    <span>
                      <button
                        aria-label="往上移動"
                        title="往上移動"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label="往下移動"
                        title="往下移動"
                        disabled={index === draft.referenceImages.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        aria-label={`刪除參考圖 ${reference.name}`}
                        title={`刪除參考圖 ${reference.name}`}
                        onClick={() => {
                          const referenceImages = draft.referenceImages.filter(
                            (item) => item.id !== reference.id,
                          );
                          setDraft({
                            ...draft,
                            referenceImages,
                            coverImageId:
                              draft.coverImageId === reference.id
                                ? referenceImages[0]?.id
                                : draft.coverImageId,
                          });
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </article>
              ))}
            </div>
            {!readOnly && draft.referenceImages.length > 0 && (
              <div className="analyze-style-row">
                <button
                  className="analyze-style"
                  disabled={busy}
                  onClick={() => {
                    begin("analyze", "AI 正在分析參考圖的風格");
                    setError(undefined);
                    void api
                      .analyzeStyle(
                        draft.referenceImages.map((item) => item.id),
                        analysisCombinationId || undefined,
                      )
                      .then((suggestion) => {
                        // 設計系統整包覆寫（兩份疊加會讓模型讀到兩組矛盾色票）；avoid 取聯集；
                        // imageDirection／promptTemplate 是使用者手寫的補充，分析一律不碰。
                        const shouldApply =
                          !draft.designSystem.trim() ||
                          confirm("AI 分析完成。將取代目前的設計系統內容，確定套用嗎？");
                        if (shouldApply)
                          setDraft((value) => ({
                            ...value,
                            designSystem: suggestion.designSystem,
                            avoid: [...new Set([...value.avoid, ...suggestion.avoid])],
                          }));
                      })
                      .catch((reason: unknown) => setError(failureText(reason, "AI 分析失敗")))
                      .finally(finish);
                  }}
                >
                  {running("analyze") ? "AI 分析中…" : "AI 分析風格"}
                </button>
                <select
                  aria-label="分析用模型組合"
                  value={analysisCombinationId}
                  disabled={busy || combinations.length === 0}
                  onChange={(event) => setAnalysisCombinationId(event.target.value)}
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
              </div>
            )}
            {styleId && (
              <div className="version-links">
                <strong>版本歷史</strong>
                {versions.map((item) => (
                  <a key={item.version} href={`/styles/${styleId}/versions/${item.version}`}>
                    v{item.version} · {new Date(item.updatedAt).toLocaleString("zh-TW")}
                  </a>
                ))}
              </div>
            )}
          </aside>
        </section>
      )}
      {pdfImport && (
        <PdfImportModal
          remaining={4 - draft.referenceImages.length}
          onClose={() => setPdfImport(false)}
          onImported={(references) => {
            setDraft((value) => {
              const added = references.slice(0, 4 - value.referenceImages.length);
              return {
                ...value,
                referenceImages: [...value.referenceImages, ...added],
                coverImageId: value.coverImageId ?? added[0]?.id,
              };
            });
            setPdfImport(false);
          }}
        />
      )}
      {/*
        toast 出現在畫面角落、焦點還停在剛按下的按鈕上；沒有 role="alert" 就等於只有看得
        見的人知道剛才那一步失敗了（而失敗的往往是「儲存」）。結構由共用的 ErrorToast 決定。
      */}
      {toast && (
        <ErrorToast
          message={toast}
          onDismiss={() => {
            setError(undefined);
            setLoadError(undefined);
          }}
        />
      )}
    </main>
  );
}
