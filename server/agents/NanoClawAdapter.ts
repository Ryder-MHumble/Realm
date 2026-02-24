/**
 * NanoClawAdapter — Agent adapter for NanoClaw instances.
 *
 * NanoClaw is a lightweight (~500 lines) TypeScript AI agent that runs
 * in containers (Docker/Apple Container) using Anthropic's Agent SDK.
 *
 * Integration strategy:
 * - Process management via Docker API or child_process
 * - Event capture via stdout/log monitoring or SQLite polling
 * - Task dispatch via NanoClaw's messaging interface
 */

import { execFile, ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import type {
  ClaudeEvent,
  CreateSessionRequest,
  ManagedSession,
  SessionStatus,
  PreToolUseEvent,
  PostToolUseEvent,
  StopEvent,
  SessionStartEvent,
} from "../../shared/types.js";
import type { AgentAdapter } from "./AgentAdapter.js";

export interface NanoClawConfig {
  /** Path to NanoClaw project directory */
  projectDir?: string;
  /** Docker image name (if using Docker) */
  dockerImage?: string;
  /** Use Apple Container instead of Docker */
  useAppleContainer?: boolean;
}

export class NanoClawAdapter implements AgentAdapter {
  readonly agentType = "nanoclaw" as const;
  private eventHandlers: Array<(event: ClaudeEvent) => void> = [];
  private processes: Map<string, ChildProcess> = new Map();
  private log: (...args: unknown[]) => void;

  constructor(
    private config: NanoClawConfig = {},
    logFn?: (...args: unknown[]) => void,
  ) {
    this.log = logFn || console.log;
  }

  async createSession(config: CreateSessionRequest): Promise<ManagedSession> {
    const id = randomUUID();
    const name = config.name || `NanoClaw ${id.slice(0, 4)}`;
    const agentConfig = (config.agentConfig || {}) as NanoClawConfig;
    const cwd = config.cwd || process.cwd();

    // TODO: Implement actual NanoClaw container/process spawning
    // For now, create a session entry that can be managed
    const processId = `nanoclaw-${id.slice(0, 8)}`;

    const session: ManagedSession = {
      id,
      name,
      agentType: "nanoclaw",
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

    this.log(`Created NanoClaw session: ${name} (${id.slice(0, 8)})`);

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
    this.log(`Destroyed NanoClaw session: ${sessionId.slice(0, 8)}`);
    return true;
  }

  async restartSession(session: ManagedSession): Promise<boolean> {
    await this.destroySession(session.id);
    // TODO: Respawn the NanoClaw process/container
    this.log(`Restarted NanoClaw session: ${session.name}`);
    return true;
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // TODO: Implement actual prompt delivery to NanoClaw
    // Options:
    // 1. Write to NanoClaw's message queue (SQLite)
    // 2. Send via NanoClaw's API endpoint
    // 3. Write to stdin of the NanoClaw process
    this.log(
      `[NanoClaw] Sending prompt to ${sessionId.slice(0, 8)}: ${prompt.slice(0, 50)}...`,
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
      "container_isolation",
      "agent_swarms",
      "messaging",
      "scheduled_tasks",
      "skills",
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
    // Kill all managed processes
    for (const [id, proc] of this.processes) {
      proc.kill("SIGTERM");
    }
    this.processes.clear();
    this.eventHandlers = [];
  }
}
