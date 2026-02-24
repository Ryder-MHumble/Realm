/**
 * Agents Handler
 *
 * Handles /agents endpoint for multi-claw framework support.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { AgentType } from "../../shared/types.js";
import { AGENT_TYPES } from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { jsonResponse } from "./httpUtils.js";

export function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  // GET /agents - List all registered agent types
  if (req.method === "GET" && req.url === "/agents") {
    const agents = ctx.agentRegistry.getRegisteredTypes().map((type) => ({
      type,
      ...((AGENT_TYPES as Record<string, unknown>)[type as string] as Record<
        string,
        unknown
      >),
      capabilities: ctx.agentRegistry.getCapabilities(type),
    }));
    jsonResponse(res, 200, { ok: true, agents });
    return true;
  }

  return false;
}
