/**
 * ZeroClawAdapter — Agent adapter for ZeroClaw instances.
 *
 * ZeroClaw is an ultra-lightweight Rust-based AI agent runtime (~3.4MB binary)
 * with 13 pluggable traits for providers, channels, memory, tools, etc.
 *
 * Integration strategy:
 * - Process management: run ZeroClaw binary directly
 * - Event capture: via observability trait or stdout parsing
 * - Task dispatch: via channel interface or API endpoint
 */

import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import type {
  ClaudeEvent,
  CreateSessionRequest,
  ManagedSession,
  SessionStatus,
  SessionStartEvent,
} from "../../shared/types.js";
import type { AgentAdapter } from "./AgentAdapter.js";

export interface ZeroClawConfig {
  /** Path to ZeroClaw binary */
  binaryPath?: string;
  /** Config file path for ZeroClaw */
  configPath?: string;
  /** Provider to use (e.g., "claude", "deepseek", "openai") */
  provider?: string;
  /** Channel to use for communication */
  channel?: string;
}

export class ZeroClawAdapter implements AgentAdapter {
  readonly agentType = "zeroclaw" as const;
  private eventHandlers: Array<(event: ClaudeEvent) => void> = [];
  private processes: Map<string, ChildProcess> = new Map();
  private log: (...args: unknown[]) => void;

  constructor(
    private config: ZeroClawConfig = {},
    logFn?: (...args: unknown[]) => void,
  ) {
    this.log = logFn || console.log;
  }

  async createSession(config: CreateSessionRequest): Promise<ManagedSession> {
    const id = randomUUID();
    const name = config.name || `ZeroClaw ${id.slice(0, 4)}`;
    const agentConfig = (config.agentConfig || {}) as ZeroClawConfig;
    const cwd = config.cwd || process.cwd();

    // TODO: Implement actual ZeroClaw binary spawning
    const processId = `zeroclaw-${id.slice(0, 8)}`;

    const session: ManagedSession = {
      id,
      name,
      agentType: "zeroclaw",
      tmuxSession: processId, // Process identifier
      status: "idle",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cwd,
      agentConfig: {
        ...this.config,
        ...agentConfig,
      },
      capabilities: this.getCapabilities(),
    };

    this.log(`Created ZeroClaw session: ${name} (${id.slice(0, 8)})`);

    // Emit session start event
    this.emitEvent({
      id: randomUUID(),
      timestamp: Date.now(),
      type: "session_start",
      sessionId: id,
      cwd,
      source: "startup",
    } as SessionStartEvent);

    return session;
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const process = this.processes.get(sessionId);
    if (process) {
      process.kill("SIGTERM");
      this.processes.delete(sessionId);
    }
    this.log(`Destroyed ZeroClaw session: ${sessionId.slice(0, 8)}`);
    return true;
  }

  async restartSession(session: ManagedSession): Promise<boolean> {
    await this.destroySession(session.id);
    // TODO: Respawn the ZeroClaw binary
    this.log(`Restarted ZeroClaw session: ${session.name}`);
    return true;
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // TODO: Implement actual prompt delivery to ZeroClaw
    // Options:
    // 1. Send via ZeroClaw's channel interface
    // 2. Write to ZeroClaw's stdin
    // 3. Use ZeroClaw's HTTP/WebSocket API
    this.log(
      `[ZeroClaw] Sending prompt to ${sessionId.slice(0, 8)}: ${prompt.slice(0, 50)}...`,
    );

    // Emit a user prompt event
    this.emitEvent({
      id: randomUUID(),
      timestamp: Date.now(),
      type: "user_prompt_submit",
      sessionId,
      cwd: "",
      prompt,
    });

    return { ok: true };
  }

  async checkHealth(session: ManagedSession): Promise<SessionStatus> {
    const process = this.processes.get(session.id);
    if (!process || process.killed) {
      return "offline";
    }
    return session.status;
  }

  getCapabilities(): string[] {
    return [
      "tool_use",
      "multi_provider",
      "multi_channel",
      "edge_deployment",
      "low_memory",
      "sandboxed_execution",
      "tunnel_support",
    ];
  }

  onEvent(handler: (event: ClaudeEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  private emitEvent(event: ClaudeEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  async dispose(): Promise<void> {
    for (const [id, proc] of this.processes) {
      proc.kill("SIGTERM");
    }
    this.processes.clear();
    this.eventHandlers = [];
  }
}
