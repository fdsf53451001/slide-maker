import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 這個套件的測試會做真實的點陣工作：PPTX 匯出（1920×1080 背景 raster + JPEG
    // 轉檔）、PDF 渲染、字形量測樣本渲染。單跑都在數秒內，但整個套件並行時互相搶
    // CPU，vitest 預設的 5 秒逾時就會隨機把它們判死——失敗訊息還是「timed out」，
    // 看起來像功能壞掉。這裡把預設時間預算拉到足以吸收並行抖動，仍保留上界。
    testTimeout: 30_000,
  },
});
