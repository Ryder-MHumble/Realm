/**
 * DingTalkAdapter — DingTalk/钉钉 bot integration.
 *
 * Outbound: Custom robot webhook with optional HMAC-SHA256 signing.
 * Inbound: Not yet implemented (DingTalk Stream API or outgoing webhook).
 */

import { createHmac } from "crypto";
import type { BotBridge, BotMessage, TaskCompletionMessage } from "./BotBridge.js";

// ============================================================================
// Types
// ============================================================================

export interface DingTalkConfig {
  /** Webhook URL for outbound messages */
  webhookUrl: string;
  /** Secret for HMAC-SHA256 signature (optional, for security verification) */
  secret?: string;
}

type LogFn = (msg: string) => void;

// ============================================================================
// DingTalkAdapter
// ============================================================================

export class DingTalkAdapter implements BotBridge {
  readonly platform = "dingtalk";

  private webhookUrl: string;
  private secret?: string;
  private messageHandler?: (msg: BotMessage) => void;
  private log: LogFn;

  constructor(config: DingTalkConfig, log: LogFn) {
    this.webhookUrl = config.webhookUrl;
    this.secret = config.secret;
    this.log = log;
  }

  async start(): Promise<void> {
    if (!this.webhookUrl) {
      this.log("DingTalk bot: no webhook URL configured");
    } else {
      this.log("DingTalk bot: outbound via webhook configured");
    }
  }

  async stop(): Promise<void> {
    // No persistent connections to clean up
  }

  onMessage(handler: (msg: BotMessage) => void): void {
    this.messageHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Outbound: Vibecraft → DingTalk
  // --------------------------------------------------------------------------

  async sendTaskCompletion(msg: TaskCompletionMessage): Promise<void> {
    if (!this.webhookUrl) return;

    const statusEmoji = msg.status === "completed" ? "✅" : "❌";
    const duration = msg.duration
      ? ` (${Math.round(msg.duration / 1000)}s)`
      : "";

    const responseText = msg.response
      ? msg.response.length > 800
        ? msg.response.slice(0, 800) + "\n..."
        : msg.response
      : "No response text available.";

    const title = `${statusEmoji} ${msg.sessionName} — Task ${msg.status}${duration}`;
    const promptLine = msg.originalPrompt
      ? `**Task:** ${msg.originalPrompt.slice(0, 100)}${msg.originalPrompt.length > 100 ? "..." : ""}\n\n`
      : "";

    await this.postWebhook({
      msgtype: "markdown",
      markdown: {
        title,
        text: `### ${title}\n\n${promptLine}${responseText}`,
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
      msgtype: "text",
      text: { content: text },
    });
  }

  // --------------------------------------------------------------------------
  // Internal: HTTP webhook POST with optional signing
  // --------------------------------------------------------------------------

  private getSignedUrl(): string {
    if (!this.secret) return this.webhookUrl;

    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${this.secret}`;
    const sign = createHmac("sha256", this.secret)
      .update(stringToSign)
      .digest("base64");

    const separator = this.webhookUrl.includes("?") ? "&" : "?";
    return `${this.webhookUrl}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  private async postWebhook(body: object): Promise<void> {
    try {
      const url = this.getSignedUrl();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        this.log(
          `DingTalk webhook error: ${response.status} ${response.statusText}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`DingTalk webhook POST failed: ${msg}`);
    }
  }
}
