/**
 * Settings Handler
 *
 * Handles /settings/* endpoints for agent provider settings.
 * LLM providers are managed here.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { UpdateSettingsRequest } from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import {
  collectRequestBody,
  jsonResponse,
  errorResponse,
} from "./httpUtils.js";

export function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { settingsManager } = ctx;

  // GET /settings — return redacted settings
  if (req.method === "GET" && req.url === "/settings") {
    jsonResponse(res, 200, {
      ok: true,
      settings: settingsManager.getRedactedSettings(),
    });
    return true;
  }

  // PUT /settings — full replace
  if (req.method === "PUT" && req.url === "/settings") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as UpdateSettingsRequest;
          settingsManager.replaceSettings(data);
          jsonResponse(res, 200, {
            ok: true,
            settings: settingsManager.getRedactedSettings(),
          });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // PATCH /settings — partial merge
  if (req.method === "PATCH" && req.url === "/settings") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as UpdateSettingsRequest;
          settingsManager.updateSettings(data);
          jsonResponse(res, 200, {
            ok: true,
            settings: settingsManager.getRedactedSettings(),
          });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // DELETE /settings/llm/:name — remove a provider
  const llmDeleteMatch = req.url?.match(/^\/settings\/llm\/([^/?]+)/);
  if (req.method === "DELETE" && llmDeleteMatch) {
    const name = decodeURIComponent(llmDeleteMatch[1]);
    const deleted = settingsManager.deleteLLMProvider(name);
    if (deleted) {
      jsonResponse(res, 200, {
        ok: true,
        settings: settingsManager.getRedactedSettings(),
      });
    } else {
      errorResponse(res, 404, `LLM provider "${name}" not found`);
    }
    return true;
  }

  // GET /settings/auto-compact — return auto-compact config
  if (req.method === "GET" && req.url === "/settings/auto-compact") {
    const config = ctx.autoCompactManager?.getConfig();
    jsonResponse(res, 200, { ok: true, config: config || null });
    return true;
  }

  // PATCH /settings/auto-compact — update auto-compact config
  if (req.method === "PATCH" && req.url === "/settings/auto-compact") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body);
          ctx.autoCompactManager?.updateConfig(data);
          settingsManager.updateSettings({ autoCompact: data });
          jsonResponse(res, 200, {
            ok: true,
            config: ctx.autoCompactManager?.getConfig(),
          });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // GET /settings/auto-continue — return auto-continue config
  if (req.method === "GET" && req.url === "/settings/auto-continue") {
    const config = ctx.autoContinueManager?.getConfig();
    jsonResponse(res, 200, { ok: true, config: config || null });
    return true;
  }

  // PATCH /settings/auto-continue — update auto-continue config
  if (req.method === "PATCH" && req.url === "/settings/auto-continue") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body);
          ctx.autoContinueManager?.updateConfig(data);
          settingsManager.updateSettings({ autoContinue: data });
          jsonResponse(res, 200, {
            ok: true,
            config: ctx.autoContinueManager?.getConfig(),
          });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  return false;
}
