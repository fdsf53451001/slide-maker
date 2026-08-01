import type { Express } from "express";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/** 健康檢查、provider 清單與 readiness、文字模型清單。 */
export function registerSystemRoutes(app: Express, ctx: AppContext): void {
  const { runtime, readiness } = ctx;

  app.get("/api/health", (_request, response) => response.json({ ok: true, schemaVersion: 1 }));
  app.get("/api/providers", (_request, response) =>
    response.json(
      runtime.imageProviders.list().map((provider) => ({
        id: provider.id,
        name: provider.name,
        availability: provider.availability,
        capabilities: provider.capabilities,
        timeoutMs: provider.timeoutMs,
        maxConcurrency: provider.maxConcurrency,
      })),
    ),
  );
  app.get("/api/providers/:providerId/readiness", async (request, response) => {
    const providerId = idSchema.parse(request.params.providerId);
    return response.json(await readiness.check(providerId));
  });
  // 文字能力的 model entry 清單（供組合編輯器）。
  app.get("/api/text-providers", (_request, response) => {
    const defaultTextRef = runtime.library.combinations.find(
      (combination) => combination.id === runtime.library.defaultCombinationId,
    )?.textModelRef;
    return response.json(
      runtime.library.models
        .filter((entry) => entry.capability === "text")
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          availability: runtime.structuredText(entry.id).availability,
          isDefault: entry.id === defaultTextRef,
        })),
    );
  });
}
