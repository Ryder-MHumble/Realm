/**
 * HTTP Utilities
 *
 * Shared helpers for HTTP request handling: body collection,
 * JSON response helpers, and error responses.
 */

import type { IncomingMessage, ServerResponse } from "http";

/** Default max body size (1MB) */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

/**
 * Safely collect request body with size limit to prevent DoS.
 */
export function collectRequestBody(
  req: IncomingMessage,
  maxSize: number = DEFAULT_MAX_BODY_SIZE,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Collect request body as raw Buffer (for binary/multipart uploads).
 */
export function collectRequestBodyRaw(
  req: IncomingMessage,
  maxSize: number = 10 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 */
export function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Send a JSON error response.
 */
export function errorResponse(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  jsonResponse(res, status, { ok: false, error: message });
}
