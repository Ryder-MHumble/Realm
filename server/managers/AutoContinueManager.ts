/**
 * Auto-Continue Manager
 *
 * Detects premature stops in Claude Code sessions and automatically
 * sends "continue" to resume work. Uses heuristics to distinguish
 * between completed tasks and premature stops.
 */

import type {
  AutoContinueSettings,
  ClaudeEvent,
  ServerMessage,
  StopEvent,
} from "../../shared/types.js";
import { log, debug } from "../logger.js";

export const DEFAULT_AUTO_CONTINUE_CONFIG: AutoContinueSettings = {
  enabled: false,
  maxRetries: 3,
  cooldownSeconds: 5,
  continuePrompt: "continue",
};

const COMPLETION_PATTERNS = [
  /\bi(?:'ve| have) completed?\b/i,
  /\ball done\b/i,
  /\blet me know if\b/i,
  /\bis there anything else\b/i,
  /\btask (?:is )?(?:complete|finished|done)\b/i,
  /\bsuccessfully (?:completed|finished|implemented|created|updated)\b/i,
  /\bhere(?:'s| is) (?:a |the )?summary\b/i,
  /\bwould you like (?:me to|anything)\b/i,
  /\bfeel free to\b/i,
  /\beverything (?:is |has been )?(?:set up|ready|in place)\b/i,
  /以上就是/i,
  /已经完成/i,
  /全部完成/i,
  /如果.*还有.*问题/i,
  /还有什么.*需要/i,
];

interface SessionState {
  consecutiveRetries: number;
  lastContinueTime: number;
}

export class AutoContinueManager {
  private config: AutoContinueSettings;
  private sessionStates = new Map<string, SessionState>();
  private disabledSessions = new Set<string>();

  private sendPrompt:
    | ((sessionId: string, prompt: string) => Promise<{ ok: boolean }>)
    | null = null;
  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private getSessionStatus:
    | ((sessionId: string) => string | undefined)
    | null = null;

  constructor(config?: Partial<AutoContinueSettings>) {
    this.config = { ...DEFAULT_AUTO_CONTINUE_CONFIG, ...config };
  }

  setSendPrompt(
    fn: (sessionId: string, prompt: string) => Promise<{ ok: boolean }>,
  ): void {
    this.sendPrompt = fn;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  setSessionStatusProvider(
    fn: (sessionId: string) => string | undefined,
  ): void {
    this.getSessionStatus = fn;
  }

  updateConfig(config: Partial<AutoContinueSettings>): void {
    this.config = { ...this.config, ...config };
    log(
      `Auto-continue config updated: enabled=${this.config.enabled}, maxRetries=${this.config.maxRetries}`,
    );
  }

  getConfig(): AutoContinueSettings {
    return { ...this.config };
  }

  setSessionEnabled(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.disabledSessions.delete(sessionId);
    } else {
      this.disabledSessions.add(sessionId);
    }
  }

  /** Handle processed events from EventProcessor */
  handleEvent(event: ClaudeEvent): void {
    if (event.type === "user_prompt_submit") {
      const state = this.sessionStates.get(event.sessionId);
      if (state) {
        state.consecutiveRetries = 0;
      }
      return;
    }

    if (event.type !== "stop") return;
    this.evaluateStop(event as StopEvent);
  }

  private evaluateStop(event: StopEvent): void {
    if (!this.config.enabled) return;
    if (this.disabledSessions.has(event.sessionId)) return;

    if (!event.stopHookActive) {
      debug(
        `Auto-continue skipped for ${event.sessionId}: stopHookActive=false`,
      );
      return;
    }

    const response = event.response?.trim() || "";
    if (response && this.looksComplete(response)) {
      debug(
        `Auto-continue skipped for ${event.sessionId}: response looks complete`,
      );
      const state = this.getOrCreateState(event.sessionId);
      state.consecutiveRetries = 0;
      return;
    }

    const state = this.getOrCreateState(event.sessionId);

    if (state.consecutiveRetries >= this.config.maxRetries) {
      log(
        `Auto-continue limit reached for ${event.sessionId} (${state.consecutiveRetries}/${this.config.maxRetries})`,
      );
      this.broadcastFn?.({
        type: "event",
        payload: {
          id: `auto-continue-limit-${Date.now()}`,
          timestamp: Date.now(),
          type: "notification",
          sessionId: event.sessionId,
          cwd: event.cwd,
          message: `Auto-continue limit reached (${this.config.maxRetries} retries)`,
          notificationType: "auto_continue_limit",
        },
      } as ServerMessage);
      state.consecutiveRetries = 0;
      return;
    }

    const elapsed = (Date.now() - state.lastContinueTime) / 1000;
    if (elapsed < this.config.cooldownSeconds) {
      debug(
        `Auto-continue cooldown for ${event.sessionId}: ${Math.round(elapsed)}s`,
      );
      return;
    }

    // Delay to let UI update and allow user to intervene
    setTimeout(() => {
      this.sendContinue(event.sessionId, event.cwd, state);
    }, 2000);
  }

  private async sendContinue(
    sessionId: string,
    cwd: string,
    state: SessionState,
  ): Promise<void> {
    const status = this.getSessionStatus?.(sessionId);
    if (status === "working") {
      debug(`Auto-continue aborted for ${sessionId}: session is working`);
      return;
    }

    state.consecutiveRetries++;
    state.lastContinueTime = Date.now();
    log(`Auto-continue #${state.consecutiveRetries} for ${sessionId}`);

    this.broadcastFn?.({
      type: "event",
      payload: {
        id: `auto-continue-${Date.now()}`,
        timestamp: Date.now(),
        type: "notification",
        sessionId,
        cwd: cwd || "",
        message: `Auto-continuing (attempt ${state.consecutiveRetries}/${this.config.maxRetries})`,
        notificationType: "auto_continue",
      },
    } as ServerMessage);

    const result = await this.sendPrompt?.(
      sessionId,
      this.config.continuePrompt,
    );
    if (result?.ok) {
      log(`Auto-continue sent to ${sessionId}`);
    } else {
      log(`Auto-continue failed for ${sessionId}`);
      state.consecutiveRetries--;
    }
  }

  private looksComplete(response: string): boolean {
    const tail = response.slice(-500);
    return COMPLETION_PATTERNS.some((pattern) => pattern.test(tail));
  }

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = { consecutiveRetries: 0, lastContinueTime: 0 };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }
}
