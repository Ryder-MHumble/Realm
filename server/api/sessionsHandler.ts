/**
 * Sessions Handler
 *
 * Handles all /sessions/* endpoints: CRUD, prompt, cancel, mode, permission,
 * restart, and link operations.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { execFile } from "child_process";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
  SessionPromptRequest,
} from "../../shared/types.js";
import type { ServerContext } from "./router.js";
import { collectRequestBody, jsonResponse, errorResponse } from "./httpUtils.js";
import { log } from "../logger.js";
import { validateTmuxSession, getExecOptions } from "../tmuxUtils.js";

export function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const { sessionManager, permissionManager } = ctx;

  // GET /sessions - List all sessions
  if (req.method === "GET" && req.url === "/sessions") {
    jsonResponse(res, 200, { ok: true, sessions: sessionManager.getSessions() });
    return true;
  }

  // POST /sessions/refresh - Force health check
  if (req.method === "POST" && req.url === "/sessions/refresh") {
    log("Manual session refresh requested");
    sessionManager.checkSessionHealth();
    jsonResponse(res, 200, { ok: true, sessions: sessionManager.getSessions() });
    return true;
  }

  // POST /sessions - Create a new session
  if (req.method === "POST" && req.url === "/sessions") {
    collectRequestBody(req)
      .then(async (body) => {
        try {
          const options = body
            ? (JSON.parse(body) as CreateSessionRequest)
            : {};
          const session = await sessionManager.createSession(options);
          jsonResponse(res, 201, { ok: true, session });
        } catch (e) {
          jsonResponse(res, 500, { ok: false, error: (e as Error).message });
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // Session-specific endpoints: /sessions/:id[/action]
  const sessionMatch = req.url?.match(/^\/sessions\/([a-f0-9-]+)(?:\/(.+))?$/);
  if (!sessionMatch) return false;

  const sessionId = sessionMatch[1];
  const action = sessionMatch[2];

  // GET /sessions/:id
  if (req.method === "GET" && !action) {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      jsonResponse(res, 200, { ok: true, session });
    } else {
      errorResponse(res, 404, "Session not found");
    }
    return true;
  }

  // PATCH /sessions/:id - Update session
  if (req.method === "PATCH" && !action) {
    collectRequestBody(req)
      .then((body) => {
        try {
          const updates = JSON.parse(body) as UpdateSessionRequest;
          const session = sessionManager.updateSession(sessionId, updates);
          if (session) {
            jsonResponse(res, 200, { ok: true, session });
          } else {
            errorResponse(res, 404, "Session not found");
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

  // DELETE /sessions/:id - Kill session
  if (req.method === "DELETE" && !action) {
    sessionManager.deleteSession(sessionId).then((deleted) => {
      if (deleted) {
        jsonResponse(res, 200, { ok: true });
      } else {
        errorResponse(res, 404, "Session not found");
      }
    });
    return true;
  }

  // POST /sessions/:id/prompt
  if (req.method === "POST" && action === "prompt") {
    collectRequestBody(req)
      .then(async (body) => {
        try {
          const { prompt } = JSON.parse(body) as SessionPromptRequest;
          if (!prompt) {
            errorResponse(res, 400, "Prompt is required");
            return;
          }
          const result = await sessionManager.sendPromptToSession(
            sessionId,
            prompt,
          );
          jsonResponse(res, result.ok ? 200 : 404, result);
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // POST /sessions/:id/cancel
  if (req.method === "POST" && action === "cancel") {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, "Session not found");
      return true;
    }

    try {
      validateTmuxSession(session.tmuxSession);
    } catch {
      errorResponse(res, 400, "Invalid tmux session name");
      return true;
    }

    execFile(
      "tmux",
      ["send-keys", "-t", session.tmuxSession, "Escape"],
      getExecOptions(),
      () => {
        setTimeout(() => {
          execFile(
            "tmux",
            ["send-keys", "-t", session.tmuxSession, "C-c"],
            getExecOptions(),
            (error) => {
              if (error) {
                jsonResponse(res, 200, { ok: false, error: error.message });
              } else {
                log(`Sent Escape+Ctrl+C to ${session.name}`);
                jsonResponse(res, 200, { ok: true });
              }
            },
          );
        }, 100);
      },
    );
    return true;
  }

  // POST /sessions/:id/mode
  if (req.method === "POST" && action === "mode") {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, "Session not found");
      return true;
    }

    collectRequestBody(req)
      .then(async (body) => {
        try {
          const { mode } = JSON.parse(body) as { mode: string };
          const result = await sessionManager.switchMode(sessionId, mode);

          if (!result.ok && result.error === "restart_required") {
            jsonResponse(res, 400, {
              ok: false,
              error: "restart_required",
              message: `Switching mode requires a session restart`,
            });
            return;
          }

          if (!result.ok) {
            jsonResponse(res, result.error === "Invalid mode" ? 400 : 500, {
              ok: false,
              error: result.error,
            });
            return;
          }

          jsonResponse(res, 200, { ok: true, session: result.session });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // POST /sessions/:id/permission
  if (req.method === "POST" && action === "permission") {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, "Session not found");
      return true;
    }

    collectRequestBody(req)
      .then((body) => {
        try {
          const { response } = JSON.parse(body) as { response: string };
          if (!response) {
            errorResponse(res, 400, "Missing response field");
            return;
          }
          permissionManager.sendPermissionResponse(sessionId, response);
          jsonResponse(res, 200, { ok: true });
        } catch {
          errorResponse(res, 400, "Invalid JSON");
        }
      })
      .catch(() => {
        jsonResponse(res, 413, { error: "Request body too large" });
      });
    return true;
  }

  // POST /sessions/:id/restart
  if (req.method === "POST" && action === "restart") {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, "Session not found");
      return true;
    }

    sessionManager.restartSessionWithContinue(session).then((ok) => {
      if (ok) {
        jsonResponse(res, 200, { ok: true, session });
      } else {
        jsonResponse(res, 500, {
          ok: false,
          error: "Failed to restart session",
        });
      }
    });
    return true;
  }

  // POST /sessions/:id/link
  if (req.method === "POST" && action === "link") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const { claudeSessionId } = JSON.parse(body) as {
            claudeSessionId: string;
          };
          if (!claudeSessionId) {
            errorResponse(res, 400, "claudeSessionId is required");
            return;
          }
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            errorResponse(res, 404, "Session not found");
            return;
          }
          sessionManager.linkClaudeSession(claudeSessionId, sessionId);
          session.claudeSessionId = claudeSessionId;
          log(
            `Linked Claude session ${claudeSessionId.slice(0, 8)} to ${session.name}`,
          );
          sessionManager.broadcastSessions();
          sessionManager.saveSessions();
          jsonResponse(res, 200, { ok: true, session });
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
