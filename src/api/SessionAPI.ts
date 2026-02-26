/**
 * SessionAPI - Pure API layer for session management
 *
 * All functions are pure HTTP calls with no DOM/state dependencies.
 * UI logic and state updates are handled by the caller (main.ts).
 */

import type {
  AgentType,
  AgentTypeConfig,
  ClaudeMode,
  FileUploadResponse,
  GetSettingsResponse,
  LaunchModeConfig,
  ManagedSession,
  UpdateSettingsRequest,
} from "../../shared/types";

export interface SessionFlags {
  continue?: boolean;
  skipPermissions?: boolean;
  chrome?: boolean;
}

export interface CreateSessionOptions {
  name?: string;
  cwd?: string;
  agentType?: AgentType;
  flags?: SessionFlags;
  mode?: ClaudeMode;
  agentConfig?: Record<string, unknown>;
}

export interface AgentInfo extends AgentTypeConfig {
  type: AgentType;
  capabilities: string[];
}

export interface AgentListResponse {
  ok: boolean;
  agents: AgentInfo[];
}

export interface CreateSessionResponse {
  ok: boolean;
  error?: string;
  session?: ManagedSession;
}

export interface SimpleResponse {
  ok: boolean;
  error?: string;
}

export interface ServerInfoResponse {
  ok: boolean;
  cwd?: string;
  error?: string;
}

/**
 * Create a SessionAPI instance bound to a specific API URL
 */
export function createSessionAPI(apiUrl: string) {
  return {
    /**
     * Create a new managed session
     */
    async createSession(
      name?: string,
      cwd?: string,
      flags?: SessionFlags,
      mode?: ClaudeMode,
      description?: string,
      agentType?: AgentType,
      agentConfig?: Record<string, unknown>,
      launchMode?: LaunchModeConfig,
      llmProvider?: string,
      notificationChannels?: string[],
    ): Promise<CreateSessionResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            cwd,
            flags,
            mode,
            description,
            agentType,
            agentConfig,
            launchMode,
            llmProvider,
            notificationChannels,
          }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error creating session:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Fetch server info (cwd, etc.)
     */
    async getServerInfo(): Promise<ServerInfoResponse> {
      try {
        const response = await fetch(`${apiUrl}/info`);
        return await response.json();
      } catch (e) {
        console.error("Error fetching server info:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Rename a managed session
     */
    async renameSession(
      sessionId: string,
      name: string,
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error renaming session:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Save zone position for a managed session
     */
    async saveZonePosition(
      sessionId: string,
      position: { q: number; r: number },
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zonePosition: position }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error saving zone position:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Delete a managed session
     */
    async deleteSession(sessionId: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}`, {
          method: "DELETE",
        });
        return await response.json();
      } catch (e) {
        console.error("Error deleting session:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Restart an offline session
     */
    async restartSession(sessionId: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(
          `${apiUrl}/sessions/${sessionId}/restart`,
          {
            method: "POST",
          },
        );
        return await response.json();
      } catch (e) {
        console.error("Error restarting session:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Send a prompt to a managed session
     */
    async sendPrompt(
      sessionId: string,
      prompt: string,
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error sending prompt:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Link a Claude session ID to a managed session
     */
    async linkSession(
      managedId: string,
      claudeSessionId: string,
    ): Promise<void> {
      try {
        await fetch(`${apiUrl}/sessions/${managedId}/link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claudeSessionId }),
        });
      } catch (e) {
        console.error("Failed to link session on server:", e);
      }
    },

    /**
     * Switch a session's Claude Code mode
     */
    async switchMode(
      sessionId: string,
      mode: ClaudeMode,
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}/mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error switching mode:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Trigger a health check / refresh of all sessions
     */
    async refreshSessions(): Promise<void> {
      try {
        await fetch(`${apiUrl}/sessions/refresh`, { method: "POST" });
      } catch (e) {
        console.error("Error refreshing sessions:", e);
      }
    },

    /**
     * Create a zone group from two or more managed session IDs
     */
    async createGroup(
      memberSessionIds: string[],
      name?: string,
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberSessionIds, name }),
        });
        return await response.json();
      } catch (e) {
        console.error("Error creating group:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Update a zone group (add/remove members, rename, recolor)
     */
    async updateGroup(
      groupId: string,
      updates: {
        name?: string;
        addMembers?: string[];
        removeMembers?: string[];
        color?: string;
      },
    ): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/groups/${groupId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        return await response.json();
      } catch (e) {
        console.error("Error updating group:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Get all registered agent types and their capabilities
     */
    async getAgents(): Promise<AgentListResponse> {
      try {
        const response = await fetch(`${apiUrl}/agents`);
        return await response.json();
      } catch (e) {
        console.error("Error fetching agents:", e);
        return { ok: false, agents: [] };
      }
    },

    /**
     * Upload files to the server
     */
    async uploadFiles(files: File[]): Promise<FileUploadResponse> {
      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        const response = await fetch(`${apiUrl}/upload`, {
          method: "POST",
          body: formData,
        });
        return await response.json();
      } catch (e) {
        console.error("Error uploading files:", e);
        return { ok: false, error: "Upload failed" };
      }
    },

    /**
     * Dissolve a zone group
     */
    async deleteGroup(groupId: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(`${apiUrl}/groups/${groupId}`, {
          method: "DELETE",
        });
        return await response.json();
      } catch (e) {
        console.error("Error deleting group:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Get agent provider settings (redacted — no API keys)
     */
    async getSettings(): Promise<GetSettingsResponse> {
      try {
        const response = await fetch(`${apiUrl}/settings`);
        return await response.json();
      } catch (e) {
        console.error("Error fetching settings:", e);
        return {
          ok: false,
          settings: { llmProviders: {}, notificationChannels: {} },
        };
      }
    },

    /**
     * Update agent provider settings (partial merge)
     */
    async updateSettings(
      updates: UpdateSettingsRequest,
    ): Promise<GetSettingsResponse> {
      try {
        const response = await fetch(`${apiUrl}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        return await response.json();
      } catch (e) {
        console.error("Error updating settings:", e);
        return {
          ok: false,
          settings: { llmProviders: {}, notificationChannels: {} },
        };
      }
    },

    /**
     * Send a test notification to a specific channel
     */
    async testNotification(channelName: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(
          `${apiUrl}/settings/test-notification/${encodeURIComponent(channelName)}`,
          { method: "POST" },
        );
        return await response.json();
      } catch (e) {
        console.error("Error testing notification:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Delete an LLM provider
     */
    async deleteLLMProvider(name: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(
          `${apiUrl}/settings/llm/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        return await response.json();
      } catch (e) {
        console.error("Error deleting LLM provider:", e);
        return { ok: false, error: "Network error" };
      }
    },

    /**
     * Delete a notification channel
     */
    async deleteNotificationChannel(name: string): Promise<SimpleResponse> {
      try {
        const response = await fetch(
          `${apiUrl}/settings/notification/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        return await response.json();
      } catch (e) {
        console.error("Error deleting notification channel:", e);
        return { ok: false, error: "Network error" };
      }
    },
  };
}

export type SessionAPI = ReturnType<typeof createSessionAPI>;
