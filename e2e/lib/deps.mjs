// 依賴載入層：E2E 不自帶任何 npm 依賴，一律借用 `apps/server` 已安裝的那份
// （sharp／fflate／pdf-lib）與 `packages/core` 的建置產物（dist）。這樣測試工具跟
// 受測 server 用的是同一份二進位／schema，不會出現「測試用 A 版、server 用 B 版」的偏差。
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** worktree 根目錄（e2e/lib/ 往上兩層）。 */
export const repoRoot = resolve(here, "..", "..");

// 從 server 套件的解析視角 require，才能命中 monorepo 內 hoisted 的實際安裝路徑。
const serverRequire = createRequire(resolve(repoRoot, "apps/server/package.json"));

async function importFrom(specifier) {
  return import(pathToFileURL(serverRequire.resolve(specifier)).href);
}

/** sharp（CJS）— 用於產圖、取像素、量測尺寸。 */
export const sharp = (await importFrom("sharp")).default;
/** fflate（CJS）— 用於解開匯出的 zip 檢查內容。 */
export const fflate = await importFrom("fflate");
/** pdf-lib（CJS，具名 export）— 用於合成測試 PDF fixtures。 */
export const pdfLib = await importFrom("pdf-lib");
/** @slide-maker/core 的建置產物：頁碼幾何／標籤與 schema 的唯一真相。 */
export const core = await import(
  pathToFileURL(resolve(repoRoot, "packages/core/dist/index.js")).href
);
