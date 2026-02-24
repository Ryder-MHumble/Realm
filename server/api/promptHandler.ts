/**
 * Prompt Handler
 *
 * Handles /prompt, /tmux-output, /cancel endpoints.
 * These are legacy single-session endpoints for backwards compatibility.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { execFile } from "child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse } from "./httpUtils.js";
import { log, debug } from "../logger.js";
import {
  validateTmuxSession,
  sendToTmuxSafe,
  getExecOptions,
} from "../tmuxUtils.js";

export function handlePromptRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { config } = ctx;

  // POST /prompt - Submit prompt from browser
  if (req.method === "POST" && req.url === "/prompt") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const { prompt, send } = JSON.parse(body) as {
            prompt: string;
            send?: boolean;
          };
          if (!prompt || typeof prompt !== "string") {
            jsonResponse(res, 400, { error: "Prompt is required" });
            return;
          }

          // Write prompt to file
          const dir = dirname(config.pendingPromptFile);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(config.pendingPromptFile, prompt, "utf-8");
          log(`Prompt saved: ${prompt.slice(0, 50)}...`);

          if (send) {
            sendToTmuxSafe(config.tmuxSession, prompt)
              .then(() => {
                log(`Prompt sent to tmux session: ${config.tmuxSession}`);
                jsonResponse(res, 200, {
                  ok: true,
                  saved: config.pendingPromptFile,
                  sent: true,
                });
              })
              .catch((error) => {
                log(`tmux send failed: ${error.message}`);
                jsonResponse(res, 200, {
                  ok: true,
                  saved: config.pendingPromptFile,
                  sent: false,
                  tmuxError: error.message,
                });
              });
            return;
          }

          jsonResponse(res, 200, {
            ok: true,
            saved: config.pendingPromptFile,
          });
        } catch {
          debug("Failed to save prompt");
          jsonResponse(res, 400, { error: "Invalid JSON" });
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // GET /prompt - Get pending prompt
  if (req.method === "GET" && req.url === "/prompt") {
    if (existsSync(config.pendingPromptFile)) {
      const prompt = readFileSync(config.pendingPromptFile, "utf-8");
      jsonResponse(res, 200, { prompt, file: config.pendingPromptFile });
    } else {
      jsonResponse(res, 200, { prompt: null });
    }
    return true;
  }

  // DELETE /prompt - Clear pending prompt
  if (req.method === "DELETE" && req.url === "/prompt") {
    if (existsSync(config.pendingPromptFile)) {
      unlinkSync(config.pendingPromptFile);
      log("Pending prompt cleared");
    }
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  // GET /tmux-output
  if (req.method === "GET" && req.url === "/tmux-output") {
    try {
      validateTmuxSession(config.tmuxSession);
    } catch {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid tmux session name",
        output: "",
      });
      return true;
    }

    execFile(
      "tmux",
      ["capture-pane", "-t", config.tmuxSession, "-p", "-S", "-100"],
      { ...getExecOptions(), maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          jsonResponse(res, 200, {
            ok: false,
            error: error.message,
            output: "",
          });
          return;
        }
        jsonResponse(res, 200, { ok: true, output: stdout });
      },
    );
    return true;
  }

  // POST /cancel - Send Ctrl+C to tmux (legacy)
  if (req.method === "POST" && req.url === "/cancel") {
    try {
      validateTmuxSession(config.tmuxSession);
    } catch {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid tmux session name",
      });
      return true;
    }

    execFile(
      "tmux",
      ["send-keys", "-t", config.tmuxSession, "Escape"],
      getExecOptions(),
      () => {
        setTimeout(() => {
          execFile(
            "tmux",
            ["send-keys", "-t", config.tmuxSession, "C-c"],
            getExecOptions(),
            (error) => {
              if (error) {
                log(`Cancel failed: ${error.message}`);
                jsonResponse(res, 200, { ok: false, error: error.message });
              } else {
                log(
                  `Sent Escape+Ctrl+C to tmux session: ${config.tmuxSession}`,
                );
                jsonResponse(res, 200, { ok: true });
              }
            },
          );
        }, 100);
      },
    );
    return true;
  }

  return false;
}
