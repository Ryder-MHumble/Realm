/**
 * Auto-Compact Manager
 *
 * Monitors token usage per session and automatically triggers /compact
 * when tokens approach the context window limit. Only fires when the
 * session is idle (not during active tool use).
 */

import type { AutoCompactSettings, ServerMessage } from "../../shared/types.js";
import { log, debug } from "../logger.js";

export const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactSettings = {
  enabled: false,
  threshold: 150_000,
  cooldownSeconds: 120,
};

interface SessionInfo {
  id: string;
  tmuxSession: string;
  status: string;
}

export class AutoCompactManager {
  private config: AutoCompactSettings;
  private lastCompactTime = new Map<string, number>();
  private disabledSessions = new Set<string>();

  private sessionProvider: (() => SessionInfo[]) | null = null;
  private sendPrompt:
    | ((sessionId: string, prompt: string) => Promise<{ ok: boolean }>)
    | null = null;
  private broadcastFn: ((msg: ServerMessage) => void) | null = null;

  constructor(config?: Partial<AutoCompactSettings>) {
    this.config = { ...DEFAULT_AUTO_COMPACT_CONFIG, ...config };
  }

  setSessionProvider(fn: () => SessionInfo[]): void {
    this.sessionProvider = fn;
  }

  setSendPrompt(
    fn: (sessionId: string, prompt: string) => Promise<{ ok: boolean }>,
  ): void {
    this.sendPrompt = fn;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  updateConfig(config: Partial<AutoCompactSettings>): void {
    this.config = { ...this.config, ...config };
    log(
      `Auto-compact config updated: enabled=${this.config.enabled}, threshold=${this.config.threshold}`,
    );
  }

  getConfig(): AutoCompactSettings {
    return { ...this.config };
  }

  setSessionEnabled(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.disabledSessions.delete(sessionId);
    } else {
      this.disabledSessions.add(sessionId);
    }
  }

  /** Called when token data is updated (from TokenTracker) */
  onTokenUpdate(tmuxSession: string, currentTokens: number): void {
    if (!this.config.enabled) return;
    if (currentTokens < this.config.threshold) return;

    // Check cooldown
    const lastCompact = this.lastCompactTime.get(tmuxSession) || 0;
    const elapsed = (Date.now() - lastCompact) / 1000;
    if (elapsed < this.config.cooldownSeconds) {
      debug(
        `Auto-compact cooldown for ${tmuxSession}: ${Math.round(elapsed)}s / ${this.config.cooldownSeconds}s`,
      );
      return;
    }

    // Find the managed session for this tmux session
    const sessions = this.sessionProvider?.() ?? [];
    const session = sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;

    if (this.disabledSessions.has(session.id)) return;

    // Only compact when idle
    if (session.status === "working") {
      debug(
        `Auto-compact deferred for ${tmuxSession}: session is working`,
      );
      return;
    }

    this.lastCompactTime.set(tmuxSession, Date.now());
    log(
      `Auto-compact triggered for session ${session.id} (${currentTokens} tokens)`,
    );

    this.sendPrompt?.(session.id, "/compact").then((result) => {
      if (result.ok) {
        log(`Auto-compact sent to session ${session.id}`);
        this.broadcastFn?.({
          type: "event",
          payload: {
            id: `auto-compact-${Date.now()}`,
            timestamp: Date.now(),
            type: "notification",
            sessionId: session.id,
            cwd: "",
            message: `Auto-compact triggered (${currentTokens} tokens)`,
            notificationType: "auto_compact",
          },
        } as ServerMessage);
      } else {
        log(`Auto-compact failed for session ${session.id}`);
      }
    });
  }
}
