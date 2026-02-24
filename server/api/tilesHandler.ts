/**
 * Tiles Handler
 *
 * Handles /tiles/* endpoints for text tile management.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import type {
  TextTile,
  CreateTextTileRequest,
  UpdateTextTileRequest,
} from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse, errorResponse } from "./httpUtils.js";

export function handleTileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { tilesManager } = ctx;

  // GET /tiles
  if (req.method === "GET" && req.url === "/tiles") {
    jsonResponse(res, 200, { ok: true, tiles: tilesManager.getAll() });
    return true;
  }

  // POST /tiles - Create a new tile
  if (req.method === "POST" && req.url === "/tiles") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as CreateTextTileRequest;

          if (!data.text || !data.position) {
            errorResponse(res, 400, "Missing text or position");
            return;
          }

          const tile: TextTile = {
            id: randomUUID(),
            text: data.text,
            position: data.position,
            color: data.color,
            createdAt: Date.now(),
          };

          tilesManager.create(tile);
          jsonResponse(res, 201, { ok: true, tile });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // Handle /tiles/:id routes
  const tilesIdMatch = req.url?.match(/^\/tiles\/([^/?]+)/);
  if (!tilesIdMatch) return false;

  const tileId = tilesIdMatch[1];

  // PUT /tiles/:id
  if (req.method === "PUT") {
    const tile = tilesManager.get(tileId);
    if (!tile) {
      errorResponse(res, 404, "Tile not found");
      return true;
    }

    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as UpdateTextTileRequest;
          const updated = tilesManager.update(tileId, data);
          if (updated) {
            jsonResponse(res, 200, { ok: true, tile: updated });
          } else {
            errorResponse(res, 404, "Tile not found");
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

  // DELETE /tiles/:id
  if (req.method === "DELETE") {
    const deleted = tilesManager.delete(tileId);
    if (deleted) {
      jsonResponse(res, 200, { ok: true });
    } else {
      errorResponse(res, 404, "Tile not found");
    }
    return true;
  }

  return false;
}
