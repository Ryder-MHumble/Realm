/**
 * ResultCapture - 捕获 session 输出并通过 callbackUrl 回调
 *
 * 功能：
 * 1. 监听 session 的 stop 事件
 * 2. 从 tmux 中捕获输出
 * 3. 通过 callbackUrl POST 回调结果
 */

import fetch from "node-fetch";
import { execSync } from "child_process";
import type { ManagedSession } from "../../shared/types.js";

export interface TaskResult {
  taskGroupId: string;
  originalMessage: string;
  results: Array<{
    sessionId: string;
    sessionName: string;
    response: string;
    status: "completed" | "failed";
    duration: number;
  }>;
  durationMs: number;
  timestamp: number;
}

export class ResultCapture {
  private pendingTasks = new Map<
    string,
    {
      taskGroupId: string;
      originalMessage: string;
      callbackUrl: string;
      sessionResults: Map<
        string,
        {
          sessionName: string;
          startTime: number;
          tmuxSession: string;
          response?: string;
          status?: "completed" | "failed";
        }
      >;
      startTime: number;
    }
  >();

  /**
   * 注册一个待处理的任务
   */
  registerTask(
    taskGroupId: string,
    originalMessage: string,
    callbackUrl: string,
    sessions: Array<{ id: string; name: string; tmuxSession: string }>,
  ) {
    const sessionResults = new Map(
      sessions.map((s) => [
        s.id,
        {
          sessionName: s.name,
          startTime: Date.now(),
          tmuxSession: s.tmuxSession,
        },
      ]),
    );

    this.pendingTasks.set(taskGroupId, {
      taskGroupId,
      originalMessage,
      callbackUrl,
      sessionResults,
      startTime: Date.now(),
    });

    console.log(`[ResultCapture] Registered task: ${taskGroupId}`);
  }

  /**
   * 当 session 完成时调用
   */
  async onSessionComplete(
    taskGroupId: string,
    sessionId: string,
    tmuxSession: string,
  ) {
    const task = this.pendingTasks.get(taskGroupId);
    if (!task) return;

    try {
      // 从 tmux 中捕获输出
      const output = this.captureSessionOutput(tmuxSession);

      // 更新结果
      const sessionResult = task.sessionResults.get(sessionId);
      if (sessionResult) {
        sessionResult.response = output;
        sessionResult.status = "completed";
      }

      console.log(
        `[ResultCapture] Session ${sessionId} completed, captured ${output.length} chars`,
      );

      // 检查是否所有 sessions 都完成了
      await this.checkAndCallback(taskGroupId);
    } catch (error) {
      console.error(`[ResultCapture] Error capturing session output:`, error);
    }
  }

  /**
   * 从 tmux session 中捕获输出
   */
  private captureSessionOutput(tmuxSession: string): string {
    try {
      const output = execSync(
        `tmux capture-pane -t ${tmuxSession} -p -S -100`,
        {
          encoding: "utf-8",
        },
      );
      return output.trim();
    } catch (error) {
      console.error(`[ResultCapture] Failed to capture tmux output:`, error);
      return "";
    }
  }

  /**
   * 检查是否所有 sessions 都完成，如果是则回调
   */
  private async checkAndCallback(taskGroupId: string) {
    const task = this.pendingTasks.get(taskGroupId);
    if (!task) return;

    // 检查是否所有 sessions 都有结果
    const allCompleted = Array.from(task.sessionResults.values()).every(
      (r) => r.response !== undefined,
    );

    if (!allCompleted) {
      console.log(
        `[ResultCapture] Waiting for more sessions to complete (${taskGroupId})`,
      );
      return;
    }

    // 所有 sessions 都完成了，准备回调
    const results: TaskResult["results"] = Array.from(
      task.sessionResults.entries(),
    ).map(([sessionId, result]) => ({
      sessionId,
      sessionName: result.sessionName,
      response: result.response || "",
      status: "completed",
      duration: Date.now() - result.startTime,
    }));

    const taskResult: TaskResult = {
      taskGroupId,
      originalMessage: task.originalMessage,
      results,
      durationMs: Date.now() - task.startTime,
      timestamp: Date.now(),
    };

    // 发送回调
    await this.sendCallback(task.callbackUrl, taskResult);

    // 清理
    this.pendingTasks.delete(taskGroupId);
  }

  /**
   * 发送回调给 OpenClaw
   */
  private async sendCallback(callbackUrl: string, result: TaskResult) {
    try {
      console.log(`[ResultCapture] Sending callback to: ${callbackUrl}`);

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log(
        `[ResultCapture] Callback sent successfully for task: ${result.taskGroupId}`,
      );
    } catch (error) {
      console.error(`[ResultCapture] Failed to send callback:`, error);
    }
  }

  /**
   * 获取待处理任务列表
   */
  getPendingTasks() {
    return Array.from(this.pendingTasks.entries()).map(([id, task]) => ({
      taskGroupId: id,
      originalMessage: task.originalMessage,
      callbackUrl: task.callbackUrl,
      sessionCount: task.sessionResults.size,
      completedCount: Array.from(task.sessionResults.values()).filter(
        (r) => r.response !== undefined,
      ).length,
    }));
  }
}
