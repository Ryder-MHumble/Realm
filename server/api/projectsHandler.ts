/**
 * Projects Handler
 *
 * Handles /projects/* endpoints for known project directories.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ServerContext } from "./router.js";
import { jsonResponse } from "./httpUtils.js";

export function handleProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { projectsManager, config } = ctx;

  // GET /projects - List all known projects
  if (req.method === "GET" && req.url === "/projects") {
    jsonResponse(res, 200, {
      ok: true,
      projects: projectsManager.getProjects(),
    });
    return true;
  }

  // GET /projects/autocomplete?q=...
  if (req.method === "GET" && req.url?.startsWith("/projects/autocomplete")) {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const query = url.searchParams.get("q") || "";
    const results = projectsManager.autocomplete(query);
    jsonResponse(res, 200, { ok: true, results });
    return true;
  }

  // DELETE /projects/:path
  if (req.method === "DELETE" && req.url?.startsWith("/projects/")) {
    const path = decodeURIComponent(req.url.slice("/projects/".length));
    projectsManager.removeProject(path);
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  return false;
}
