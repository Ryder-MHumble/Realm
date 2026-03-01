/**
 * Dispatch Handler
 *
 * POST /dispatch — OpenClaw calls this to send a task to Realm.
 *   Request:  { message: string, callbackUrl?: string, sessionId?: string }
 *   Response: { ok, taskGroupId, dispatched: [{sessionId, sessionName, prompt}] }
 *
 * When all dispatched sessions complete, Realm POSTs to callbackUrl:
 *   { taskGroupId, originalMessage, results: [{sessionName, response}], durationMs }
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse } from "./httpUtils.js";
import { log } from "../logger.js";

export function handleDispatchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  // POST /dispatch
  if (req.method === "POST" && req.url === "/dispatch") {
    collectRequestBody(req)
      .then(async (body) => {
        let parsed: { message?: string; callbackUrl?: string; sessionId?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          jsonResponse(res, 400, { ok: false, error: "Invalid JSON" });
          return;
        }

        const { message, callbackUrl, sessionId } = parsed;
        if (!message || typeof message !== "string") {
          jsonResponse(res, 400, { ok: false, error: "'message' is required" });
          return;
        }

        if (!ctx.taskOrchestrator) {
          jsonResponse(res, 503, { ok: false, error: "Task orchestrator not available" });
          return;
        }

        log(`[Dispatch] Received: "${message.slice(0, 80)}"${callbackUrl ? ` → ${callbackUrl}` : ""}`);

        const result = await ctx.taskOrchestrator.dispatchTask({
          message,
          callbackUrl,
          sessionId,
        });

        jsonResponse(res, result.ok ? 200 : 500, result);
      })
      .catch(() => jsonResponse(res, 413, { ok: false, error: "Request body too large" }));
    return true;
  }

  return false;
}
