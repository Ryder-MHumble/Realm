/**
 * Notification Manager
 *
 * Multi-channel notification orchestrator.
 * Manages multiple BotBridge instances and routes notifications
 * to the appropriate channels per session configuration.
 */

import type { BotBridge, TaskCompletionMessage } from "./BotBridge.js";
import type {
  AgentProviderSettings,
  ManagedSession,
  NotificationChannelConfig,
} from "../../shared/types.js";

export class NotificationManager {
  private bridges: Map<string, BotBridge> = new Map();
  private settingsProvider: () => AgentProviderSettings;
  private bridgeFactory: (channel: NotificationChannelConfig) => BotBridge | null;
  private log: (msg: string) => void;

  constructor(
    settingsProvider: () => AgentProviderSettings,
    bridgeFactory: (channel: NotificationChannelConfig) => BotBridge | null,
    log: (msg: string) => void,
  ) {
    this.settingsProvider = settingsProvider;
    this.bridgeFactory = bridgeFactory;
    this.log = log;
  }

  /** Initialize all enabled notification channels */
  async start(): Promise<void> {
    const settings = this.settingsProvider();
    for (const [name, channel] of Object.entries(settings.notificationChannels)) {
      if (!channel.enabled) continue;
      try {
        const bridge = this.bridgeFactory(channel);
        if (bridge) {
          await bridge.start();
          this.bridges.set(name, bridge);
          this.log(`Notification channel started: ${name} (${channel.platform})`);
        }
      } catch (e) {
        this.log(`Failed to start notification channel ${name}: ${e}`);
      }
    }
  }

  /** Send notification to session's configured channels */
  async notifySession(
    session: ManagedSession,
    msg: TaskCompletionMessage,
  ): Promise<void> {
    const channelNames = session.notificationChannels;
    const targets =
      channelNames && channelNames.length > 0
        ? channelNames
        : Array.from(this.bridges.keys());

    for (const name of targets) {
      const bridge = this.bridges.get(name);
      if (bridge) {
        bridge
          .sendTaskCompletion(msg)
          .catch((e) => this.log(`Notification error [${name}]: ${e}`));
      }
    }
  }

  /** Send status update to session's configured channels */
  async notifyStatus(
    session: ManagedSession,
    status: string,
    detail?: string,
  ): Promise<void> {
    const channelNames = session.notificationChannels;
    const targets =
      channelNames && channelNames.length > 0
        ? channelNames
        : Array.from(this.bridges.keys());

    for (const name of targets) {
      const bridge = this.bridges.get(name);
      if (bridge) {
        bridge
          .sendStatusUpdate(session.name, status, detail)
          .catch((e) => this.log(`Status notify error [${name}]: ${e}`));
      }
    }
  }

  /** Send test notification to a specific channel */
  async testChannel(name: string): Promise<boolean> {
    const bridge = this.bridges.get(name);
    if (!bridge) return false;
    try {
      await bridge.sendText(
        `[Vibecraft] Test notification — ${new Date().toISOString()}`,
      );
      return true;
    } catch (e) {
      this.log(`Test notification failed [${name}]: ${e}`);
      return false;
    }
  }

  /** Reinitialize channels (after settings change) */
  async reinitialize(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop all channels */
  async stop(): Promise<void> {
    for (const [name, bridge] of this.bridges) {
      try {
        await bridge.stop();
      } catch (e) {
        this.log(`Failed to stop channel ${name}: ${e}`);
      }
    }
    this.bridges.clear();
  }

  /** Check if any channels are active */
  hasActiveChannels(): boolean {
    return this.bridges.size > 0;
  }
}
