// `changelog.ts` 以 `?raw` 內嵌 CHANGE.md；少了這行 tsc（含 tsconfig.build.json 的
// declaration 產出）不認得 Vite 的 `?raw` 模組宣告，會以「找不到模組」失敗。
/// <reference types="vite/client" />
