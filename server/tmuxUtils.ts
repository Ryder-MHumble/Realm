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
    throw new Error(
      `Directory path contains invalid characters: ${inputPath}`,
    );
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
): Promise<void> {
  validateTmuxSession(tmuxSession);

  const isSlashCommand = text.trimStart().startsWith("/");

  if (isSlashCommand) {
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "-l", text]);
    await new Promise((r) => setTimeout(r, 100));
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
    return;
  }

  // For regular prompts, use load-buffer + paste-buffer (safe for arbitrary text)
  const tempFile = `/tmp/vibecraft-prompt-${Date.now()}-${randomBytes(16).toString("hex")}.txt`;
  writeFileSync(tempFile, text);

  try {
    await execFileAsync("tmux", ["load-buffer", tempFile]);
    await execFileAsync("tmux", ["paste-buffer", "-t", tmuxSession]);
    await new Promise((r) => setTimeout(r, 100));
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
