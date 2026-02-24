/**
 * Upload Handler
 *
 * Handles POST /upload for file attachments.
 * Parses multipart/form-data, validates files, saves to disk.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, extname } from "path";
import { randomBytes } from "crypto";
import type { UploadedFileInfo } from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBodyRaw } from "./httpUtils.js";
import { jsonResponse, errorResponse } from "./httpUtils.js";
import { log } from "../logger.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

const ALLOWED_MIME_PREFIXES = ["image/"];
const ALLOWED_MIME_EXACT = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/octet-stream",
]);

function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIME_EXACT.has(mime)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * Parse multipart/form-data body into file parts.
 */
function parseMultipart(body: Buffer, boundary: string): MultipartFile[] {
  const files: MultipartFile[] = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  // Split body by boundary
  let start = 0;
  const parts: Buffer[] = [];

  while (start < body.length) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;

    if (parts.length > 0) {
      // Previous part ends here (minus CRLF before boundary)
      const partEnd = idx >= 2 ? idx - 2 : idx;
      // Don't include the first "part" which is empty before the first boundary
    }

    start = idx + boundaryBuf.length;

    // Check if this is the end boundary
    if (body.slice(idx, idx + endBuf.length).equals(endBuf)) break;

    // Skip CRLF after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) {
      start += 2;
    }

    // Find end of headers (double CRLF)
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) continue;

    const headerStr = body.slice(start, headerEnd).toString("utf-8");

    // Parse headers
    let filename = "";
    let contentType = "application/octet-stream";

    for (const line of headerStr.split("\r\n")) {
      const lower = line.toLowerCase();
      if (lower.startsWith("content-disposition:")) {
        const fnMatch = line.match(/filename="([^"]+)"/);
        if (fnMatch) filename = fnMatch[1];
      } else if (lower.startsWith("content-type:")) {
        contentType = line.split(":")[1].trim();
      }
    }

    if (!filename) {
      // Not a file part, skip
      continue;
    }

    // Data starts after headers + double CRLF
    const dataStart = headerEnd + 4;

    // Find next boundary to determine data end
    const nextBoundary = body.indexOf(boundaryBuf, dataStart);
    if (nextBoundary === -1) continue;

    // Data ends before CRLF + boundary
    let dataEnd = nextBoundary;
    if (nextBoundary >= 2 && body[nextBoundary - 2] === 0x0d && body[nextBoundary - 1] === 0x0a) {
      dataEnd = nextBoundary - 2;
    }

    files.push({
      filename,
      contentType,
      data: body.slice(dataStart, dataEnd),
    });

    // Rewind start so outer loop catches this boundary again
    start = nextBoundary - boundaryBuf.length;
  }

  return files;
}

export function handleUploadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  // POST /upload
  if (req.method === "POST" && req.url === "/upload") {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);

    if (!boundaryMatch) {
      errorResponse(res, 400, "Missing multipart boundary");
      return true;
    }

    const boundary = boundaryMatch[1].trim();

    collectRequestBodyRaw(req, MAX_FILE_SIZE * 10)
      .then((body) => {
        try {
          const parsedFiles = parseMultipart(body, boundary);

          if (parsedFiles.length === 0) {
            errorResponse(res, 400, "No files found in request");
            return;
          }

          // Ensure uploads directory exists
          mkdirSync(ctx.config.uploadsDir, { recursive: true });

          const uploaded: UploadedFileInfo[] = [];

          for (const file of parsedFiles) {
            // Validate size
            if (file.data.length > MAX_FILE_SIZE) {
              errorResponse(
                res,
                413,
                `File "${file.filename}" exceeds 10MB limit`,
              );
              return;
            }

            // Validate MIME type
            if (!isAllowedMime(file.contentType)) {
              errorResponse(
                res,
                415,
                `Unsupported file type: ${file.contentType}`,
              );
              return;
            }

            // Sanitize filename: keep only safe chars
            const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
            const ext = extname(safeName) || guessExtension(file.contentType);
            const baseName = safeName.replace(/\.[^.]+$/, "") || "file";
            const timestamp = Date.now();
            const random = randomBytes(4).toString("hex");
            const savedName = `${timestamp}-${random}-${baseName}${ext}`;
            const savedPath = resolve(ctx.config.uploadsDir, savedName);

            writeFileSync(savedPath, file.data);

            uploaded.push({
              originalName: file.filename,
              savedPath,
              mimeType: file.contentType,
              size: file.data.length,
            });

            log(
              `File uploaded: ${file.filename} (${(file.data.length / 1024).toFixed(1)}KB) -> ${savedPath}`,
            );
          }

          jsonResponse(res, 200, { ok: true, files: uploaded });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Upload error: ${msg}`);
          errorResponse(res, 500, "Upload processing failed");
        }
      })
      .catch(() => {
        errorResponse(res, 413, "Request body too large");
      });

    return true;
  }

  return false;
}

function guessExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/pdf": ".pdf",
  };
  return map[mimeType] || "";
}
