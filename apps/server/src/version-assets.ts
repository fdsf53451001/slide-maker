import type { SlideSpec, SlideVersion } from "@slide-maker/core";

/**
 * 版本資產的引用與回收——五條建版路徑（生成、編輯、抽字、PDF 匯入、手動文字層）共用的那
 * 一小塊。
 *
 * 這裡刻意**只收斂真正逐字重複的部分**：一個版本持有哪幾個資產路徑、全專案還引用著哪些、
 * 待刪候選過濾成孤兒、以及「掛上新版本並切過去」。textLayer 的建構、檔名慣例、失敗回收
 * 策略都留在各自的呼叫端——它們形似但變體是語意（別名背景 vs 新落地背景、隨機尾碼 vs
 * 單次寫入、逐檔回收 vs 刪整個專案目錄），硬參數化只會做出一個多旗標的假共用。
 */

/** `versionAssetPaths` 需要的最小形狀；`SlideVersion` 結構上滿足它。 */
export interface VersionAssetSource {
  imagePath: string;
  textLayer?: { backgroundPath: string; compositePath: string } | undefined;
}

/** `referencedVersionAssets` 需要的最小形狀；`PresentationProject` 結構上滿足它。 */
export interface ProjectAssetSource {
  slides: readonly { versions: readonly VersionAssetSource[] }[];
}

/**
 * 一個版本直接持有的資產路徑（儲存形式，帶 `assets/` 前綴）。
 *
 * 三個欄位常常指向同一個檔案（沒有文字層時 imagePath 就是全部；手動層的 backgroundPath
 * 是原圖版本 imagePath 的**別名**，不是自己的檔案），所以回傳值會有重複——判斷引用與過濾
 * 待刪都走 Set，重複無害，而去重會讓「這一版提到了哪些路徑」變得不好讀。
 */
export function versionAssetPaths(version: VersionAssetSource): string[] {
  return [
    version.imagePath,
    ...(version.textLayer
      ? [version.textLayer.backgroundPath, version.textLayer.compositePath]
      : []),
  ];
}

/**
 * 全專案仍被引用的資產路徑。
 *
 * **必須在移除／替換之後才呼叫。** 多個版本共用同一個 imagePath 是常態（restore 是
 * structuredClone 舊版本、複製頁面刻意不複製檔案、手動層的背景是別名），所以「這個檔案還
 * 有沒有人要」只能對移除後的專案重算才算得準；在移除前算，被刪的那一版自己還在集合裡，
 * 於是永遠刪不掉。
 */
export function referencedVersionAssets(project: ProjectAssetSource): Set<string> {
  return new Set(
    project.slides.flatMap((slide) =>
      slide.versions.flatMap((version) => versionAssetPaths(version)),
    ),
  );
}

/**
 * 待刪候選裡真正成為孤兒的那些（順序照 `candidates` 的走訪順序，重複只留第一次）。
 *
 * 同樣要在移除／替換之後呼叫——`project` 必須是**變更後**的狀態。
 */
export function staleVersionAssets(
  project: ProjectAssetSource,
  candidates: Iterable<string>,
): string[] {
  const referenced = referencedVersionAssets(project);
  return [...new Set(candidates)].filter((assetPath) => !referenced.has(assetPath));
}

/**
 * 掛上新版本並切成當前版本。
 *
 * **只做這兩件事**：不碰 `hidden`（隱藏是頁面層級的旗標，與影像版本無關）、不回灌
 * `outlineSnapshot`／`pinnedSourceIds`（restore 要、生成不要）、不 clone（呼叫端各自決定
 * 要不要複製，`updateProject` 的 callback 拿到的就是要寫回去的那份）。想在這裡多做一件
 * 事之前先確認四個呼叫端都要它——PDF 匯入正是因為 `currentVersionId` 要指原圖 A 而不是
 * 剛 push 的文字層 B，所以刻意不走這個 helper。
 */
export function adoptVersion(
  slide: Pick<SlideSpec, "versions" | "currentVersionId">,
  version: SlideVersion,
): void {
  slide.versions.push(version);
  slide.currentVersionId = version.id;
}
