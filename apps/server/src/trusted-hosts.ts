import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logWarn } from "@slide-maker/core";

/**
 * host／origin allowlist 中介層（原本寫在 createApp 裡）。
 *
 * 註冊順序是行為的一部分：必須排在 `express.json` 之後、所有 route 之前。
 */
export function trustedHostMiddleware(allowedHosts: ReadonlySet<string>): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const hostname = request.hostname.toLowerCase();
    if (!allowedHosts.has(hostname)) {
      logWarn("trusted_host_rejected", {
        host: request.hostname,
        origin: request.headers.origin,
        reason: "LOCAL_HOST_REQUIRED",
      });
      return response.status(403).json({ error: "LOCAL_HOST_REQUIRED" });
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const originHost = new URL(origin).hostname.toLowerCase();
        if (!allowedHosts.has(originHost)) {
          logWarn("trusted_host_rejected", {
            host: request.hostname,
            origin: request.headers.origin,
            reason: "LOCAL_ORIGIN_REQUIRED",
          });
          return response.status(403).json({ error: "LOCAL_ORIGIN_REQUIRED" });
        }
      } catch {
        logWarn("trusted_host_rejected", {
          host: request.hostname,
          origin: request.headers.origin,
          reason: "INVALID_ORIGIN",
        });
        return response.status(403).json({ error: "INVALID_ORIGIN" });
      }
    }
    return next();
  };
}
