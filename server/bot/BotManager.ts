/**
 * BotManager — Orchestration layer between Vibecraft server and IM platforms.
 *
 * Inbound:  IM message → parse → find session → sendPromptToSession()
 * Outbound: stop event → extract response → sendTaskCompletion() → IM
 */

import type { BotBridge, TaskCompletionMessage } from "./BotBridge.js";
import type { ManagedSession, StopEvent } from "../../shared/types.js";
import { parseIMMessage } from "./messageParser.js";

// ============================================================================
// Types
// ============================================================================

/** Dependencies injected from server/index.ts (avoids circular imports) */
export interface BotManagerDeps {
  getSessions: () => ManagedSession[];
  getSession: (id: string) => ManagedSession | undefined;
  sendPrompt: (
    id: string,
    prompt: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  log: (msg: string) => void;
}

/** Tracked pending task (dispatched via IM, awaiting completion) */
interface PendingTask {
  prompt: string;
  dispatchedAt: number;
  chatId: string;
  messageId: string;
}

// ============================================================================
// BotManager
// ============================================================================

export class BotManager {
  private bridge: BotBridge;
  private deps: BotManagerDeps;
  private pendingTasks = new Map<string, PendingTask>();

  constructor(bridge: BotBridge, deps: BotManagerDeps) {
    this.bridge = bridge;
    this.deps = deps;

    this.bridge.onMessage((msg) => this.handleIncomingMessage(msg));
  }

  async start(): Promise<void> {
    await this.bridge.start();
  }

  async stop(): Promise<void> {
    await this.bridge.stop();
  }

  /**
   * Called from addEvent() in server/index.ts when a stop event fires.
   * Sends a completion report to the IM group.
   */
  async handleStopEvent(
    session: ManagedSession,
    event: StopEvent,
  ): Promise<void> {
    const pending = this.pendingTasks.get(session.id);

    const msg: TaskCompletionMessage = {
      sessionName: session.name,
      status: "completed",
      response: event.response,
      originalPrompt: pending?.prompt,
      duration: pending ? Date.now() - pending.dispatchedAt : undefined,
    };

    await this.bridge.sendTaskCompletion(msg);

    if (pending) {
      this.pendingTasks.delete(session.id);
    }
  }

  // --------------------------------------------------------------------------
  // Inbound message handling
  // --------------------------------------------------------------------------

  private async handleIncomingMessage(msg: {
    text: string;
    senderName: string;
    senderId: string;
    chatId: string;
    messageId: string;
  }): Promise<void> {
    const text = msg.text.trim();
    if (!text) return;

    const sessions = this.deps.getSessions();
    const sessionNames = sessions.map((s) => s.name);
    const parsed = parseIMMessage(text, sessionNames);

    // Handle status query
    if (parsed.isStatusQuery) {
      await this.handleStatusQuery(sessions);
      return;
    }

    // Handle help query
    if (parsed.isHelpQuery) {
      await this.handleHelpQuery(sessionNames);
      return;
    }

    // Must have a target session
    if (!parsed.targetSessionName) {
      await this.bridge.sendText(
        `Please specify a target session.\n\nUsage: @SessionName your task\n\nAvailable: ${sessionNames.join(", ") || "(none)"}`,
      );
      return;
    }

    // Find the target session
    const target = sessions.find(
      (s) =>
        s.name.toLowerCase() === parsed.targetSessionName!.toLowerCase(),
    );

    if (!target) {
      await this.bridge.sendText(
        `Session "${parsed.targetSessionName}" not found.\n\nAvailable: ${sessionNames.join(", ") || "(none)"}`,
      );
      return;
    }

    if (target.status === "offline") {
      await this.bridge.sendText(
        `⚫ ${target.name} is offline. Restart the session first.`,
      );
      return;
    }

    if (target.status === "working") {
      await this.bridge.sendText(
        `🔵 ${target.name} is currently busy. Please wait for the current task to finish.`,
      );
      return;
    }

    if (!parsed.prompt) {
      await this.bridge.sendText(
        `Please provide a task for ${target.name}.\n\nExample: @${target.name} fix the login bug`,
      );
      return;
    }

    // Dispatch the task
    const result = await this.deps.sendPrompt(target.id, parsed.prompt);

    if (result.ok) {
      this.pendingTasks.set(target.id, {
        prompt: parsed.prompt,
        dispatchedAt: Date.now(),
        chatId: msg.chatId,
        messageId: msg.messageId,
      });

      const preview =
        parsed.prompt.length > 80
          ? parsed.prompt.slice(0, 80) + "..."
          : parsed.prompt;
      await this.bridge.sendText(
        `📋 Task dispatched to ${target.name}: "${preview}"`,
      );

      this.deps.log(
        `Bot: dispatched task to ${target.name} via IM: ${parsed.prompt.slice(0, 50)}...`,
      );
    } else {
      await this.bridge.sendText(
        `Failed to dispatch to ${target.name}: ${result.error}`,
      );
    }
  }

  private async handleStatusQuery(
    sessions: ManagedSession[],
  ): Promise<void> {
    if (sessions.length === 0) {
      await this.bridge.sendText("No active sessions.");
      return;
    }

    const lines = sessions.map((s) => {
      const emoji =
        s.status === "idle"
          ? "🟢"
          : s.status === "working"
            ? "🔵"
            : s.status === "waiting"
              ? "🟡"
              : "⚫";
      const tool = s.currentTool ? ` (${s.currentTool})` : "";
      return `${emoji} ${s.name}: ${s.status}${tool}`;
    });

    await this.bridge.sendText(`Session Status:\n${lines.join("\n")}`);
  }

  private async handleHelpQuery(sessionNames: string[]): Promise<void> {
    const available = sessionNames.length
      ? sessionNames.join(", ")
      : "(none)";

    await this.bridge.sendText(
      [
        "Vibecraft Bot Commands:",
        "",
        "• @SessionName <task> — Dispatch a task",
        "• status — Show all session statuses",
        "• help — Show this help",
        "",
        `Available sessions: ${available}`,
      ].join("\n"),
    );
  }
}
