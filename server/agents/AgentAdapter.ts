/**
 * AgentAdapter — Platform-agnostic interface for AI agent lifecycle management.
 *
 * Each agent framework (Claude Code, NanoClaw, ZeroClaw, OpenClaw) implements
 * this interface to provide unified session management through Realm.
 */

import type {
  AgentType,
  ClaudeEvent,
  CreateSessionRequest,
  ManagedSession,
  SessionStatus,
} from "../../shared/types.js";

export interface AgentAdapter {
  /** Agent type this adapter handles */
  readonly agentType: AgentType;

  /** Create and start a new agent session */
  createSession(config: CreateSessionRequest): Promise<ManagedSession>;

  /** Stop and destroy an agent session */
  destroySession(sessionId: string): Promise<boolean>;

  /** Restart a stopped/offline agent session */
  restartSession(session: ManagedSession): Promise<boolean>;

  /** Send a prompt/task to the agent */
  sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Check if a session is still alive and return its status */
  checkHealth(session: ManagedSession): Promise<SessionStatus>;

  /** Get capabilities supported by this agent type */
  getCapabilities(): string[];

  /** Register event listener for normalized agent events */
  onEvent(handler: (event: ClaudeEvent) => void): void;

  /** Clean up all resources on server shutdown */
  dispose(): Promise<void>;
}
