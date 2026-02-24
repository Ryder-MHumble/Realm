/**
 * Permission Manager
 *
 * Detects permission prompts in tmux sessions and manages permission responses.
 * Also auto-accepts the bypass permissions warning on first use.
 */

import { execFile } from "child_process";
import type { ManagedSession, ServerMessage } from "../../shared/types.js";
import { log, debug } from "../logger.js";
import { validateTmuxSession, getExecOptions } from "../tmuxUtils.js";

interface PermissionOption {
  number: string;
  label: string;
}

interface PermissionPrompt {
  tool: string;
  context: string;
  options: PermissionOption[];
  detectedAt: number;
}

export class PermissionManager {
  private pendingPermissions = new Map<string, PermissionPrompt>();
  private bypassWarningHandled = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private sessionProvider: (() => ManagedSession[]) | null = null;
  private statusChangeHandler:
    | ((sessionId: string, status: string, tool?: string) => void)
    | null = null;

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  setSessionProvider(provider: () => ManagedSession[]): void {
    this.sessionProvider = provider;
  }

  setStatusChangeHandler(
    handler: (sessionId: string, status: string, tool?: string) => void,
  ): void {
    this.statusChangeHandler = handler;
  }

  /** Start polling for permission prompts (every 1 second) */
  start(): void {
    this.intervalId = setInterval(() => {
      const sessions = this.sessionProvider?.() ?? [];
      for (const session of sessions) {
        if (session.status !== "offline") {
          this.pollPermissions(session.id, session.tmuxSession);
        }
      }
    }, 1000);
    log("Permission polling started");
  }

  /** Stop polling */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Send a permission response to a session */
  sendPermissionResponse(sessionId: string, optionNumber: string): boolean {
    // Validate it's a number
    if (!/^\d+$/.test(optionNumber)) {
      log(`Invalid permission response: ${optionNumber} (expected number)`);
      return false;
    }

    // Need to find the tmux session for this managed session
    const sessions = this.sessionProvider?.() ?? [];
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      log(`Cannot send permission response: session ${sessionId} not found`);
      return false;
    }

    try {
      validateTmuxSession(session.tmuxSession);
    } catch {
      log(`Invalid tmux session name: ${session.tmuxSession}`);
      return false;
    }

    execFile(
      "tmux",
      ["send-keys", "-t", session.tmuxSession, optionNumber],
      getExecOptions(),
      (error) => {
        if (error) {
          log(`Failed to send permission response: ${error.message}`);
          return;
        }

        log(
          `Sent permission response to ${session.name}: option ${optionNumber}`,
        );

        this.pendingPermissions.delete(sessionId);
        this.statusChangeHandler?.(sessionId, "working", undefined);
      },
    );

    return true;
  }

  /** Poll a session for permission prompts */
  private pollPermissions(sessionId: string, tmuxSession: string): void {
    try {
      validateTmuxSession(tmuxSession);
    } catch {
      debug(`Invalid tmux session for permission polling: ${tmuxSession}`);
      return;
    }

    execFile(
      "tmux",
      ["capture-pane", "-t", tmuxSession, "-p", "-S", "-50"],
      { ...getExecOptions(), maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          debug(
            `Permission poll failed for ${tmuxSession}: ${error.message}`,
          );
          return;
        }

        // Check for bypass permissions warning
        if (
          detectBypassWarning(stdout) &&
          !this.bypassWarningHandled.has(sessionId)
        ) {
          log(
            `Bypass permissions warning detected for session ${sessionId}, auto-accepting...`,
          );
          this.bypassWarningHandled.add(sessionId);
          execFile(
            "tmux",
            ["send-keys", "-t", tmuxSession, "2"],
            getExecOptions(),
            (err) => {
              if (err) {
                log(`Failed to auto-accept bypass warning: ${err.message}`);
              } else {
                log(
                  `Bypass permissions warning accepted for session ${sessionId}`,
                );
              }
            },
          );
          return;
        }

        const prompt = detectPermissionPrompt(stdout);
        const existing = this.pendingPermissions.get(sessionId);

        if (prompt && !existing) {
          this.pendingPermissions.set(sessionId, {
            tool: prompt.tool,
            context: prompt.context,
            options: prompt.options,
            detectedAt: Date.now(),
          });

          log(
            `Permission prompt detected for session ${sessionId}: ${prompt.tool} (${prompt.options.length} options)`,
          );

          this.broadcastFn?.({
            type: "permission_prompt",
            payload: {
              sessionId,
              tool: prompt.tool,
              context: prompt.context,
              options: prompt.options,
            },
          } as ServerMessage);

          this.statusChangeHandler?.(sessionId, "waiting", prompt.tool);
        } else if (!prompt && existing) {
          this.pendingPermissions.delete(sessionId);
          log(`Permission prompt resolved for session ${sessionId}`);

          this.broadcastFn?.({
            type: "permission_resolved",
            payload: { sessionId },
          } as ServerMessage);

          this.statusChangeHandler?.(sessionId, "working", undefined);
        }
      },
    );
  }
}

/**
 * Parse tmux output to detect Claude Code permission prompts.
 */
function detectPermissionPrompt(
  output: string,
): { tool: string; context: string; options: PermissionOption[] } | null {
  const lines = output.split("\n");

  let proceedLineIdx = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (/(Do you want|Would you like) to proceed\?/i.test(lines[i])) {
      proceedLineIdx = i;
      break;
    }
  }

  if (proceedLineIdx === -1) return null;

  // Verify this is a real Claude Code prompt
  let hasFooter = false;
  let hasSelector = false;
  for (
    let i = proceedLineIdx + 1;
    i < Math.min(lines.length, proceedLineIdx + 15);
    i++
  ) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
      hasFooter = true;
      break;
    }
    if (/^\s*❯/.test(lines[i])) {
      hasSelector = true;
    }
  }

  if (!hasFooter && !hasSelector) {
    debug(
      'Skipping false positive: no "Esc to cancel"/"ctrl-g" footer or ❯ selector found',
    );
    return null;
  }

  // Parse numbered options
  const options: PermissionOption[] = [];
  for (
    let i = proceedLineIdx + 1;
    i < Math.min(lines.length, proceedLineIdx + 10);
    i++
  ) {
    const line = lines[i];
    if (/Esc to cancel/i.test(line)) break;

    const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/);
    if (optionMatch) {
      options.push({
        number: optionMatch[1],
        label: optionMatch[2].trim(),
      });
    }
  }

  if (options.length < 2) return null;

  // Find the tool name
  let tool = "Unknown";
  for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
    const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/);
    if (toolMatch) {
      tool = toolMatch[1];
      break;
    }
    const cmdMatch = lines[i].match(
      /^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i,
    );
    if (cmdMatch) {
      tool = cmdMatch[1];
      break;
    }
  }

  // Build context
  const contextStart = Math.max(0, proceedLineIdx - 10);
  const contextEnd = proceedLineIdx + 1 + options.length;
  const context = lines.slice(contextStart, contextEnd).join("\n").trim();

  debug(
    `Detected permission prompt: tool=${tool}, options=${options.map((o) => o.number + ":" + o.label).join(", ")}`,
  );

  return { tool, context, options };
}

/**
 * Detect the bypass permissions warning that appears on first use.
 */
function detectBypassWarning(output: string): boolean {
  return (
    output.includes("WARNING") && output.includes("Bypass Permissions mode")
  );
}
