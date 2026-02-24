/**
 * Tmux Utilities
 *
 * Safe helpers for interacting with tmux sessions.
 * Validates session names and paths to prevent command injection.
 */

import { execFile } from "child_process";
import { existsSync, writeFileSync, unlinkSync, statSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";
import { expandHome } from "./config.js";

// ============================================================================
// Module State (initialized once via initTmuxUtils)
// ============================================================================

let _execOptions: { env: NodeJS.ProcessEnv } = {
  env: process.env as NodeJS.ProcessEnv,
};

export function initTmuxUtils(execOptions: { env: NodeJS.ProcessEnv }): void {
  _execOptions = execOptions;
}

export function getExecOptions(): { env: NodeJS.ProcessEnv } {
  return _execOptions;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate and sanitize a directory path for use in shell commands.
 * Returns the resolved path if valid, throws if invalid.
 */
export function validateDirectoryPath(inputPath: string): string {
  const resolved = resolve(expandHome(inputPath));

  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${inputPath}`);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }

  // Reject paths with shell metacharacters that could enable injection
  const dangerousChars = /[;&|`$(){}[\]<>\\'"!#*?]/;
  if (dangerousChars.test(resolved)) {
    throw new Error(`Directory path contains invalid characters: ${inputPath}`);
  }

  return resolved;
}

/**
 * Validate a tmux session name.
 * tmux session names should only contain alphanumeric, underscore, hyphen.
 */
export function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

// ============================================================================
// Exec Helpers
// ============================================================================

/** Promisified execFile helper using module-level exec options */
export function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, _execOptions, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Wait for a tmux session to be ready (pane exists and can receive input).
 * Polls `tmux has-session` at regular intervals.
 */
export async function waitForTmuxReady(
  tmuxSession: string,
  timeoutMs: number = 15000,
  intervalMs: number = 500,
): Promise<void> {
  validateTmuxSession(tmuxSession);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await execFileAsync("tmux", ["has-session", "-t", tmuxSession]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  console.warn(
    `tmux session ${tmuxSession} not confirmed ready after ${timeoutMs}ms`,
  );
}

/**
 * Accept the Claude Code bypass permissions confirmation prompt.
 * Claude shows a selection UI defaulting to "1. No, exit".
 * We send Down (select "2. Yes, I accept") then Enter to confirm.
 */
export async function acceptBypassPrompt(
  tmuxSession: string,
  delayMs: number = 300,
): Promise<void> {
  validateTmuxSession(tmuxSession);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(delayMs);

  try {
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Down"]);
    await sleep(100);
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
  } catch {
    // Session may have already exited — ignore
  }
}

/**
 * Safely send text to a tmux session.
 *
 * For slash commands (starting with /), uses send-keys -l so that Claude Code
 * receives individual keystrokes and can detect the slash command properly.
 * For regular prompts, uses load-buffer + paste-buffer to safely handle
 * arbitrary text without shell injection risks.
 */
export async function sendToTmuxSafe(
  tmuxSession: string,
  text: string,
  maxRetries: number = 3,
): Promise<void> {
  validateTmuxSession(tmuxSession);

  const isSlashCommand = text.trimStart().startsWith("/");

  if (isSlashCommand) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await execFileAsync("tmux", [
          "send-keys",
          "-t",
          tmuxSession,
          "-l",
          text,
        ]);
        await new Promise((r) => setTimeout(r, 100));
        await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw error;
      }
    }
    return;
  }

  // For regular prompts, use load-buffer + paste-buffer (safe for arbitrary text)
  const tempFile = `/tmp/vibecraft-prompt-${Date.now()}-${randomBytes(16).toString("hex")}.txt`;
  writeFileSync(tempFile, text);

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await execFileAsync("tmux", ["load-buffer", tempFile]);
        await execFileAsync("tmux", ["paste-buffer", "-t", tmuxSession]);
        await new Promise((r) => setTimeout(r, 100));
        await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw error;
      }
    }
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
