/**
 * Token Tracker
 *
 * Polls tmux sessions for token usage counts and broadcasts updates.
 */

import { execFile } from "child_process";
import type { ManagedSession, ServerMessage } from "../../shared/types.js";
import { log, debug } from "../logger.js";
import { validateTmuxSession, getExecOptions } from "../tmuxUtils.js";

interface SessionTokens {
  lastSeen: number;
  cumulative: number;
  lastUpdate: number;
}

export class TokenTracker {
  private sessionTokens = new Map<string, SessionTokens>();
  private lastTmuxHash = "";
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private sessionProvider: (() => ManagedSession[]) | null = null;
  private defaultTmuxSession: string;

  constructor(defaultTmuxSession: string) {
    this.defaultTmuxSession = defaultTmuxSession;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  setSessionProvider(provider: () => ManagedSession[]): void {
    this.sessionProvider = provider;
  }

  /** Get token data for a session */
  getTokenData(
    session: string,
  ): { current: number; cumulative: number } | undefined {
    const data = this.sessionTokens.get(session);
    if (!data) return undefined;
    return { current: data.lastSeen, cumulative: data.cumulative };
  }

  /** Get all token data */
  getAllTokenData(): Record<string, { current: number; cumulative: number }> {
    const result: Record<string, { current: number; cumulative: number }> = {};
    for (const [session, data] of this.sessionTokens) {
      result[session] = { current: data.lastSeen, cumulative: data.cumulative };
    }
    return result;
  }

  /** Start polling for tokens (every 2 seconds) */
  start(): void {
    this.intervalId = setInterval(() => {
      const sessions = this.sessionProvider?.() ?? [];
      for (const session of sessions) {
        if (session.status !== "offline") {
          this.pollTokens(session.tmuxSession);
        }
      }
      // Also poll the default session for backwards compatibility
      if (sessions.length === 0) {
        this.pollTokens(this.defaultTmuxSession);
      }
    }, 2000);
    log("Token polling started");
  }

  /** Stop polling */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Poll a single tmux session for token counts */
  private pollTokens(tmuxSession: string): void {
    try {
      validateTmuxSession(tmuxSession);
    } catch {
      debug(`Invalid tmux session for token polling: ${tmuxSession}`);
      return;
    }

    execFile(
      "tmux",
      ["capture-pane", "-t", tmuxSession, "-p", "-S", "-50"],
      { ...getExecOptions(), maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          debug(`Token poll failed: ${error.message}`);
          return;
        }

        const hash = stdout.slice(-500);
        if (hash === this.lastTmuxHash) return;
        this.lastTmuxHash = hash;

        const tokens = parseTokensFromOutput(stdout);
        if (tokens === null) return;

        let session = this.sessionTokens.get(tmuxSession);
        if (!session) {
          session = { lastSeen: 0, cumulative: 0, lastUpdate: Date.now() };
          this.sessionTokens.set(tmuxSession, session);
        }

        if (tokens > session.lastSeen) {
          const delta = tokens - session.lastSeen;
          session.cumulative += delta;
          session.lastSeen = tokens;
          session.lastUpdate = Date.now();

          debug(
            `Tokens updated: ${tokens} (cumulative: ${session.cumulative})`,
          );

          this.broadcastFn?.({
            type: "tokens",
            payload: {
              session: tmuxSession,
              current: tokens,
              cumulative: session.cumulative,
            },
          } as ServerMessage);
        } else if (tokens < session.lastSeen && tokens > 0) {
          session.lastSeen = tokens;
          session.lastUpdate = Date.now();
          debug(`Token count reset detected: ${tokens}`);
        }
      },
    );
  }
}

/**
 * Parse token count from Claude Code output.
 * Patterns: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
 */
function parseTokensFromOutput(output: string): number | null {
  const patterns = [
    /↓\s*([0-9,]+)\s*tokens?/gi,
    /↓\s*([0-9.]+)k\s*tokens?/gi,
  ];

  let maxTokens = 0;

  const plainMatches = output.matchAll(patterns[0]);
  for (const match of plainMatches) {
    const num = parseInt(match[1].replace(/,/g, ""), 10);
    if (num > maxTokens) maxTokens = num;
  }

  const kMatches = output.matchAll(patterns[1]);
  for (const match of kMatches) {
    const num = Math.round(parseFloat(match[1]) * 1000);
    if (num > maxTokens) maxTokens = num;
  }

  return maxTokens > 0 ? maxTokens : null;
}
