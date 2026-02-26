/**
 * ClaudeCodeAdapter — Agent adapter for Claude Code CLI sessions.
 *
 * Manages Claude Code instances via tmux sessions. Events are captured
 * by the vibecraft-hook.sh script and flow through events.jsonl.
 */

import { execFile } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { randomUUID, randomBytes } from "crypto";
import type {
  ClaudeEvent,
  CreateSessionRequest,
  ManagedSession,
  SessionStatus,
} from "../../shared/types.js";
import type { AgentAdapter } from "./AgentAdapter.js";

/** Extended PATH for exec() - includes Homebrew and user paths */
const HOME = process.env.HOME || "";
const EXEC_PATH = [
  `${HOME}/.local/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

const EXEC_OPTIONS = { env: { ...process.env, PATH: EXEC_PATH } };

/** Build env prefix string to inject into tmux session commands */
function buildEnvPrefix(): string {
  const parts = [`PATH=${EXEC_PATH}`];
  if (process.env.ANTHROPIC_BASE_URL) {
    parts.push(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    parts.push(`ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN}`);
  }
  return parts.join(" ");
}

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, EXEC_OPTIONS, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function validateDirectoryPath(inputPath: string): string {
  const cleaned = inputPath.replace(/[;&|`$(){}]/g, "");
  if (cleaned !== inputPath) {
    throw new Error("Invalid characters in directory path");
  }
  return cleaned;
}

export interface ClaudeCodeAdapterOptions {
  /** Callback when a session is created (for server-side tracking) */
  onSessionCreated?: (session: ManagedSession) => void;
  /** Callback for logging */
  log?: (...args: unknown[]) => void;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentType = "claude_code" as const;
  private eventHandlers: Array<(event: ClaudeEvent) => void> = [];
  private sessionCounter = 0;
  private log: (...args: unknown[]) => void;

  constructor(private options: ClaudeCodeAdapterOptions = {}) {
    this.log = options.log || console.log;
  }

  async createSession(config: CreateSessionRequest): Promise<ManagedSession> {
    const id = randomUUID();
    this.sessionCounter++;
    const name = config.name || `Claude ${this.sessionCounter}`;
    const tmuxSession = `vibecraft-${shortId()}`;

    const cwd = validateDirectoryPath(config.cwd || process.cwd());

    // Build claude command with flags
    const flags = config.flags || {};
    const claudeArgs: string[] = [];

    if (flags.continue === true) {
      claudeArgs.push("-c");
    }
    if (flags.skipPermissions !== false) {
      claudeArgs.push("--permission-mode=bypassPermissions");
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (flags.chrome) {
      claudeArgs.push("--chrome");
    }

    const claudeCmd =
      claudeArgs.length > 0 ? `claude ${claudeArgs.join(" ")}` : "claude";

    return new Promise((resolve, reject) => {
      execFile(
        "tmux",
        [
          "new-session",
          "-d",
          "-s",
          tmuxSession,
          "-c",
          cwd,
          `${buildEnvPrefix()} ${claudeCmd}`,
        ],
        EXEC_OPTIONS,
        (error) => {
          if (error) {
            reject(new Error(`Failed to spawn session: ${error.message}`));
            return;
          }

          const mode = config.mode || "auto-edit";
          const session: ManagedSession = {
            id,
            name,
            agentType: "claude_code",
            tmuxSession,
            status: "idle",
            createdAt: Date.now(),
            lastActivity: Date.now(),
            cwd,
            mode,
            description: config.description,
          };

          this.log(
            `Created Claude Code session: ${name} (${id.slice(0, 8)}) -> tmux:${tmuxSession}`,
          );
          resolve(session);
        },
      );
    });
  }

  async destroySession(sessionId: string): Promise<boolean> {
    // The server manages the session map, so we just need the tmuxSession name
    // This will be called with the session ID, but we need tmuxSession
    // The server should pass the full session object instead - for now we return true
    // and the server handles tmux cleanup via its own reference
    return true;
  }

  async destroyTmuxSession(tmuxSession: string): Promise<boolean> {
    try {
      validateTmuxSession(tmuxSession);
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["kill-session", "-t", tmuxSession],
        EXEC_OPTIONS,
        (error) => {
          if (error) {
            this.log(`Warning: Failed to kill tmux session: ${error.message}`);
          }
          resolve(true);
        },
      );
    });
  }

  async restartSession(session: ManagedSession): Promise<boolean> {
    const cwd = validateDirectoryPath(session.cwd || process.cwd());

    // Kill any stale tmux session first
    try {
      await execFileAsync("tmux", ["kill-session", "-t", session.tmuxSession]);
    } catch {
      // Ignore - might not exist
    }

    return new Promise((resolve) => {
      execFile(
        "tmux",
        [
          "new-session",
          "-d",
          "-s",
          session.tmuxSession,
          "-c",
          cwd,
          `${buildEnvPrefix()} claude --permission-mode=bypassPermissions --dangerously-skip-permissions`,
        ],
        EXEC_OPTIONS,
        (error) => {
          if (error) {
            this.log(
              `Failed to restart session "${session.name}": ${error.message}`,
            );
            resolve(false);
            return;
          }

          // Send Enter after delay to dismiss "Welcome back!" dialog
          setTimeout(() => {
            execFile(
              "tmux",
              ["send-keys", "-t", session.tmuxSession, "Enter"],
              EXEC_OPTIONS,
              () => {},
            );
          }, 3000);

          this.log(
            `Restarted Claude Code session: ${session.name} (${session.id.slice(0, 8)})`,
          );
          resolve(true);
        },
      );
    });
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // The server will need to look up tmuxSession from sessionId
    // This method needs the tmuxSession name, not the managed session ID
    // For now, return an error - the server should use sendPromptToTmux directly
    return { ok: false, error: "Use sendPromptToTmux with tmuxSession name" };
  }

  async sendPromptToTmux(
    tmuxSession: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      validateTmuxSession(tmuxSession);
      const isSlashCommand = text.trimStart().startsWith("/");

      if (isSlashCommand) {
        await execFileAsync("tmux", [
          "send-keys",
          "-t",
          tmuxSession,
          "-l",
          text,
        ]);
        await new Promise((r) => setTimeout(r, 100));
        await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
        return { ok: true };
      }

      // Regular prompts: use load-buffer + paste-buffer
      const tempFile = `/tmp/vibecraft-prompt-${Date.now()}-${randomBytes(16).toString("hex")}.txt`;
      writeFileSync(tempFile, text);

      try {
        await execFileAsync("tmux", ["load-buffer", tempFile]);
        await execFileAsync("tmux", ["paste-buffer", "-t", tmuxSession]);
        await new Promise((r) => setTimeout(r, 100));
        await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
      } finally {
        try {
          unlinkSync(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }

      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  }

  async checkHealth(session: ManagedSession): Promise<SessionStatus> {
    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["has-session", "-t", session.tmuxSession],
        EXEC_OPTIONS,
        (error) => {
          if (error) {
            resolve("offline");
          } else {
            resolve(session.status === "offline" ? "idle" : session.status);
          }
        },
      );
    });
  }

  /** Batch health check for all sessions at once (more efficient) */
  async checkAllHealth(
    sessions: ManagedSession[],
  ): Promise<Map<string, SessionStatus>> {
    const results = new Map<string, SessionStatus>();

    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["list-sessions", "-F", "#{session_name}"],
        EXEC_OPTIONS,
        (error, stdout) => {
          const activeSessions = error
            ? new Set<string>()
            : new Set(stdout.trim().split("\n"));

          for (const session of sessions) {
            if (session.agentType !== "claude_code") continue;
            const isAlive = activeSessions.has(session.tmuxSession);
            results.set(
              session.id,
              isAlive
                ? session.status === "offline"
                  ? "idle"
                  : session.status
                : "offline",
            );
          }

          resolve(results);
        },
      );
    });
  }

  getCapabilities(): string[] {
    return [
      "tool_use",
      "file_read",
      "file_write",
      "file_edit",
      "bash",
      "search",
      "web",
      "subagents",
      "mcp",
    ];
  }

  onEvent(handler: (event: ClaudeEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Emit an event to all registered handlers */
  emitEvent(event: ClaudeEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  async dispose(): Promise<void> {
    this.eventHandlers = [];
  }
}
