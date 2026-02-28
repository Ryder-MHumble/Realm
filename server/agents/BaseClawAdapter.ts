/**
 * BaseClawAdapter — Abstract base for non-Claude agent adapters.
 *
 * Provides shared infrastructure for NanoClaw, ZeroClaw, OpenClaw, etc:
 * - Unified process/container/gateway lifecycle (ProcessHandle)
 * - Launch mode dispatching (local, docker, gateway)
 * - LLM config resolution via SettingsManager
 * - Event emission helpers
 */

import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import type {
  AgentType,
  ClaudeEvent,
  CreateSessionRequest,
  LLMProviderConfig,
  LaunchModeConfig,
  ManagedSession,
  SessionStartEvent,
  SessionStatus,
} from "../../shared/types.js";
import type { AgentAdapter } from "./AgentAdapter.js";

// ============================================================================
// ProcessHandle — Unified handle for child process, Docker, or gateway
// ============================================================================

export interface ProcessHandle {
  kind: "process" | "docker" | "gateway";
  /** Child process (for local/docker) */
  process?: ChildProcess;
  /** Container name (for docker) */
  containerId?: string;
  /** Gateway session endpoint (for gateway) */
  gatewayEndpoint?: string;
  /** Gateway auth token */
  gatewayToken?: string;
  /** Kill the underlying process/container */
  kill(): void;
}

// ============================================================================
// SettingsProvider — Injected from server to resolve LLM configs
// ============================================================================

export interface SettingsProvider {
  getLLMProvider(name: string): LLMProviderConfig | undefined;
}

// ============================================================================
// BaseClawAdapter
// ============================================================================

export abstract class BaseClawAdapter implements AgentAdapter {
  abstract readonly agentType: AgentType;
  protected eventHandlers: Array<(event: ClaudeEvent) => void> = [];
  protected handles: Map<string, ProcessHandle> = new Map();
  protected log: (...args: unknown[]) => void;
  private settingsProvider: SettingsProvider | null = null;

  constructor(logFn?: (...args: unknown[]) => void) {
    this.log = logFn || console.log;
  }

  /** Inject settings provider for LLM config resolution */
  setSettingsProvider(provider: SettingsProvider): void {
    this.settingsProvider = provider;
  }

  // --------------------------------------------------------------------------
  // Abstract: subclasses implement these for agent-specific logic
  // --------------------------------------------------------------------------

  /** Spawn the agent locally (child_process) */
  protected abstract launchLocal(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
    env: Record<string, string>,
  ): Promise<ProcessHandle>;

  /** Spawn the agent in Docker/Apple Container */
  protected abstract launchDocker(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
    env: Record<string, string>,
  ): Promise<ProcessHandle>;

  /** Connect to a remote gateway */
  protected abstract launchGateway(
    id: string,
    config: CreateSessionRequest,
    launchMode: LaunchModeConfig,
  ): Promise<ProcessHandle>;

  /** Get capabilities for this agent type */
  abstract getCapabilities(): string[];

  /** Get the display label for this agent type */
  protected abstract getLabel(): string;

  // --------------------------------------------------------------------------
  // Shared: LLM env var construction
  // --------------------------------------------------------------------------

  /** Build environment variables from LLM provider config */
  protected buildLLMEnv(providerName?: string): Record<string, string> {
    if (!providerName || !this.settingsProvider) return {};
    const llm = this.settingsProvider.getLLMProvider(providerName);
    if (!llm) return {};

    const env: Record<string, string> = {};
    if (llm.apiKey) env.LLM_API_KEY = llm.apiKey;
    if (llm.model) env.LLM_MODEL = llm.model;
    if (llm.baseUrl) env.LLM_BASE_URL = llm.baseUrl;
    if (llm.provider) env.LLM_PROVIDER = llm.provider;
    if (llm.maxTokens) env.LLM_MAX_TOKENS = String(llm.maxTokens);
    return env;
  }

  // --------------------------------------------------------------------------
  // Lifecycle: createSession, destroySession, restartSession
  // --------------------------------------------------------------------------

  async createSession(config: CreateSessionRequest): Promise<ManagedSession> {
    const id = randomUUID();
    const label = this.getLabel();
    const name = config.name || `${label} ${id.slice(0, 4)}`;
    const cwd = config.cwd || process.cwd();
    const launchMode: LaunchModeConfig = config.launchMode || { mode: "local" };

    // Resolve LLM env
    const llmEnv = this.buildLLMEnv(config.llmProvider);
    const env: Record<string, string> = {
      ...llmEnv,
      ...(launchMode.dockerEnv || {}),
    };

    // Dispatch based on launch mode
    let handle: ProcessHandle;
    switch (launchMode.mode) {
      case "docker":
        handle = await this.launchDocker(id, config, launchMode, env);
        break;
      case "gateway":
        handle = await this.launchGateway(id, config, launchMode);
        break;
      case "local":
      default:
        handle = await this.launchLocal(id, config, launchMode, env);
        break;
    }

    this.handles.set(id, handle);

    const processId = handle.containerId || handle.gatewayEndpoint || `${this.agentType}-${id.slice(0, 8)}`;

    const session: ManagedSession = {
      id,
      name,
      agentType: this.agentType,
      tmuxSession: processId,
      status: "idle",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cwd,
      agentConfig: config.agentConfig,
      capabilities: this.getCapabilities(),
      launchMode,
      llmProvider: config.llmProvider,
    };

    this.log(`Created ${label} session: ${name} (${id.slice(0, 8)}) [${launchMode.mode}]`);

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
    const handle = this.handles.get(sessionId);
    if (handle) {
      handle.kill();
      this.handles.delete(sessionId);
    }
    this.log(`Destroyed ${this.getLabel()} session: ${sessionId.slice(0, 8)}`);
    return true;
  }

  async restartSession(session: ManagedSession): Promise<boolean> {
    await this.destroySession(session.id);
    // Re-create with same config
    const newSession = await this.createSession({
      name: session.name,
      cwd: session.cwd,
      agentType: session.agentType,
      agentConfig: session.agentConfig as Record<string, unknown>,
      launchMode: session.launchMode,
      llmProvider: session.llmProvider,
    });
    // Transfer handle to original ID
    const newHandle = this.handles.get(newSession.id);
    if (newHandle) {
      this.handles.delete(newSession.id);
      this.handles.set(session.id, newHandle);
    }
    this.log(`Restarted ${this.getLabel()} session: ${session.name}`);
    return true;
  }

  // --------------------------------------------------------------------------
  // Prompt delivery & health
  // --------------------------------------------------------------------------

  async sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const handle = this.handles.get(sessionId);
    if (!handle) return { ok: false, error: "Session not found" };

    if (handle.kind === "gateway" && handle.gatewayEndpoint) {
      // Send via gateway HTTP API
      try {
        const resp = await fetch(`${handle.gatewayEndpoint}/prompt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(handle.gatewayToken ? { Authorization: `Bearer ${handle.gatewayToken}` } : {}),
          },
          body: JSON.stringify({ prompt }),
        });
        if (!resp.ok) return { ok: false, error: `Gateway ${resp.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    if (handle.kind === "process" && handle.process?.stdin) {
      // Send via stdin
      handle.process.stdin.write(prompt + "\n");
      return { ok: true };
    }

    // Fallback: emit event for display purposes
    this.log(`[${this.getLabel()}] Prompt to ${sessionId.slice(0, 8)}: ${prompt.slice(0, 50)}...`);
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
    const handle = this.handles.get(session.id);
    if (!handle) return "offline";

    if (handle.kind === "process" && handle.process?.killed) {
      return "offline";
    }

    if (handle.kind === "gateway" && handle.gatewayEndpoint) {
      try {
        const resp = await fetch(`${handle.gatewayEndpoint}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        return resp.ok ? session.status : "offline";
      } catch {
        return "offline";
      }
    }

    return session.status;
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  onEvent(handler: (event: ClaudeEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  protected emitEvent(event: ClaudeEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  /** Attach stdout/stderr event capture for a child process */
  protected attachEventCapture(sessionId: string, child: ChildProcess): void {
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ClaudeEvent;
          if (event.type) {
            event.sessionId = sessionId;
            this.emitEvent(event);
          }
        } catch {
          // Not JSON — regular stdout, ignore
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      this.log(`[${this.getLabel()}:${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`);
    });

    child.on("exit", (code) => {
      this.log(`[${this.getLabel()}:${sessionId.slice(0, 8)}] exited with code ${code}`);
      this.handles.delete(sessionId);
    });
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  async dispose(): Promise<void> {
    for (const [, handle] of this.handles) {
      handle.kill();
    }
    this.handles.clear();
    this.eventHandlers = [];
  }
}
