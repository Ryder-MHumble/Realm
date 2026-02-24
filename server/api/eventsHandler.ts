/**
 * Events Handler
 *
 * Handles /event, /health, /stats, /config, /info endpoints.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { hostname } from "os";
import type { PostToolUseEvent } from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse } from "./httpUtils.js";
import { debug } from "../logger.js";
import type { ClaudeEvent } from "../../shared/types.js";

export function handleEventRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  // POST /event - Receive event from hook
  if (req.method === "POST" && req.url === "/event") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const event = JSON.parse(body) as ClaudeEvent;
          ctx.eventProcessor.addEvent(event);
          debug(`Received event via HTTP: ${event.type}`);
          jsonResponse(res, 200, { ok: true });
        } catch {
          debug(`Failed to parse HTTP event`);
          jsonResponse(res, 400, { error: "Invalid JSON" });
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    jsonResponse(res, 200, {
      ok: true,
      version: ctx.config.version,
      clients: ctx.wsManager.getClientCount(),
      events: ctx.eventProcessor.getEvents().length,
      voiceEnabled: false,
    });
    return true;
  }

  // GET /config
  if (req.method === "GET" && req.url === "/config") {
    const username =
      process.env.USER || process.env.USERNAME || "claude-user";
    const host = hostname();
    jsonResponse(res, 200, {
      username,
      hostname: host,
      tmuxSession: ctx.config.tmuxSession,
    });
    return true;
  }

  // GET /stats
  if (req.method === "GET" && req.url === "/stats") {
    const events = ctx.eventProcessor.getEvents();
    const toolCounts: Record<string, number> = {};
    const toolDurations: Record<string, number[]> = {};

    for (const event of events) {
      if (event.type === "post_tool_use") {
        const e = event as PostToolUseEvent;
        toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
        if (e.duration !== undefined) {
          toolDurations[e.tool] = toolDurations[e.tool] ?? [];
          toolDurations[e.tool].push(e.duration);
        }
      }
    }

    const avgDurations: Record<string, number> = {};
    for (const [tool, durations] of Object.entries(toolDurations)) {
      avgDurations[tool] = Math.round(
        durations.reduce((a, b) => a + b, 0) / durations.length,
      );
    }

    const tokens = ctx.tokenTracker.getAllTokenData();

    jsonResponse(res, 200, {
      totalEvents: events.length,
      toolCounts,
      avgDurations,
      tokens,
    });
    return true;
  }

  // GET /info
  if (req.method === "GET" && req.url === "/info") {
    jsonResponse(res, 200, { ok: true, cwd: process.cwd() });
    return true;
  }

  return false;
}
