/**
 * AgentRegistry — Central registry for agent adapters.
 *
 * Routes session operations to the correct adapter based on agentType.
 * Provides a unified API for managing sessions across all agent frameworks.
 */

import type {
  AgentType,
  ClaudeEvent,
  CreateSessionRequest,
  ManagedSession,
  SessionStatus,
} from "../../shared/types.js";
import type { AgentAdapter } from "./AgentAdapter.js";

export class AgentRegistry {
  private adapters: Map<AgentType, AgentAdapter> = new Map();
  private eventHandlers: Array<(event: ClaudeEvent) => void> = [];

  /** Register an adapter for a specific agent type */
  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.agentType, adapter);
    // Forward events from this adapter to all registry-level handlers
    adapter.onEvent((event: ClaudeEvent) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    });
  }

  /** Get adapter for a specific agent type */
  getAdapter(type: AgentType): AgentAdapter | undefined {
    return this.adapters.get(type);
  }

  /** Get all registered adapters */
  getAllAdapters(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Get all registered agent types */
  getRegisteredTypes(): AgentType[] {
    return Array.from(this.adapters.keys());
  }

  /** Create a session using the appropriate adapter */
  async createSession(config: CreateSessionRequest): Promise<ManagedSession> {
    const agentType = config.agentType || "claude_code";
    const adapter = this.adapters.get(agentType);
    if (!adapter) {
      throw new Error(`No adapter registered for agent type: ${agentType}`);
    }
    return adapter.createSession(config);
  }

  /** Destroy a session using the appropriate adapter */
  async destroySession(session: ManagedSession): Promise<boolean> {
    const adapter = this.adapters.get(session.agentType);
    if (!adapter) {
      throw new Error(
        `No adapter registered for agent type: ${session.agentType}`,
      );
    }
    return adapter.destroySession(session.id);
  }

  /** Restart a session using the appropriate adapter */
  async restartSession(session: ManagedSession): Promise<boolean> {
    const adapter = this.adapters.get(session.agentType);
    if (!adapter) {
      throw new Error(
        `No adapter registered for agent type: ${session.agentType}`,
      );
    }
    return adapter.restartSession(session);
  }

  /** Send a prompt to a session using the appropriate adapter */
  async sendPrompt(
    session: ManagedSession,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapters.get(session.agentType);
    if (!adapter) {
      return {
        ok: false,
        error: `No adapter registered for agent type: ${session.agentType}`,
      };
    }
    return adapter.sendPrompt(session.id, prompt);
  }

  /** Check health of a session using the appropriate adapter */
  async checkHealth(session: ManagedSession): Promise<SessionStatus> {
    const adapter = this.adapters.get(session.agentType);
    if (!adapter) {
      return "offline";
    }
    return adapter.checkHealth(session);
  }

  /** Register a unified event handler across all adapters */
  onEvent(handler: (event: ClaudeEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Get capabilities for a specific agent type */
  getCapabilities(type: AgentType): string[] {
    const adapter = this.adapters.get(type);
    return adapter?.getCapabilities() ?? [];
  }

  /** Get info about all registered agent types */
  getAgentInfo(): Array<{
    type: AgentType;
    capabilities: string[];
  }> {
    return this.getAllAdapters().map((adapter) => ({
      type: adapter.agentType,
      capabilities: adapter.getCapabilities(),
    }));
  }

  /** Dispose all adapters on shutdown */
  async dispose(): Promise<void> {
    const disposePromises = this.getAllAdapters().map((adapter) =>
      adapter.dispose(),
    );
    await Promise.allSettled(disposePromises);
    this.adapters.clear();
    this.eventHandlers = [];
  }
}
