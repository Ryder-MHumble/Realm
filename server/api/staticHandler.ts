/**
 * Static File Handler
 *
 * Serves static files from dist/ directory for production mode.
 * Handles SPA routing by falling back to index.html.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join, extname } from "path";

/** MIME types for static files */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve static files from dist/ directory */
export function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const distDir = resolve(
    dirname(new URL(import.meta.url).pathname),
    "../../..",
  );

  let urlPath = req.url?.split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  // Security: prevent directory traversal
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const filePath = resolve(distDir, "." + decodedPath);

  if (!filePath.startsWith(distDir + "/") && filePath !== distDir) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // SPA fallback
    const indexPath = join(distDir, "index.html");
    if (existsSync(indexPath) && !decodedPath.startsWith("/api")) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}
