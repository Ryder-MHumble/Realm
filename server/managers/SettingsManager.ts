/**
 * Settings Manager
 *
 * Manages agent provider settings: LLM providers and notification channels.
 * Follows the TilesManager pattern: JSON file persistence + WebSocket broadcast.
 * API keys are stored server-side only; clients receive redacted versions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  AgentProviderSettings,
  AgentProviderSettingsRedacted,
  AutoCompactSettings,
  AutoContinueSettings,
  LLMProviderConfig,
  LLMProviderConfigRedacted,
  NotificationChannelConfig,
  ServerMessage,
  UpdateSettingsRequest,
} from "../../shared/types.js";
import { log, debug } from "../logger.js";

const EMPTY_SETTINGS: AgentProviderSettings = {
  llmProviders: {},
  defaultProvider: undefined,
  notificationChannels: {},
};

export class SettingsManager {
  private settings: AgentProviderSettings = { ...EMPTY_SETTINGS };
  private filePath: string;
  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private changeListeners: Array<() => void> = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  /** Register a listener called after every settings change */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /** Load settings from disk */
  load(): void {
    if (!existsSync(this.filePath)) {
      debug("No saved settings file found, using defaults");
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content) as AgentProviderSettings;

      this.settings = {
        llmProviders: data.llmProviders || {},
        defaultProvider: data.defaultProvider,
        notificationChannels: data.notificationChannels || {},
        autoCompact: data.autoCompact,
        autoContinue: data.autoContinue,
      };

      const providerCount = Object.keys(this.settings.llmProviders).length;
      const channelCount = Object.keys(
        this.settings.notificationChannels,
      ).length;
      log(
        `Loaded settings: ${providerCount} LLM providers, ${channelCount} notification channels`,
      );
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }

  /** Get full settings (server-side use only — contains API keys) */
  getSettings(): AgentProviderSettings {
    return this.settings;
  }

  /** Get redacted settings for client (API keys masked) */
  getRedactedSettings(): AgentProviderSettingsRedacted {
    const redactedProviders: Record<string, LLMProviderConfigRedacted> = {};

    for (const [name, config] of Object.entries(this.settings.llmProviders)) {
      redactedProviders[name] = {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        maxTokens: config.maxTokens,
        hasApiKey: !!config.apiKey,
      };
    }

    return {
      llmProviders: redactedProviders,
      defaultProvider: this.settings.defaultProvider,
      notificationChannels: this.settings.notificationChannels,
      autoCompact: this.settings.autoCompact,
      autoContinue: this.settings.autoContinue,
    };
  }

  /** Update settings (partial merge) */
  updateSettings(updates: UpdateSettingsRequest): void {
    if (updates.llmProviders) {
      for (const [name, config] of Object.entries(updates.llmProviders)) {
        // If apiKey is empty string, keep existing key
        if (config.apiKey === "" && this.settings.llmProviders[name]?.apiKey) {
          config.apiKey = this.settings.llmProviders[name].apiKey;
        }
        this.settings.llmProviders[name] = config;
      }
    }

    if (updates.defaultProvider !== undefined) {
      this.settings.defaultProvider = updates.defaultProvider;
    }

    if (updates.notificationChannels) {
      for (const [name, config] of Object.entries(
        updates.notificationChannels,
      )) {
        this.settings.notificationChannels[name] = config;
      }
    }

    if (updates.autoCompact) {
      this.settings.autoCompact = {
        ...(this.settings.autoCompact || {
          enabled: false,
          threshold: 150_000,
          cooldownSeconds: 120,
        }),
        ...updates.autoCompact,
      };
    }

    if (updates.autoContinue) {
      this.settings.autoContinue = {
        ...(this.settings.autoContinue || {
          enabled: false,
          maxRetries: 3,
          cooldownSeconds: 5,
          continuePrompt: "continue",
        }),
        ...updates.autoContinue,
      };
    }

    this.save();
    this.broadcastSettings();
    log("Settings updated");
  }

  /** Replace all settings */
  replaceSettings(settings: UpdateSettingsRequest): void {
    if (settings.llmProviders !== undefined) {
      // Preserve existing API keys if new value is empty
      for (const [name, config] of Object.entries(settings.llmProviders)) {
        if (config.apiKey === "" && this.settings.llmProviders[name]?.apiKey) {
          config.apiKey = this.settings.llmProviders[name].apiKey;
        }
      }
      this.settings.llmProviders = settings.llmProviders;
    }

    if (settings.defaultProvider !== undefined) {
      this.settings.defaultProvider = settings.defaultProvider;
    }

    if (settings.notificationChannels !== undefined) {
      this.settings.notificationChannels = settings.notificationChannels;
    }

    if (settings.autoCompact !== undefined) {
      this.settings.autoCompact = {
        ...(this.settings.autoCompact || {
          enabled: false,
          threshold: 150_000,
          cooldownSeconds: 120,
        }),
        ...settings.autoCompact,
      };
    }

    if (settings.autoContinue !== undefined) {
      this.settings.autoContinue = {
        ...(this.settings.autoContinue || {
          enabled: false,
          maxRetries: 3,
          cooldownSeconds: 5,
          continuePrompt: "continue",
        }),
        ...settings.autoContinue,
      };
    }

    this.save();
    this.broadcastSettings();
    log("Settings replaced");
  }

  /** Delete an LLM provider */
  deleteLLMProvider(name: string): boolean {
    if (!this.settings.llmProviders[name]) return false;
    delete this.settings.llmProviders[name];
    if (this.settings.defaultProvider === name) {
      this.settings.defaultProvider = undefined;
    }
    this.save();
    this.broadcastSettings();
    log(`Deleted LLM provider: ${name}`);
    return true;
  }

  /** Delete a notification channel */
  deleteNotificationChannel(name: string): boolean {
    if (!this.settings.notificationChannels[name]) return false;
    delete this.settings.notificationChannels[name];
    this.save();
    this.broadcastSettings();
    log(`Deleted notification channel: ${name}`);
    return true;
  }

  /** Get a specific LLM provider config (with real API key, for server-side use) */
  getLLMProvider(name: string): LLMProviderConfig | undefined {
    return this.settings.llmProviders[name];
  }

  /** Get a specific notification channel config */
  getNotificationChannel(name: string): NotificationChannelConfig | undefined {
    return this.settings.notificationChannels[name];
  }

  /** Get auto-compact settings */
  getAutoCompact(): AutoCompactSettings | undefined {
    return this.settings.autoCompact;
  }

  /** Get auto-continue settings */
  getAutoContinue(): AutoContinueSettings | undefined {
    return this.settings.autoContinue;
  }

  /** Get all enabled notification channels */
  getEnabledChannels(): Record<string, NotificationChannelConfig> {
    const result: Record<string, NotificationChannelConfig> = {};
    for (const [name, channel] of Object.entries(
      this.settings.notificationChannels,
    )) {
      if (channel.enabled) result[name] = channel;
    }
    return result;
  }

  /** Save settings to disk */
  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2));
      debug(`Saved settings to ${this.filePath}`);
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  /** Broadcast redacted settings to all clients */
  private broadcastSettings(): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: "settings_update",
        payload: this.getRedactedSettings(),
      });
    }
    // Notify change listeners
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }
}
