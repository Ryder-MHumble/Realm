/**
 * FeishuAdapter — Feishu/Lark bot integration.
 *
 * Outbound (Vibecraft → IM): Simple HTTP POST to webhook URL.
 * Inbound (IM → Vibecraft): Lark SDK WSClient (WebSocket long-connection).
 */

import type { BotBridge, BotMessage, TaskCompletionMessage } from "./BotBridge.js";

// ============================================================================
// Types
// ============================================================================

export interface FeishuConfig {
  /** Webhook URL for outbound messages (custom bot in group) */
  webhookUrl: string;
  /** App ID for inbound messages (custom app with bot capability) */
  appId?: string;
  /** App Secret for inbound messages */
  appSecret?: string;
}

/** Logger function signature (injected from server) */
type LogFn = (msg: string) => void;

// ============================================================================
// FeishuAdapter
// ============================================================================

export class FeishuAdapter implements BotBridge {
  readonly platform = "feishu";

  private webhookUrl: string;
  private appId?: string;
  private appSecret?: string;
  private messageHandler?: (msg: BotMessage) => void;
  private log: LogFn;

  // Lark SDK instances (dynamically imported)
  private larkClient: unknown = null;
  private wsClient: unknown = null;

  constructor(config: FeishuConfig, log: LogFn) {
    this.webhookUrl = config.webhookUrl;
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.log = log;
  }

  async start(): Promise<void> {
    // Validate outbound config
    if (!this.webhookUrl) {
      this.log(
        "Feishu bot: no webhook URL configured, outbound messages disabled",
      );
    } else {
      this.log(`Feishu bot: outbound via webhook configured`);
    }

    // Start inbound if app credentials provided
    if (this.appId && this.appSecret) {
      await this.startInbound();
    } else {
      this.log(
        "Feishu bot: no app credentials, inbound (IM → Vibecraft) disabled",
      );
    }
  }

  async stop(): Promise<void> {
    // WSClient doesn't expose a stop method in all versions,
    // but setting to null allows GC
    this.wsClient = null;
    this.larkClient = null;
  }

  onMessage(handler: (msg: BotMessage) => void): void {
    this.messageHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Outbound: Vibecraft → IM
  // --------------------------------------------------------------------------

  async sendTaskCompletion(msg: TaskCompletionMessage): Promise<void> {
    if (!this.webhookUrl) return;

    const statusEmoji = msg.status === "completed" ? "✅" : "❌";
    const duration = msg.duration
      ? ` (${Math.round(msg.duration / 1000)}s)`
      : "";

    // Truncate response for IM readability
    const responseText = msg.response
      ? msg.response.length > 800
        ? msg.response.slice(0, 800) + "\n..."
        : msg.response
      : "No response text available.";

    const title = `${statusEmoji} ${msg.sessionName} — Task ${msg.status}${duration}`;
    const promptLine = msg.originalPrompt
      ? `Task: ${msg.originalPrompt.slice(0, 100)}${msg.originalPrompt.length > 100 ? "..." : ""}\n\n`
      : "";

    await this.postWebhook({
      msg_type: "post",
      content: {
        post: {
          zh_cn: {
            title,
            content: [
              [
                {
                  tag: "text",
                  text: `${promptLine}${responseText}`,
                },
              ],
            ],
          },
        },
      },
    });
  }

  async sendStatusUpdate(
    sessionName: string,
    status: string,
    detail?: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const text = detail
      ? `🔄 ${sessionName}: ${status} — ${detail}`
      : `🔄 ${sessionName}: ${status}`;

    await this.sendText(text);
  }

  async sendText(text: string): Promise<void> {
    if (!this.webhookUrl) return;

    await this.postWebhook({
      msg_type: "text",
      content: { text },
    });
  }

  // --------------------------------------------------------------------------
  // Inbound: IM → Vibecraft (via Lark SDK WSClient)
  // --------------------------------------------------------------------------

  private async startInbound(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency if not using inbound
      const Lark = await import("@larksuiteoapi/node-sdk");

      const baseConfig = {
        appId: this.appId!,
        appSecret: this.appSecret!,
      };

      this.larkClient = new Lark.Client(baseConfig);

      const eventDispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: FeishuMessageEvent) => {
          this.handleFeishuMessage(data);
        },
      });

      this.wsClient = new Lark.WSClient({
        ...baseConfig,
        loggerLevel: Lark.LoggerLevel.warn,
      });

      await (this.wsClient as { start: (opts: unknown) => Promise<void> }).start({
        eventDispatcher,
      });

      this.log("Feishu bot: WebSocket inbound connection established");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Feishu bot: failed to start inbound — ${msg}`);
      this.log(
        "Feishu bot: install @larksuiteoapi/node-sdk for inbound support",
      );
    }
  }

  private handleFeishuMessage(data: FeishuMessageEvent): void {
    if (!this.messageHandler) return;

    try {
      const { message, sender } = data;

      // Only handle text messages
      if (message.message_type !== "text") return;

      // Parse content JSON — Feishu wraps text in {"text": "..."}
      let text: string;
      try {
        const parsed = JSON.parse(message.content);
        text = parsed.text || "";
      } catch {
        text = message.content;
      }

      // Strip @mentions from text (Feishu includes @_user_N patterns)
      text = text.replace(/@_user_\d+/g, "").trim();

      if (!text) return;

      this.messageHandler({
        text,
        senderName: sender.sender_id?.open_id || "unknown",
        senderId: sender.sender_id?.open_id || "",
        chatId: message.chat_id,
        messageId: message.message_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Feishu bot: error parsing message — ${msg}`);
    }
  }

  // --------------------------------------------------------------------------
  // Internal: HTTP webhook POST
  // --------------------------------------------------------------------------

  private async postWebhook(body: object): Promise<void> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        this.log(
          `Feishu webhook error: ${response.status} ${response.statusText}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Feishu webhook POST failed: ${msg}`);
    }
  }
}

// ============================================================================
// Feishu Event Types (minimal, for im.message.receive_v1)
// ============================================================================

interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    content: string;
    message_type: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string };
      name: string;
    }>;
  };
}
