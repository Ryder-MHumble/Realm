/**
 * Settings Handler
 *
 * Handles /settings/* endpoints for agent provider settings.
 * LLM providers and notification channels are managed here.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { UpdateSettingsRequest } from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse, errorResponse } from "./httpUtils.js";

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

  // DELETE /settings/notification/:name — remove a channel
  const channelDeleteMatch = req.url?.match(
    /^\/settings\/notification\/([^/?]+)/,
  );
  if (req.method === "DELETE" && channelDeleteMatch) {
    const name = decodeURIComponent(channelDeleteMatch[1]);
    const deleted = settingsManager.deleteNotificationChannel(name);
    if (deleted) {
      jsonResponse(res, 200, {
        ok: true,
        settings: settingsManager.getRedactedSettings(),
      });
    } else {
      errorResponse(res, 404, `Notification channel "${name}" not found`);
    }
    return true;
  }

  // POST /settings/test-notification/:name — send test message
  const testMatch = req.url?.match(/^\/settings\/test-notification\/([^/?]+)/);
  if (req.method === "POST" && testMatch) {
    const name = decodeURIComponent(testMatch[1]);
    const channel = settingsManager.getNotificationChannel(name);
    if (!channel) {
      errorResponse(res, 404, `Notification channel "${name}" not found`);
      return true;
    }

    // NotificationManager handles actual test — delegate via context
    if (ctx.notificationManager) {
      ctx.notificationManager
        .testChannel(name)
        .then((success) => {
          if (success) {
            jsonResponse(res, 200, { ok: true, message: "Test sent" });
          } else {
            errorResponse(res, 500, "Test failed — channel not active");
          }
        })
        .catch((err) => {
          errorResponse(res, 500, `Test failed: ${err}`);
        });
    } else {
      errorResponse(res, 503, "Notification system not initialized");
    }
    return true;
  }

  return false;
}
