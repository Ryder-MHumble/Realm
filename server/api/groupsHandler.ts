/**
 * Groups Handler
 *
 * Handles /groups/* endpoints for zone group management.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type {
  CreateZoneGroupRequest,
  UpdateZoneGroupRequest,
} from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse, errorResponse } from "./httpUtils.js";

export function handleGroupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { groupsManager } = ctx;

  // GET /groups
  if (req.method === "GET" && req.url === "/groups") {
    jsonResponse(res, 200, { ok: true, groups: groupsManager.getAll() });
    return true;
  }

  // POST /groups - Create a new group
  if (req.method === "POST" && req.url === "/groups") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as CreateZoneGroupRequest;
          const result = groupsManager.create(data);
          if (result.ok) {
            jsonResponse(res, 201, { ok: true, group: result.group });
          } else {
            errorResponse(res, 400, result.error);
          }
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // Handle /groups/:id routes
  const groupsIdMatch = req.url?.match(/^\/groups\/([^/?]+)/);
  if (!groupsIdMatch) return false;

  const groupId = groupsIdMatch[1];

  // DELETE /groups/:id
  if (req.method === "DELETE") {
    const deleted = groupsManager.delete(groupId);
    if (deleted) {
      jsonResponse(res, 200, { ok: true });
    } else {
      errorResponse(res, 404, "Group not found");
    }
    return true;
  }

  // PATCH /groups/:id
  if (req.method === "PATCH") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as UpdateZoneGroupRequest;
          const result = groupsManager.update(groupId, data);
          if (result.ok) {
            if ("dissolved" in result && result.dissolved) {
              jsonResponse(res, 200, { ok: true, dissolved: true });
            } else {
              jsonResponse(res, 200, { ok: true, group: result.group });
            }
          } else {
            const status = result.error === "Group not found" ? 404 : 400;
            errorResponse(res, status, result.error);
          }
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
