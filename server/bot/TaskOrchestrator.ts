/**
 * TaskOrchestrator
 *
 * Receives inbound IM messages, uses an LLM to decompose the request into
 * sub-tasks, dispatches each to a matching session (auto-creating if needed),
 * sends an immediate "working" acknowledgement, and reports back when done.
 */

import { basename } from "path";
import type {
  BotBridge,
  BotMessage,
  TaskCompletionMessage,
} from "./BotBridge.js";
import type {
  ManagedSession,
  AgentProviderSettings,
  LLMProviderConfig,
  AgentType,
} from "../../shared/types.js";
import type { KnownProject } from "../ProjectsManager.js";
import { log } from "../logger.js";

// ============================================================================
// Types
// ============================================================================

interface SubTask {
  sessionHint: string;
  prompt: string;
  createIfMissing: boolean;
  projectPath?: string;
}

interface PendingTask {
  taskGroupId: string;
  sessionId: string;
  sessionName: string;
  originalMessage: string;
  subtaskPrompt: string;
  startTime: number;
  /** For IM-dispatched tasks: which bridge to reply on */
  bridgeName?: string;
  chatId?: string;
  /** For API-dispatched tasks: URL to POST results to */
  callbackUrl?: string;
}

interface TaskGroupState {
  id: string;
  originalMessage: string;
  totalTasks: number;
  results: Array<{ sessionName: string; response: string }>;
  startTime: number;
  /** IM bridge key (for IM-triggered dispatch) */
  bridgeName?: string;
  chatId?: string;
  /** Callback URL (for API-triggered dispatch) */
  callbackUrl?: string;
}

/** Result sent to callbackUrl when all tasks in a group complete */
export interface DispatchCallbackPayload {
  taskGroupId: string;
  originalMessage: string;
  results: Array<{ sessionName: string; response: string }>;
  durationMs: number;
}

/** Return value from dispatchTask() */
export interface DispatchResult {
  ok: boolean;
  taskGroupId: string;
  dispatched: Array<{ sessionId: string; sessionName: string; prompt: string }>;
  error?: string;
}

export interface OrchestratorDeps {
  /** Get current settings (for LLM provider config) */
  getSettings: () => AgentProviderSettings;
  /** Get all managed sessions */
  getSessions: () => ManagedSession[];
  /** Get all known projects */
  getProjects: () => KnownProject[];
  /** Create a new session */
  createSession: (options: {
    name: string;
    cwd: string;
    agentType?: AgentType;
  }) => Promise<ManagedSession>;
  /** Send a prompt to a session by its managed ID */
  sendPrompt: (
    sessionId: string,
    prompt: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Get a bot bridge by name */
  getBridge: (name: string) => BotBridge | undefined;
}

// ============================================================================
// TaskOrchestrator
// ============================================================================

export class TaskOrchestrator {
  private pendingTasks = new Map<string, PendingTask>(); // managedSessionId → task
  private taskGroups = new Map<string, TaskGroupState>(); // taskGroupId → group

  constructor(private deps: OrchestratorDeps) {}

  // --------------------------------------------------------------------------
  // Entry point: inbound IM message
  // --------------------------------------------------------------------------

  async handleIncomingMessage(
    msg: BotMessage,
    bridgeName: string,
  ): Promise<void> {
    log(
      `[Orchestrator] Message from ${msg.senderName} (${bridgeName}): ${msg.text.slice(0, 80)}`,
    );

    const bridge = this.deps.getBridge(bridgeName);

    // Decompose the user request into sub-tasks
    let subTasks: SubTask[];
    try {
      subTasks = await this.decomposeTask(msg.text);
    } catch (err) {
      log(`[Orchestrator] LLM decompose failed: ${err}`);
      if (bridge?.sendText) {
        bridge.sendText(`❌ 无法解析任务：${err}`).catch(() => {});
      }
      return;
    }

    if (subTasks.length === 0) {
      if (bridge?.sendText) {
        bridge
          .sendText("❓ 未能识别出任何可执行的任务，请重新描述。")
          .catch(() => {});
      }
      return;
    }

    const taskGroupId = randomId();
    const group: TaskGroupState = {
      id: taskGroupId,
      chatId: msg.chatId,
      originalMessage: msg.text,
      bridgeName,
      totalTasks: subTasks.length,
      results: [],
      startTime: Date.now(),
    };
    this.taskGroups.set(taskGroupId, group);

    // Dispatch each sub-task
    for (const subtask of subTasks) {
      try {
        await this.dispatchSubTask(subtask, group, msg);
      } catch (err) {
        log(
          `[Orchestrator] Failed to dispatch subtask "${subtask.sessionHint}": ${err}`,
        );
        // Decrement total so we don't wait forever for a task that never started
        group.totalTasks = Math.max(0, group.totalTasks - 1);
        if (bridge?.sendText) {
          bridge
            .sendText(`⚠️ 无法派发任务到 "${subtask.sessionHint}"：${err}`)
            .catch(() => {});
        }
      }
    }

    // If all dispatches failed, clean up
    if (group.totalTasks === 0) {
      this.taskGroups.delete(taskGroupId);
    }
  }

  // --------------------------------------------------------------------------
  // Entry point: session stop event
  // --------------------------------------------------------------------------

  handleSessionStop(sessionId: string, response: string): void {
    const task = this.pendingTasks.get(sessionId);
    if (!task) return; // This session wasn't dispatched by orchestrator

    log(
      `[Orchestrator] Session "${task.sessionName}" completed task (group: ${task.taskGroupId.slice(0, 8)})`,
    );
    this.pendingTasks.delete(sessionId);

    const group = this.taskGroups.get(task.taskGroupId);
    if (!group) return;

    group.results.push({ sessionName: task.sessionName, response });

    // When all sub-tasks are done, send final report
    if (group.results.length >= group.totalTasks) {
      this.sendFinalReport(group).catch((e) =>
        log(`[Orchestrator] Failed to send final report: ${e}`),
      );
      this.taskGroups.delete(task.taskGroupId);
    }
  }

  // --------------------------------------------------------------------------
  // Entry point: API-driven dispatch (called by POST /dispatch)
  // --------------------------------------------------------------------------

  async dispatchTask(options: {
    message: string;
    callbackUrl?: string;
    sessionId?: string; // skip LLM routing, send directly to this managed session ID
  }): Promise<DispatchResult> {
    log(`[Orchestrator] API dispatch: "${options.message.slice(0, 80)}"`);

    // If a specific sessionId is given, skip LLM decomposition
    let subTasks: SubTask[];
    if (options.sessionId) {
      const session = this.deps
        .getSessions()
        .find((s) => s.id === options.sessionId);
      subTasks = [
        {
          sessionHint: session?.name ?? options.sessionId,
          prompt: options.message,
          createIfMissing: false,
        },
      ];
    } else {
      try {
        subTasks = await this.decomposeTask(options.message);
      } catch (err) {
        return {
          ok: false,
          taskGroupId: "",
          dispatched: [],
          error: String(err),
        };
      }
    }

    const taskGroupId = randomId();
    const group: TaskGroupState = {
      id: taskGroupId,
      originalMessage: options.message,
      callbackUrl: options.callbackUrl,
      totalTasks: subTasks.length,
      results: [],
      startTime: Date.now(),
    };
    this.taskGroups.set(taskGroupId, group);

    const dispatched: DispatchResult["dispatched"] = [];
    for (const subtask of subTasks) {
      try {
        await this.dispatchSubTask(subtask, group);
        // After dispatch, the session is in pendingTasks — find it for the response
        const sessions = this.deps.getSessions();
        const matched = this.matchSession(subtask.sessionHint, sessions);
        if (matched) {
          dispatched.push({
            sessionId: matched.id,
            sessionName: matched.name,
            prompt: subtask.prompt,
          });
        }
      } catch (err) {
        log(
          `[Orchestrator] Dispatch failed for "${subtask.sessionHint}": ${err}`,
        );
        group.totalTasks = Math.max(0, group.totalTasks - 1);
      }
    }

    if (group.totalTasks === 0) {
      this.taskGroups.delete(taskGroupId);
      return {
        ok: false,
        taskGroupId,
        dispatched,
        error: "All sub-tasks failed to dispatch",
      };
    }

    return { ok: true, taskGroupId, dispatched };
  }

  // --------------------------------------------------------------------------
  // Internal: dispatch a single sub-task to a session
  // --------------------------------------------------------------------------

  private async dispatchSubTask(
    subtask: SubTask,
    group: TaskGroupState,
    originalMsg?: BotMessage,
  ): Promise<void> {
    const sessions = this.deps.getSessions();
    let session = this.matchSession(subtask.sessionHint, sessions);

    if (!session && subtask.createIfMissing) {
      const projects = this.deps.getProjects();
      const projectPath =
        subtask.projectPath ?? this.matchProject(subtask.sessionHint, projects);
      if (projectPath) {
        const sessionName = subtask.sessionHint || basename(projectPath);
        log(
          `[Orchestrator] Auto-creating session "${sessionName}" at ${projectPath}`,
        );
        session = await this.deps.createSession({
          name: sessionName,
          cwd: projectPath,
        });
      }
    }

    if (!session) {
      throw new Error(`找不到匹配的 session，hint: "${subtask.sessionHint}"`);
    }

    // Send acknowledgement immediately (IM path)
    if (group.bridgeName) {
      const groupBridge = this.deps.getBridge(group.bridgeName);
      if (groupBridge?.sendStatusUpdate) {
        groupBridge
          .sendStatusUpdate(
            session.name,
            "正在执行任务",
            subtask.prompt.slice(0, 60),
          )
          .catch(() => {});
      }
    }

    // Send prompt to session
    const result = await this.deps.sendPrompt(session.id, subtask.prompt);
    if (!result.ok) {
      throw new Error(result.error ?? "发送失败");
    }

    // Track this pending task
    const pendingTask: PendingTask = {
      taskGroupId: group.id,
      sessionId: session.id,
      sessionName: session.name,
      chatId: originalMsg?.chatId,
      originalMessage: group.originalMessage,
      subtaskPrompt: subtask.prompt,
      startTime: Date.now(),
      bridgeName: group.bridgeName,
      callbackUrl: group.callbackUrl,
    };
    this.pendingTasks.set(session.id, pendingTask);
    log(
      `[Orchestrator] Dispatched to "${session.name}" (${session.id.slice(0, 8)})`,
    );
  }

  // --------------------------------------------------------------------------
  // Internal: send aggregated final report to IM
  // --------------------------------------------------------------------------

  private async sendFinalReport(group: TaskGroupState): Promise<void> {
    const durationMs = Date.now() - group.startTime;

    // --- Path A: API-dispatched (callbackUrl) ---
    if (group.callbackUrl) {
      const payload: DispatchCallbackPayload = {
        taskGroupId: group.id,
        originalMessage: group.originalMessage,
        results: group.results,
        durationMs,
      };
      try {
        const resp = await fetch(group.callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        log(
          `[Orchestrator] Callback sent to ${group.callbackUrl} → ${resp.status}`,
        );
      } catch (err) {
        log(`[Orchestrator] Callback POST failed: ${err}`);
      }
      return;
    }

    // --- Path B: IM-dispatched (bridge) ---
    const bridge = group.bridgeName
      ? this.deps.getBridge(group.bridgeName)
      : undefined;
    if (!bridge) return;

    const durationStr = `${Math.round(durationMs / 1000)}s`;

    if (group.results.length === 1) {
      const msg: TaskCompletionMessage = {
        sessionName: group.results[0].sessionName,
        status: "completed",
        response: group.results[0].response,
        originalPrompt: group.originalMessage,
        duration: durationMs,
      };
      await bridge.sendTaskCompletion(group.chatId!, msg);
    } else {
      const lines = group.results
        .map((r) => {
          const preview = r.response
            ? r.response.length > 300
              ? r.response.slice(0, 300) + "\n..."
              : r.response
            : "（无返回内容）";
          return `**${r.sessionName}**\n${preview}`;
        })
        .join("\n\n---\n\n");
      const summary = `✅ 全部 ${group.totalTasks} 个任务已完成（${durationStr}）\n\n**原始请求：** ${group.originalMessage.slice(0, 100)}\n\n${lines}`;
      if (bridge.sendText) {
        await bridge.sendText(summary);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal: LLM-based task decomposition
  // --------------------------------------------------------------------------

  private async decomposeTask(userMessage: string): Promise<SubTask[]> {
    const settings = this.deps.getSettings();
    const providerName = settings.defaultProvider;
    const provider = providerName
      ? settings.llmProviders[providerName]
      : Object.values(settings.llmProviders)[0];

    if (!provider?.apiKey) {
      log(
        "[Orchestrator] No LLM provider configured, using single-task fallback",
      );
      return this.singleTaskFallback(userMessage);
    }

    const sessions = this.deps.getSessions();
    const projects = this.deps.getProjects();

    const sessionList =
      sessions
        .map(
          (s) =>
            `- name: "${s.name}", status: ${s.status}, cwd: ${s.cwd ?? "?"}${s.description ? `, desc: "${s.description}"` : ""}`,
        )
        .join("\n") || "（暂无 session）";

    const projectList =
      projects
        .map((p) => `- name: "${p.name}", path: "${p.path}"`)
        .join("\n") || "（暂无已知项目）";

    const systemPrompt = `You are a task orchestrator for an AI agent management system.
Your job: analyze the user's request and break it into sub-tasks for available agent sessions.

Available sessions:
${sessionList}

Available projects (can create new sessions):
${projectList}

Rules:
1. Match tasks to sessions by name/description similarity.
2. If no matching session exists but a relevant project exists, set createIfMissing=true and provide projectPath.
3. For a simple single request, return just one task.
4. Each prompt must be complete and self-contained.
5. Respond ONLY with valid JSON, no markdown, no explanation.

JSON format:
{
  "tasks": [
    {
      "sessionHint": "session name or keyword",
      "prompt": "full prompt to send",
      "createIfMissing": false,
      "projectPath": "/optional/path"
    }
  ]
}`;

    try {
      const content = await this.callLLM(provider, systemPrompt, userMessage);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("LLM did not return valid JSON");
      const parsed = JSON.parse(jsonMatch[0]) as { tasks: SubTask[] };
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
        throw new Error("LLM returned empty tasks array");
      }
      return parsed.tasks;
    } catch (err) {
      log(
        `[Orchestrator] LLM parse error: ${err}, falling back to single task`,
      );
      return this.singleTaskFallback(userMessage);
    }
  }

  /** Fall back: treat entire message as one task sent to any idle session */
  private singleTaskFallback(message: string): SubTask[] {
    const sessions = this.deps.getSessions();
    const idle = sessions.find((s) => s.status === "idle");
    return [
      {
        sessionHint: idle?.name ?? "",
        prompt: message,
        createIfMissing: false,
      },
    ];
  }

  // --------------------------------------------------------------------------
  // Internal: LLM API call (Anthropic or OpenAI-compatible)
  // --------------------------------------------------------------------------

  private async callLLM(
    provider: LLMProviderConfig,
    system: string,
    user: string,
  ): Promise<string> {
    const model = provider.model ?? "claude-sonnet-4-6";
    const maxTokens = provider.maxTokens ?? 1024;

    if (provider.provider === "anthropic") {
      const baseUrl = provider.baseUrl ?? "https://api.anthropic.com";
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!resp.ok)
        throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      return data.content.find((c) => c.type === "text")?.text ?? "";
    }

    // OpenAI-compatible (OpenAI, DeepSeek, Ollama, custom)
    const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok)
      throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  }

  // --------------------------------------------------------------------------
  // Internal: session matching helpers
  // --------------------------------------------------------------------------

  private matchSession(
    hint: string,
    sessions: ManagedSession[],
  ): ManagedSession | undefined {
    if (!hint) return sessions.find((s) => s.status === "idle") ?? sessions[0];
    const lower = hint.toLowerCase();
    return sessions.find(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description?.toLowerCase().includes(lower),
    );
  }

  private matchProject(
    hint: string,
    projects: KnownProject[],
  ): string | undefined {
    if (!hint) return projects[0]?.path;
    const lower = hint.toLowerCase();
    return projects.find(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.path.toLowerCase().includes(lower),
    )?.path;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
