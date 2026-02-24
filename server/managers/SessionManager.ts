/**
 * Session Manager
 *
 * Manages the lifecycle of agent sessions: CRUD, health checks,
 * Claude session linking, auto-restart, and multi-agent delegation.
 */

import { exec, execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import type {
  ClaudeEvent,
  PreToolUseEvent,
  ManagedSession,
  CreateSessionRequest,
  UpdateSessionRequest,
  GitStatus,
  ServerMessage,
  ClaudeMode,
} from "../../shared/types.js";
import { log, debug } from "../logger.js";
import {
  validateDirectoryPath,
  validateTmuxSession,
  sendToTmuxSafe,
  execFileAsync,
  acceptBypassPrompt,
  getExecOptions,
} from "../tmuxUtils.js";
import type { GitStatusManager } from "../GitStatusManager.js";
import type { ProjectsManager } from "../ProjectsManager.js";
import type { AgentRegistry } from "../agents/AgentRegistry.js";

export class SessionManager {
  private managedSessions = new Map<string, ManagedSession>();
  private claudeToManagedMap = new Map<string, string>();
  private sessionCounter = 0;

  private sessionsFile: string;
  private execPath: string;
  private workingTimeoutMs: number;

  private gitStatusManager: GitStatusManager;
  private projectsManager: ProjectsManager;
  private agentRegistry: AgentRegistry;

  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private groupRemover: ((sessionId: string) => void) | null = null;

  constructor(deps: {
    sessionsFile: string;
    execPath: string;
    workingTimeoutMs: number;
    gitStatusManager: GitStatusManager;
    projectsManager: ProjectsManager;
    agentRegistry: AgentRegistry;
  }) {
    this.sessionsFile = deps.sessionsFile;
    this.execPath = deps.execPath;
    this.workingTimeoutMs = deps.workingTimeoutMs;
    this.gitStatusManager = deps.gitStatusManager;
    this.projectsManager = deps.projectsManager;
    this.agentRegistry = deps.agentRegistry;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  setGroupRemover(fn: (sessionId: string) => void): void {
    this.groupRemover = fn;
  }

  // ============================================================================
  // CRUD
  // ============================================================================

  /** Get all managed sessions (with git status attached) */
  getSessions(): ManagedSession[] {
    return Array.from(this.managedSessions.values()).map((session) => ({
      ...session,
      gitStatus:
        (this.gitStatusManager.getStatus(session.id) as GitStatus | null) ??
        undefined,
    }));
  }

  /** Get a session by ID */
  getSession(id: string): ManagedSession | undefined {
    return this.managedSessions.get(id);
  }

  /** Check if a session exists */
  hasSession(id: string): boolean {
    return this.managedSessions.has(id);
  }

  /** Create a new session (supports multiple agent types) */
  async createSession(
    options: CreateSessionRequest = {},
  ): Promise<ManagedSession> {
    const agentType = options.agentType || "claude_code";

    // For non-claude_code agents, delegate to the registry
    if (agentType !== "claude_code") {
      const session = await this.agentRegistry.createSession(options);
      this.managedSessions.set(session.id, session);

      if (session.cwd) {
        this.gitStatusManager.track(session.id, session.cwd);
        this.projectsManager.addProject(session.cwd, session.name);
      }

      this.broadcastSessions();
      this.saveSessions();
      return session;
    }

    // Claude Code: existing tmux-based session creation
    return new Promise((resolvePromise, reject) => {
      const id = randomUUID();
      this.sessionCounter++;
      const name = options.name || `Claude ${this.sessionCounter}`;
      const tmuxSession = `vibecraft-${shortId()}`;

      let cwd: string;
      try {
        cwd = validateDirectoryPath(options.cwd || process.cwd());
      } catch (err) {
        reject(err);
        return;
      }

      const flags = options.flags || {};
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

      execFile(
        "tmux",
        [
          "new-session",
          "-d",
          "-s",
          tmuxSession,
          "-c",
          cwd,
          `PATH='${this.execPath}' ${claudeCmd}`,
        ],
        getExecOptions(),
        (error) => {
          if (error) {
            log(`Failed to spawn session: ${error.message}`);
            reject(new Error(`Failed to spawn session: ${error.message}`));
            return;
          }
          const mode = options.mode || "auto-edit";

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
            description: options.description,
          };

          this.managedSessions.set(id, session);
          log(
            `Created session: ${name} (${id.slice(0, 8)}) -> tmux:${tmuxSession} cmd:'${claudeCmd}' mode:${mode}`,
          );

          if (cwd) {
            this.gitStatusManager.track(id, cwd);
            this.projectsManager.addProject(cwd, name);
          }

          // Accept the bypass permissions confirmation prompt
          if (flags.skipPermissions !== false) {
            acceptBypassPrompt(tmuxSession).catch(() => {});
          }

          // If mode is 'plan', send /plan command after session boots
          if (mode === "plan") {
            setTimeout(() => {
              this.sendPromptToSession(id, "/plan").then((result) => {
                if (result.ok) {
                  log(`Sent /plan to ${name}`);
                } else {
                  log(`Failed to send /plan to ${name}: ${result.error}`);
                }
              });
            }, 3000);
          }

          this.broadcastSessions();
          this.saveSessions();
          resolvePromise(session);
        },
      );
    });
  }

  /** Update a session */
  updateSession(
    id: string,
    updates: UpdateSessionRequest,
  ): ManagedSession | null {
    const session = this.managedSessions.get(id);
    if (!session) return null;

    if (updates.name) {
      session.name = updates.name;
    }
    if (updates.zonePosition) {
      session.zonePosition = updates.zonePosition;
    }

    log(`Updated session: ${session.name} (${id.slice(0, 8)})`);
    this.broadcastSessions();
    this.saveSessions();
    return session;
  }

  /** Delete/kill a session (supports multiple agent types) */
  deleteSession(id: string): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const session = this.managedSessions.get(id);
      if (!session) {
        resolvePromise(false);
        return;
      }

      // For non-claude_code agents, delegate to the registry
      if (session.agentType && session.agentType !== "claude_code") {
        this.agentRegistry
          .destroySession(session)
          .then((ok) => {
            if (ok) {
              this.managedSessions.delete(id);
              this.gitStatusManager.untrack(id);
              this.groupRemover?.(id);
              log(
                `Deleted ${session.agentType} session: ${session.name} (${id.slice(0, 8)})`,
              );
              this.broadcastSessions();
              this.saveSessions();
            }
            resolvePromise(ok);
          })
          .catch(() => resolvePromise(false));
        return;
      }

      // Claude Code: kill the tmux session
      try {
        validateTmuxSession(session.tmuxSession);
      } catch {
        log(`Invalid tmux session name: ${session.tmuxSession}`);
        resolvePromise(false);
        return;
      }

      execFile(
        "tmux",
        ["kill-session", "-t", session.tmuxSession],
        getExecOptions(),
        (error) => {
          if (error) {
            log(`Warning: Failed to kill tmux session: ${error.message}`);
          }

          this.managedSessions.delete(id);
          this.gitStatusManager.untrack(id);
          for (const [claudeId, managedId] of this.claudeToManagedMap) {
            if (managedId === id) {
              this.claudeToManagedMap.delete(claudeId);
            }
          }
          this.groupRemover?.(id);

          log(`Deleted session: ${session.name} (${id.slice(0, 8)})`);
          this.broadcastSessions();
          this.saveSessions();
          resolvePromise(true);
        },
      );
    });
  }

  // ============================================================================
  // Prompt
  // ============================================================================

  /** Send a prompt to a specific session (supports multiple agent types) */
  async sendPromptToSession(
    id: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const session = this.managedSessions.get(id);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    // For non-claude_code agents, delegate to the registry
    if (session.agentType && session.agentType !== "claude_code") {
      const result = await this.agentRegistry.sendPrompt(session, prompt);
      if (result.ok) {
        session.lastActivity = Date.now();
        log(
          `Prompt sent to ${session.agentType}/${session.name}: ${prompt.slice(0, 50)}...`,
        );
      }
      return result;
    }

    // Claude Code: verify tmux session is alive before sending
    try {
      await execFileAsync("tmux", ["has-session", "-t", session.tmuxSession]);
    } catch {
      log(
        `Session "${session.name}" tmux session is dead (${session.tmuxSession})`,
      );
      session.status = "offline";
      session.currentTool = undefined;
      this.broadcastSessions();
      this.saveSessions();
      return { ok: false, error: "Session is offline" };
    }

    try {
      await sendToTmuxSafe(session.tmuxSession, prompt);
      session.lastActivity = Date.now();
      log(`Prompt sent to ${session.name}: ${prompt.slice(0, 50)}...`);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Failed to send prompt to ${session.name}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  // ============================================================================
  // Health & Timeouts
  // ============================================================================

  /** Check if sessions are still alive (supports multiple agent types) */
  checkSessionHealth(): void {
    exec(
      'tmux list-sessions -F "#{session_name}"',
      getExecOptions(),
      (error, stdout) => {
        const activeSessions = error
          ? new Set<string>()
          : new Set(stdout.trim().split("\n"));
        let changed = false;

        for (const session of this.managedSessions.values()) {
          if (session.agentType && session.agentType !== "claude_code")
            continue;

          const isAlive = activeSessions.has(session.tmuxSession);
          const newStatus = isAlive
            ? session.status === "offline"
              ? "idle"
              : session.status
            : "offline";

          if (session.status !== newStatus) {
            session.status = newStatus;
            changed = true;
          }
        }

        if (changed) {
          this.broadcastSessions();
          this.saveSessions();
        }
      },
    );

    // Check non-claude_code sessions via their adapters
    for (const session of this.managedSessions.values()) {
      if (!session.agentType || session.agentType === "claude_code") continue;
      this.agentRegistry.checkHealth(session).then((newStatus) => {
        if (session.status !== newStatus) {
          session.status = newStatus;
          this.broadcastSessions();
          this.saveSessions();
        }
      });
    }
  }

  /** Check for stale "working" sessions and transition them to idle */
  checkWorkingTimeout(): void {
    const now = Date.now();
    let changed = false;

    for (const session of this.managedSessions.values()) {
      if (session.status === "working") {
        const timeSinceActivity = now - session.lastActivity;
        if (timeSinceActivity > this.workingTimeoutMs) {
          log(
            `Session "${session.name}" timed out after ${Math.round(timeSinceActivity / 1000)}s of no activity`,
          );
          session.status = "idle";
          session.currentTool = undefined;
          changed = true;
        }
      }
    }

    if (changed) {
      this.broadcastSessions();
      this.saveSessions();
    }
  }

  /** Auto-restart all offline sessions */
  async autoRestartOfflineSessions(): Promise<void> {
    const offlineSessions = Array.from(this.managedSessions.values()).filter(
      (s) => s.status === "offline",
    );

    if (offlineSessions.length === 0) {
      debug("No offline sessions to auto-restart");
      return;
    }

    log(`Auto-restarting ${offlineSessions.length} offline session(s)...`);

    let restarted = 0;
    for (const session of offlineSessions) {
      const ok = await this.restartOfflineSession(session);
      if (ok) restarted++;
    }

    if (restarted > 0) {
      this.broadcastSessions();
      this.saveSessions();
      log(`Auto-restarted ${restarted}/${offlineSessions.length} session(s)`);
    }
  }

  /** Restart a single offline session (supports multiple agent types) */
  async restartOfflineSession(session: ManagedSession): Promise<boolean> {
    if (session.agentType && session.agentType !== "claude_code") {
      const ok = await this.agentRegistry.restartSession(session);
      if (ok) {
        session.status = "idle";
        session.lastActivity = Date.now();
        log(
          `Restarted ${session.agentType} session: ${session.name} (${session.id.slice(0, 8)})`,
        );
      }
      return ok;
    }

    return new Promise((resolvePromise) => {
      let cwd: string;
      try {
        cwd = validateDirectoryPath(session.cwd || process.cwd());
      } catch {
        log(
          `Cannot auto-restart "${session.name}": invalid cwd ${session.cwd}`,
        );
        resolvePromise(false);
        return;
      }

      execFile(
        "tmux",
        ["kill-session", "-t", session.tmuxSession],
        getExecOptions(),
        () => {
          execFile(
            "tmux",
            [
              "new-session",
              "-d",
              "-s",
              session.tmuxSession,
              "-c",
              cwd,
              `PATH='${this.execPath}' claude --permission-mode=bypassPermissions --dangerously-skip-permissions`,
            ],
            getExecOptions(),
            (error) => {
              if (error) {
                log(
                  `Failed to auto-restart "${session.name}": ${error.message}`,
                );
                resolvePromise(false);
                return;
              }

              session.status = "idle";
              session.lastActivity = Date.now();
              session.claudeSessionId = undefined;
              session.currentTool = undefined;

              for (const [claudeId, managedId] of this.claudeToManagedMap) {
                if (managedId === session.id) {
                  this.claudeToManagedMap.delete(claudeId);
                }
              }

              acceptBypassPrompt(session.tmuxSession).catch(() => {});

              log(
                `Auto-restarted session: ${session.name} (${session.id.slice(0, 8)}) -> tmux:${session.tmuxSession}`,
              );
              resolvePromise(true);
            },
          );
        },
      );
    });
  }

  /** Restart a session via API (with -c flag for continue) */
  restartSessionWithContinue(session: ManagedSession): Promise<boolean> {
    return new Promise((resolvePromise) => {
      let cwd: string;
      try {
        cwd = validateDirectoryPath(session.cwd || process.cwd());
      } catch (err) {
        resolvePromise(false);
        return;
      }

      try {
        validateTmuxSession(session.tmuxSession);
      } catch {
        resolvePromise(false);
        return;
      }

      execFile(
        "tmux",
        ["kill-session", "-t", session.tmuxSession],
        getExecOptions(),
        () => {
          execFile(
            "tmux",
            [
              "new-session",
              "-d",
              "-s",
              session.tmuxSession,
              "-c",
              cwd,
              `PATH='${this.execPath}' claude -c --permission-mode=bypassPermissions --dangerously-skip-permissions`,
            ],
            getExecOptions(),
            (error) => {
              if (error) {
                resolvePromise(false);
                return;
              }

              session.status = "idle";
              session.lastActivity = Date.now();
              session.claudeSessionId = undefined;
              session.currentTool = undefined;

              for (const [claudeId, managedId] of this.claudeToManagedMap) {
                if (managedId === session.id) {
                  this.claudeToManagedMap.delete(claudeId);
                }
              }

              acceptBypassPrompt(session.tmuxSession).catch(() => {});

              log(
                `Restarted session: ${session.name} (${session.id.slice(0, 8)})`,
              );
              this.broadcastSessions();
              this.saveSessions();
              resolvePromise(true);
            },
          );
        },
      );
    });
  }

  // ============================================================================
  // Session Linking
  // ============================================================================

  /** Link a Claude Code session ID to a managed session */
  linkClaudeSession(claudeSessionId: string, managedSessionId: string): void {
    this.claudeToManagedMap.set(claudeSessionId, managedSessionId);
  }

  /** Find managed session by Claude Code session ID */
  findManagedSession(claudeSessionId: string): ManagedSession | undefined {
    const managedId = this.claudeToManagedMap.get(claudeSessionId);
    if (managedId) {
      return this.managedSessions.get(managedId);
    }
    return undefined;
  }

  /** Try to auto-link by matching CWD */
  tryAutoLinkByCwd(
    claudeSessionId: string,
    eventCwd: string | undefined,
  ): ManagedSession | undefined {
    if (!eventCwd) return undefined;

    if (this.claudeToManagedMap.has(claudeSessionId)) {
      return this.findManagedSession(claudeSessionId);
    }

    const normalizedEventCwd = resolve(eventCwd);

    const candidates: ManagedSession[] = [];
    for (const session of this.managedSessions.values()) {
      // Skip sessions already linked with a real Claude session ID.
      // Synthetic "managed:" prefix IDs are treated as unlinked.
      if (
        session.claudeSessionId &&
        !session.claudeSessionId.startsWith("managed:")
      )
        continue;
      if (!session.cwd) continue;

      const normalizedSessionCwd = resolve(session.cwd);
      if (normalizedSessionCwd === normalizedEventCwd) {
        candidates.push(session);
      }
    }

    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => b.createdAt - a.createdAt);
    const match = candidates[0];

    // Clean up stale synthetic managed: link if present
    if (match.claudeSessionId?.startsWith("managed:")) {
      this.claudeToManagedMap.delete(match.claudeSessionId);
    }

    this.linkClaudeSession(claudeSessionId, match.id);
    match.claudeSessionId = claudeSessionId;
    log(
      `Auto-linked Claude session ${claudeSessionId.slice(0, 8)} to "${match.name}" by CWD match (${normalizedEventCwd})`,
    );

    this.broadcastSessions();
    this.saveSessions();
    return match;
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /** Handle a processed event — update managed session status */
  handleEvent(event: ClaudeEvent): void {
    const managedSession =
      this.findManagedSession(event.sessionId) ??
      this.tryAutoLinkByCwd(event.sessionId, event.cwd);
    if (!managedSession) return;

    const prevStatus = managedSession.status;
    managedSession.lastActivity = Date.now();
    managedSession.cwd = event.cwd;

    switch (event.type) {
      case "pre_tool_use":
        managedSession.status = "working";
        managedSession.currentTool = (event as PreToolUseEvent).tool;
        break;

      case "post_tool_use":
        managedSession.currentTool = undefined;
        break;

      case "user_prompt_submit":
        managedSession.status = "working";
        managedSession.currentTool = undefined;
        break;

      case "stop":
      case "session_end":
        managedSession.status = "idle";
        managedSession.currentTool = undefined;
        break;
    }

    if (managedSession.status !== prevStatus) {
      this.broadcastSessions();
      this.saveSessions();
    }
  }

  /** Update session status from permission manager */
  updateSessionStatus(sessionId: string, status: string, tool?: string): void {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    session.status = status as ManagedSession["status"];
    session.currentTool = tool;
    this.broadcastSessions();
    this.saveSessions();
  }

  // ============================================================================
  // Mode Switching
  // ============================================================================

  /** Switch a session's Claude Code mode */
  async switchMode(
    sessionId: string,
    mode: string,
  ): Promise<{ ok: boolean; error?: string; session?: ManagedSession }> {
    const session = this.managedSessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };

    if (!["auto-edit", "plan", "ask-before-edit"].includes(mode)) {
      return { ok: false, error: "Invalid mode" };
    }

    const oldMode = session.mode || "auto-edit";
    const needsRestart =
      (oldMode === "ask-before-edit" && mode !== "ask-before-edit") ||
      (oldMode !== "ask-before-edit" && mode === "ask-before-edit");

    if (needsRestart) {
      return {
        ok: false,
        error: "restart_required",
      };
    }

    if (mode === "plan" && oldMode !== "plan") {
      const result = await this.sendPromptToSession(session.id, "/plan");
      if (!result.ok) return { ok: false, error: result.error };
    } else if (mode !== "plan" && oldMode === "plan") {
      const result = await this.sendPromptToSession(session.id, "/plan");
      if (!result.ok) return { ok: false, error: result.error };
    }

    session.mode = mode as ClaudeMode;
    log(`Mode changed for ${session.name}: ${oldMode} -> ${mode}`);
    this.broadcastSessions();
    this.saveSessions();

    return { ok: true, session };
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /** Save sessions to disk */
  saveSessions(): void {
    try {
      const data = {
        sessions: Array.from(this.managedSessions.values()),
        claudeToManagedMap: Array.from(this.claudeToManagedMap.entries()),
        sessionCounter: this.sessionCounter,
      };
      writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
      debug(
        `Saved ${this.managedSessions.size} sessions to ${this.sessionsFile}`,
      );
    } catch (e) {
      console.error("Failed to save sessions:", e);
    }
  }

  /** Load sessions (clean start: clears everything) */
  loadSessions(): void {
    this.managedSessions.clear();
    this.claudeToManagedMap.clear();
    this.sessionCounter = 0;

    if (existsSync(this.sessionsFile)) {
      try {
        unlinkSync(this.sessionsFile);
      } catch {
        // ignore
      }
    }

    log("Sessions cleared (clean start)");
  }

  /** Broadcast current sessions to all clients */
  broadcastSessions(): void {
    this.broadcastFn?.({
      type: "sessions",
      payload: this.getSessions(),
    });
  }
}

/** Generate a short ID for tmux session names */
function shortId(): string {
  return randomUUID().slice(0, 8);
}
