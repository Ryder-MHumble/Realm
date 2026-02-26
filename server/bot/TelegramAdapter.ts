/**
 * TelegramAdapter — Telegram bot integration.
 *
 * Outbound: Bot API sendMessage.
 * Inbound: Optional getUpdates polling for commands.
 */

import type { BotBridge, BotMessage, TaskCompletionMessage } from "./BotBridge.js";

// ============================================================================
// Types
// ============================================================================

export interface TelegramConfig {
  /** Bot API token (from @BotFather) */
  botToken: string;
  /** Chat ID to send messages to (group or user) */
  chatId: string;
}

type LogFn = (msg: string) => void;

// ============================================================================
// TelegramAdapter
// ============================================================================

export class TelegramAdapter implements BotBridge {
  readonly platform = "telegram";

  private botToken: string;
  private chatId: string;
  private messageHandler?: (msg: BotMessage) => void;
  private log: LogFn;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateId = 0;

  constructor(config: TelegramConfig, log: LogFn) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.log = log;
  }

  async start(): Promise<void> {
    if (!this.botToken || !this.chatId) {
      this.log("Telegram bot: missing botToken or chatId, disabled");
      return;
    }
    this.log("Telegram bot: outbound configured");

    // Start polling for inbound messages
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onMessage(handler: (msg: BotMessage) => void): void {
    this.messageHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Outbound: Vibecraft → Telegram
  // --------------------------------------------------------------------------

  async sendTaskCompletion(msg: TaskCompletionMessage): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    const statusEmoji = msg.status === "completed" ? "✅" : "❌";
    const duration = msg.duration
      ? ` (${Math.round(msg.duration / 1000)}s)`
      : "";

    const responseText = msg.response
      ? msg.response.length > 800
        ? msg.response.slice(0, 800) + "\n..."
        : msg.response
      : "No response text available.";

    const promptLine = msg.originalPrompt
      ? `<b>Task:</b> ${escapeHtml(msg.originalPrompt.slice(0, 100))}${msg.originalPrompt.length > 100 ? "..." : ""}\n\n`
      : "";

    const text =
      `${statusEmoji} <b>${escapeHtml(msg.sessionName)} — Task ${msg.status}${duration}</b>\n\n` +
      `${promptLine}${escapeHtml(responseText)}`;

    await this.apiCall("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
    });
  }

  async sendStatusUpdate(
    sessionName: string,
    status: string,
    detail?: string,
  ): Promise<void> {
    const text = detail
      ? `🔄 ${sessionName}: ${status} — ${detail}`
      : `🔄 ${sessionName}: ${status}`;
    await this.sendText(text);
  }

  async sendText(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    await this.apiCall("sendMessage", {
      chat_id: this.chatId,
      text,
    });
  }

  // --------------------------------------------------------------------------
  // Inbound: Telegram → Vibecraft (getUpdates polling)
  // --------------------------------------------------------------------------

  private startPolling(): void {
    if (!this.messageHandler) return;

    this.pollTimer = setInterval(async () => {
      try {
        const data = await this.apiCall("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: 0,
          allowed_updates: ["message"],
        }) as { ok?: boolean; result?: TelegramUpdate[] };

        if (!data?.ok || !data.result) return;

        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

          if (update.message?.text && this.messageHandler) {
            // Strip /command prefix if present
            let text = update.message.text;
            if (text.startsWith("/")) {
              text = text.replace(/^\/\w+\s*/, "").trim();
            }
            if (!text) continue;

            this.messageHandler({
              text,
              senderName: update.message.from?.first_name || "unknown",
              senderId: String(update.message.from?.id || ""),
              chatId: String(update.message.chat.id),
              messageId: String(update.message.message_id),
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Telegram poll error: ${msg}`);
      }
    }, 10_000); // Poll every 10 seconds
  }

  // --------------------------------------------------------------------------
  // Internal: Telegram Bot API call
  // --------------------------------------------------------------------------

  private async apiCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
      );

      if (!response.ok) {
        this.log(`Telegram API error: ${response.status} ${response.statusText}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Telegram API call failed: ${msg}`);
      return null;
    }
  }
}

// ============================================================================
// Telegram types (minimal subset)
// ============================================================================

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
