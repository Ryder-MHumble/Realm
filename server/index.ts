/**
 * Vibecraft WebSocket Server
 *
 * This server:
 * 1. Watches the events JSONL file for changes
 * 2. Accepts HTTP POST /event for real-time hook notifications
 * 3. Broadcasts events to connected WebSocket clients
 * 4. Tracks tool durations by matching pre/post events
 * 5. Proxies voice input to Deepgram for transcription
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { watch } from "chokidar";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { exec, execFile } from "child_process";
import { dirname, resolve, join, extname } from "path";
import { hostname } from "os";
import { randomUUID, randomBytes } from "crypto";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { LiveClient } from "@deepgram/sdk";
import type {
  ClaudeEvent,
  ServerMessage,
  ClientMessage,
  PreToolUseEvent,
  PostToolUseEvent,
  ManagedSession,
  CreateSessionRequest,
  UpdateSessionRequest,
  SessionPromptRequest,
  GitStatus,
  TextTile,
  CreateTextTileRequest,
  UpdateTextTileRequest,
  ZoneGroup,
  CreateZoneGroupRequest,
} from "../shared/types.js";
import { DEFAULTS } from "../shared/defaults.js";
import { GitStatusManager } from "./GitStatusManager.js";
import { ProjectsManager } from "./ProjectsManager.js";
import { fileURLToPath } from "url";

// ============================================================================
// Version (read from package.json)
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getPackageVersion(): string {
  try {
    // Try multiple locations (dev vs compiled)
    const locations = [
      resolve(__dirname, "../package.json"), // dev: server/ -> package.json
      resolve(__dirname, "../../package.json"), // compiled: dist/server/ -> package.json
    ];
    for (const loc of locations) {
      if (existsSync(loc)) {
        const pkg = JSON.parse(readFileSync(loc, "utf-8"));
        return pkg.version || "unknown";
      }
    }
  } catch {
    // Ignore errors
  }
  return "unknown";
}

const VERSION = getPackageVersion();

// ============================================================================
// Configuration (env vars override DEFAULTS from shared/defaults.ts)
// ============================================================================

/** Expand ~ to home directory in paths */
function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}

const PORT = parseInt(
  process.env.VIBECRAFT_PORT ?? String(DEFAULTS.SERVER_PORT),
  10,
);
const EVENTS_FILE = resolve(
  expandHome(process.env.VIBECRAFT_EVENTS_FILE ?? DEFAULTS.EVENTS_FILE),
);
const PENDING_PROMPT_FILE = resolve(
  expandHome(
    process.env.VIBECRAFT_PROMPT_FILE ?? "~/.vibecraft/data/pending-prompt.txt",
  ),
);
const MAX_EVENTS = parseInt(
  process.env.VIBECRAFT_MAX_EVENTS ?? String(DEFAULTS.MAX_EVENTS),
  10,
);
const DEBUG = process.env.VIBECRAFT_DEBUG === "true";
const TMUX_SESSION =
  process.env.VIBECRAFT_TMUX_SESSION ?? DEFAULTS.TMUX_SESSION;
const SESSIONS_FILE = resolve(
  expandHome(process.env.VIBECRAFT_SESSIONS_FILE ?? DEFAULTS.SESSIONS_FILE),
);
const TILES_FILE = resolve(
  expandHome(
    process.env.VIBECRAFT_TILES_FILE ?? "~/.vibecraft/data/tiles.json",
  ),
);
const GROUPS_FILE = resolve(expandHome("~/.vibecraft/data/groups.json"));

/** Time before a "working" session auto-transitions to idle (failsafe for missed events) */
const WORKING_TIMEOUT_MS = 120_000; // 2 minutes

/** Maximum request body size (1MB) - prevents DoS via memory exhaustion */
const MAX_BODY_SIZE = 1024 * 1024;

/** How often to check for stale "working" sessions */
const WORKING_CHECK_INTERVAL_MS = 10_000; // 10 seconds

/** Extended PATH for exec() - includes Homebrew and user paths for macOS/Linux */
const HOME = process.env.HOME || "";
const EXEC_PATH = [
  `${HOME}/.local/bin`, // User local bin (Claude CLI default location)
  "/opt/homebrew/bin", // macOS Apple Silicon Homebrew
  "/usr/local/bin", // macOS Intel Homebrew / Linux local
  process.env.PATH || "",
].join(":");

/** Options for exec() with extended PATH */
const EXEC_OPTIONS = { env: { ...process.env, PATH: EXEC_PATH } };

/** Deepgram API key from environment */
const DEEPGRAM_API_KEY_ENV = "DEEPGRAM_API_KEY";

/** Deepgram transcription settings */
const DEEPGRAM_MODEL = "nova-2";
const DEEPGRAM_LANGUAGE = "en";

/**
 * Validate WebSocket origin header to prevent CSRF attacks.
 * Only browser clients should connect, so we require a valid origin.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  // Require origin header - only browsers send this
  if (!origin) return false;

  try {
    const url = new URL(origin);

    // Allow any port on localhost/127.0.0.1 (local development)
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }

    // Production: exact hostname match with HTTPS required
    if (url.hostname === "vibecraft.sh" && url.protocol === "https:") {
      return true;
    }

    return false;
  } catch {
    return false; // Invalid URL format
  }
}

/**
 * Validate and sanitize a directory path for use in shell commands.
 * Returns the resolved path if valid, throws if invalid.
 */
function validateDirectoryPath(inputPath: string): string {
  // Resolve to absolute path (handles ~, .., etc.)
  const resolved = resolve(expandHome(inputPath));

  // Check path exists and is a directory
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${inputPath}`);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }

  // Reject paths with shell metacharacters that could enable injection
  // Even with execFile, tmux passes commands to a shell
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
function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

/**
 * Promisified execFile helper
 */
function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, EXEC_OPTIONS, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Safely collect request body with size limit to prevent DoS.
 * Returns a promise that resolves with the body string or rejects on error/oversized.
 */
function collectRequestBody(
  req: IncomingMessage,
  maxSize: number = MAX_BODY_SIZE,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Safely send text to a tmux session using load-buffer + paste-buffer.
 * Uses execFile with proper arguments to prevent shell injection.
 */
async function sendToTmuxSafe(
  tmuxSession: string,
  text: string,
): Promise<void> {
  // Validate session name
  validateTmuxSession(tmuxSession);

  // Create temp file with cryptographically secure random name
  const tempFile = `/tmp/vibecraft-prompt-${Date.now()}-${randomBytes(16).toString("hex")}.txt`;
  writeFileSync(tempFile, text);

  try {
    // Load text into tmux buffer
    await execFileAsync("tmux", ["load-buffer", tempFile]);
    // Paste buffer into session
    await execFileAsync("tmux", ["paste-buffer", "-t", tmuxSession]);
    // Send Enter to submit
    await new Promise((r) => setTimeout(r, 100)); // Small delay like original
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// State
// ============================================================================

/** All events in memory */
const events: ClaudeEvent[] = [];

/** Track seen event IDs to prevent duplicates (from file watcher + POST) */
const seenEventIds = new Set<string>();

/** Track in-flight tool uses for duration calculation */
const pendingToolUses = new Map<string, PreToolUseEvent>();

/** Connected WebSocket clients */
const clients = new Set<WebSocket>();

/** Last read position in file */
let lastFileSize = 0;

/** Token tracking per session */
interface SessionTokens {
  lastSeen: number; // Last token count seen in output
  cumulative: number; // Running total (estimated)
  lastUpdate: number; // Timestamp
}
const sessionTokens = new Map<string, SessionTokens>();

/** Last parsed tmux output (to detect changes) */
let lastTmuxHash = "";

/** Track pending permission prompts per session */
interface PermissionOption {
  number: string; // "1", "2", "3"
  label: string; // "Yes", "Yes, and always allow...", "No"
}

interface PermissionPrompt {
  tool: string;
  context: string; // The full prompt text
  options: PermissionOption[]; // Available choices
  detectedAt: number;
}
const pendingPermissions = new Map<string, PermissionPrompt>();

/** Track sessions that have had the bypass permissions warning handled */
const bypassWarningHandled = new Set<string>();

/** Managed sessions registry */
const managedSessions = new Map<string, ManagedSession>();

/** Text tiles (grid labels) */
const textTiles = new Map<string, TextTile>();

/** Zone groups (adjacent hex grouping) */
const zoneGroups = new Map<string, ZoneGroup>();

/** Git status tracker for managed sessions */
const gitStatusManager = new GitStatusManager();

/** Project directories manager */
const projectsManager = new ProjectsManager();

/** Active voice transcription sessions (WebSocket client → Deepgram connection) */
const voiceSessions = new Map<WebSocket, LiveClient>();

/** Deepgram API key (loaded on startup) */
let deepgramApiKey: string | null = null;

/** Load Deepgram API key from environment */
function loadDeepgramKey(): string | null {
  const key = process.env[DEEPGRAM_API_KEY_ENV]?.trim();
  if (key) {
    log("Deepgram API key loaded from environment");
    return key;
  }
  log(`${DEEPGRAM_API_KEY_ENV} not set - voice input disabled`);
  return null;
}

/** Map Claude Code session IDs to our managed session IDs */
const claudeToManagedMap = new Map<string, string>();

/** Counter for generating session names */
let sessionCounter = 0;

// ============================================================================
// Logging
// ============================================================================

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log(`[DEBUG ${new Date().toISOString()}]`, ...args);
  }
}

// ============================================================================
// Token Tracking
// ============================================================================

/**
 * Parse token count from Claude Code output
 * Patterns:
 *   ↓ 879 tokens
 *   ↓ 1,234 tokens
 *   ↓ 12.5k tokens
 *   ↓ 12k tokens
 */
function parseTokensFromOutput(output: string): number | null {
  // Match patterns like: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
  const patterns = [
    /↓\s*([0-9,]+)\s*tokens?/gi, // ↓ 879 tokens, ↓ 1,234 tokens
    /↓\s*([0-9.]+)k\s*tokens?/gi, // ↓ 12.5k tokens, ↓ 12k tokens
  ];

  let maxTokens = 0;

  // Pattern 1: plain numbers (possibly with commas)
  const plainMatches = output.matchAll(patterns[0]);
  for (const match of plainMatches) {
    const num = parseInt(match[1].replace(/,/g, ""), 10);
    if (num > maxTokens) maxTokens = num;
  }

  // Pattern 2: k suffix (thousands)
  const kMatches = output.matchAll(patterns[1]);
  for (const match of kMatches) {
    const num = Math.round(parseFloat(match[1]) * 1000);
    if (num > maxTokens) maxTokens = num;
  }

  return maxTokens > 0 ? maxTokens : null;
}

/**
 * Poll tmux output for token counts
 */
function pollTokens(tmuxSession: string): void {
  try {
    validateTmuxSession(tmuxSession);
  } catch {
    debug(`Invalid tmux session for token polling: ${tmuxSession}`);
    return;
  }

  execFile(
    "tmux",
    ["capture-pane", "-t", tmuxSession, "-p", "-S", "-50"],
    { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) {
        debug(`Token poll failed: ${error.message}`);
        return;
      }

      // Simple hash to detect changes
      const hash = stdout.slice(-500);
      if (hash === lastTmuxHash) return;
      lastTmuxHash = hash;

      const tokens = parseTokensFromOutput(stdout);
      if (tokens === null) return;

      // Update session tokens (use TMUX_SESSION as session ID for now)
      let session = sessionTokens.get(tmuxSession);
      if (!session) {
        session = { lastSeen: 0, cumulative: 0, lastUpdate: Date.now() };
        sessionTokens.set(tmuxSession, session);
      }

      // If we see a higher token count, update cumulative
      if (tokens > session.lastSeen) {
        const delta = tokens - session.lastSeen;
        session.cumulative += delta;
        session.lastSeen = tokens;
        session.lastUpdate = Date.now();

        debug(`Tokens updated: ${tokens} (cumulative: ${session.cumulative})`);

        // Broadcast token update
        broadcast({
          type: "tokens",
          payload: {
            session: tmuxSession,
            current: tokens,
            cumulative: session.cumulative,
          },
        } as ServerMessage);
      } else if (tokens < session.lastSeen && tokens > 0) {
        // Token count dropped - likely new conversation, reset tracking
        session.lastSeen = tokens;
        session.lastUpdate = Date.now();
        debug(`Token count reset detected: ${tokens}`);
      }
    },
  );
}

/**
 * Start polling for tokens
 */
function startTokenPolling(): void {
  // Poll every 2 seconds - poll all managed sessions
  setInterval(() => {
    for (const session of managedSessions.values()) {
      if (session.status !== "offline") {
        pollTokens(session.tmuxSession);
      }
    }
    // Also poll the default session for backwards compatibility
    if (!managedSessions.size) {
      pollTokens(TMUX_SESSION);
    }
  }, 2000);
  log(`Token polling started`);
}

// ============================================================================
// Permission Prompt Detection
// ============================================================================

/**
 * Parse tmux output to detect Claude Code permission prompts.
 *
 * Claude Code prompts look like:
 *   ● Bash(rm /tmp/test.txt)
 *   ⎿  Running PreToolUse hook…
 *   ─────────────────────────────
 *   Bash command
 *
 *      rm /tmp/test.txt
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and always allow access to tmp/ from this project
 *     3. No
 *
 *   Esc to cancel · Tab to add additional instructions
 *
 * OR (plan mode):
 *   · Bash(prompt: run TypeScript compiler)
 *   Would you like to proceed?
 *
 *     1. Yes, and bypass permissions
 *   ❯ 2. Yes, and manually approve edits
 *     3. Type here to tell Claude what to change
 *
 *   ctrl-g to edit in Vim · ~/.claude/plans/...
 */
function detectPermissionPrompt(
  output: string,
): { tool: string; context: string; options: PermissionOption[] } | null {
  const lines = output.split("\n");

  // Look for "Do you want to proceed?" OR "Would you like to proceed?" in recent output
  let proceedLineIdx = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (/(Do you want|Would you like) to proceed\?/i.test(lines[i])) {
      proceedLineIdx = i;
      break;
    }
  }

  if (proceedLineIdx === -1) return null;

  // CRITICAL: Verify this is a real Claude Code prompt by checking for the footer
  // "Esc to cancel · Tab to add additional instructions" OR "ctrl-g to edit in Vim"
  let hasFooter = false;
  let hasSelector = false;
  for (
    let i = proceedLineIdx + 1;
    i < Math.min(lines.length, proceedLineIdx + 15);
    i++
  ) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
      hasFooter = true;
      break;
    }
    // Also check for the ❯ selector arrow which indicates the interactive menu
    if (/^\s*❯/.test(lines[i])) {
      hasSelector = true;
    }
  }

  // Must have either the footer or the selector arrow to be a real prompt
  if (!hasFooter && !hasSelector) {
    debug(
      'Skipping false positive: no "Esc to cancel"/"ctrl-g" footer or ❯ selector found',
    );
    return null;
  }

  // Parse numbered options below the "Do you want to proceed?" line
  const options: PermissionOption[] = [];
  for (
    let i = proceedLineIdx + 1;
    i < Math.min(lines.length, proceedLineIdx + 10);
    i++
  ) {
    const line = lines[i];

    // Stop if we hit the footer
    if (/Esc to cancel/i.test(line)) break;

    // Match options like "❯ 1. Yes" or "  2. Yes, and always..."
    // The arrow (❯) indicates current selection, but we want all options
    const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/);
    if (optionMatch) {
      options.push({
        number: optionMatch[1],
        label: optionMatch[2].trim(),
      });
    }
  }

  // Need at least 2 options to be valid
  if (options.length < 2) return null;

  // Find the tool name - look backwards for "● ToolName(...)" or "Bash command" header
  let tool = "Unknown";
  for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
    // Match tool header like "● Bash(rm /tmp/test.txt)" or "· Bash(prompt: ...)"
    // ● = bullet, ◐ = half-filled circle, · = middle dot (plan mode)
    const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/);
    if (toolMatch) {
      tool = toolMatch[1];
      break;
    }
    // Also match standalone tool type like "Bash command" or "Read file"
    const cmdMatch = lines[i].match(
      /^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i,
    );
    if (cmdMatch) {
      tool = cmdMatch[1];
      break;
    }
  }

  // Build context from the prompt area (between tool header and options)
  const contextStart = Math.max(0, proceedLineIdx - 10);
  const contextEnd = proceedLineIdx + 1 + options.length;
  const context = lines.slice(contextStart, contextEnd).join("\n").trim();

  debug(
    `Detected permission prompt: tool=${tool}, options=${options.map((o) => o.number + ":" + o.label).join(", ")}`,
  );

  return { tool, context, options };
}

/**
 * Detect the bypass permissions warning that appears on first use of --dangerously-skip-permissions.
 * Returns true if the warning is detected and needs to be accepted.
 *
 * The warning looks like:
 *   ╭──────────────────────────────────────────────────────────────────────────────╮
 *   │                                  WARNING                                     │
 *   │                                                                              │
 *   │  You are entering Bypass Permissions mode. In this mode:                     │
 *   │   • All tool calls will be auto-approved                                     │
 *   │   ...                                                                        │
 *   │                                                                              │
 *   │  Are you sure you want to continue?                                          │
 *   │                                                                              │
 *   │      1. No, exit Claude Code                                                 │
 *   │    ❯ 2. Yes, I understand and accept the risks                               │
 *   ╰──────────────────────────────────────────────────────────────────────────────╯
 */
function detectBypassWarning(output: string): boolean {
  // Must have both WARNING and Bypass Permissions mode
  return (
    output.includes("WARNING") && output.includes("Bypass Permissions mode")
  );
}

/**
 * Poll a session for permission prompts
 */
function pollPermissions(sessionId: string, tmuxSession: string): void {
  try {
    validateTmuxSession(tmuxSession);
  } catch {
    debug(`Invalid tmux session for permission polling: ${tmuxSession}`);
    return;
  }

  execFile(
    "tmux",
    ["capture-pane", "-t", tmuxSession, "-p", "-S", "-50"],
    { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) {
        debug(`Permission poll failed for ${tmuxSession}: ${error.message}`);
        return;
      }

      // Check for bypass permissions warning (first-time use of --dangerously-skip-permissions)
      if (detectBypassWarning(stdout) && !bypassWarningHandled.has(sessionId)) {
        log(
          `Bypass permissions warning detected for session ${sessionId}, auto-accepting...`,
        );
        bypassWarningHandled.add(sessionId);
        // Send "2" to accept the warning
        execFile(
          "tmux",
          ["send-keys", "-t", tmuxSession, "2"],
          EXEC_OPTIONS,
          (err) => {
            if (err) {
              log(`Failed to auto-accept bypass warning: ${err.message}`);
            } else {
              log(
                `Bypass permissions warning accepted for session ${sessionId}`,
              );
            }
          },
        );
        return; // Don't process further this poll cycle
      }

      const prompt = detectPermissionPrompt(stdout);
      const existing = pendingPermissions.get(sessionId);

      if (prompt && !existing) {
        // New permission prompt detected
        pendingPermissions.set(sessionId, {
          tool: prompt.tool,
          context: prompt.context,
          options: prompt.options,
          detectedAt: Date.now(),
        });

        log(
          `Permission prompt detected for session ${sessionId}: ${prompt.tool} (${prompt.options.length} options)`,
        );

        // Broadcast to clients with options
        broadcast({
          type: "permission_prompt",
          payload: {
            sessionId,
            tool: prompt.tool,
            context: prompt.context,
            options: prompt.options,
          },
        } as ServerMessage);

        // Update session status
        const session = managedSessions.get(sessionId);
        if (session) {
          session.status = "waiting";
          session.currentTool = prompt.tool;
          broadcastSessions();
        }
      } else if (!prompt && existing) {
        // Permission prompt was resolved (user responded in terminal or elsewhere)
        pendingPermissions.delete(sessionId);
        log(`Permission prompt resolved for session ${sessionId}`);

        // Broadcast resolution
        broadcast({
          type: "permission_resolved",
          payload: { sessionId },
        } as ServerMessage);

        // Reset session status
        const session = managedSessions.get(sessionId);
        if (session && session.status === "waiting") {
          session.status = "working";
          session.currentTool = undefined;
          broadcastSessions();
        }
      }
    },
  );
}

/**
 * Start polling for permission prompts
 */
function startPermissionPolling(): void {
  // Poll every 1 second (more frequent than tokens since permissions are time-sensitive)
  setInterval(() => {
    for (const session of managedSessions.values()) {
      if (session.status !== "offline") {
        pollPermissions(session.id, session.tmuxSession);
      }
    }
  }, 1000);
  log(`Permission polling started`);
}

/**
 * Send a permission response to a session.
 * The response should be the option number ("1", "2", "3", etc.)
 */
function sendPermissionResponse(
  sessionId: string,
  optionNumber: string,
): boolean {
  const session = managedSessions.get(sessionId);
  if (!session) {
    log(`Cannot send permission response: session ${sessionId} not found`);
    return false;
  }

  // Validate it's a number
  if (!/^\d+$/.test(optionNumber)) {
    log(`Invalid permission response: ${optionNumber} (expected number)`);
    return false;
  }

  // Validate tmux session name
  try {
    validateTmuxSession(session.tmuxSession);
  } catch {
    log(`Invalid tmux session name: ${session.tmuxSession}`);
    return false;
  }

  // Send the option number to tmux - Claude Code expects just the number
  execFile(
    "tmux",
    ["send-keys", "-t", session.tmuxSession, optionNumber],
    EXEC_OPTIONS,
    (error) => {
      if (error) {
        log(`Failed to send permission response: ${error.message}`);
        return;
      }

      log(
        `Sent permission response to ${session.name}: option ${optionNumber}`,
      );

      // Clear the pending permission
      pendingPermissions.delete(sessionId);

      // Update session status
      session.status = "working";
      session.currentTool = undefined;
      broadcastSessions();
    },
  );

  return true;
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Generate a short ID for tmux session names
 */
function shortId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Create a new managed session
 */
function createSession(
  options: CreateSessionRequest = {},
): Promise<ManagedSession> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    sessionCounter++;
    const name = options.name || `Claude ${sessionCounter}`;
    const tmuxSession = `vibecraft-${shortId()}`;

    // Validate cwd to prevent command injection
    let cwd: string;
    try {
      cwd = validateDirectoryPath(options.cwd || process.cwd());
    } catch (err) {
      reject(err);
      return;
    }

    // Build claude command with flags
    const flags = options.flags || {};
    const claudeArgs: string[] = [];

    // Defaults: continue=true, skipPermissions=true, chrome=false
    if (flags.continue !== false) {
      claudeArgs.push("-c");
    }
    if (flags.skipPermissions !== false) {
      // --permission-mode=bypassPermissions skips the workspace trust dialog
      // --dangerously-skip-permissions skips tool permission prompts
      claudeArgs.push("--permission-mode=bypassPermissions");
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (flags.chrome) {
      claudeArgs.push("--chrome");
    }

    const claudeCmd =
      claudeArgs.length > 0 ? `claude ${claudeArgs.join(" ")}` : "claude";

    // Spawn tmux session with claude using execFile to prevent shell injection
    // Arguments are passed as array, not interpolated into a shell string
    execFile(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        cwd,
        `PATH=${EXEC_PATH} ${claudeCmd}`,
      ],
      EXEC_OPTIONS,
      (error) => {
        if (error) {
          log(`Failed to spawn session: ${error.message}`);
          reject(new Error(`Failed to spawn session: ${error.message}`));
          return;
        }

        const mode = options.mode || "auto-edit";

        const session: ManagedSession = {
          id,
          name,
          tmuxSession,
          status: "idle",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          cwd,
          mode,
        };

        managedSessions.set(id, session);
        log(
          `Created session: ${name} (${id.slice(0, 8)}) -> tmux:${tmuxSession} cmd:'${claudeCmd}' mode:${mode}`,
        );

        // Track git status for this session
        if (cwd) {
          gitStatusManager.track(id, cwd);
          // Remember this directory for future autocomplete
          projectsManager.addProject(cwd, name);
        }

        // If mode is 'plan', send /plan command after session boots
        if (mode === "plan") {
          // Wait for session to be ready before sending /plan
          setTimeout(() => {
            sendPromptToSession(id, "/plan").then((result) => {
              if (result.ok) {
                log(`Sent /plan to ${name}`);
              } else {
                log(`Failed to send /plan to ${name}: ${result.error}`);
              }
            });
          }, 3000);
        }

        // Broadcast and persist
        broadcastSessions();
        saveSessions();

        resolve(session);
      },
    );
  });
}

/**
 * Get all managed sessions
 */
function getSessions(): ManagedSession[] {
  return Array.from(managedSessions.values()).map((session) => ({
    ...session,
    gitStatus: gitStatusManager.getStatus(session.id) ?? undefined,
  }));
}

/**
 * Get a session by ID
 */
function getSession(id: string): ManagedSession | undefined {
  return managedSessions.get(id);
}

/**
 * Update a session
 */
function updateSession(
  id: string,
  updates: UpdateSessionRequest,
): ManagedSession | null {
  const session = managedSessions.get(id);
  if (!session) return null;

  if (updates.name) {
    session.name = updates.name;
  }
  if (updates.zonePosition) {
    session.zonePosition = updates.zonePosition;
  }

  log(`Updated session: ${session.name} (${id.slice(0, 8)})`);
  broadcastSessions();
  saveSessions();
  return session;
}

/**
 * Delete/kill a session
 */
function deleteSession(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const session = managedSessions.get(id);
    if (!session) {
      resolve(false);
      return;
    }

    // Kill the tmux session using execFile to prevent shell injection
    try {
      validateTmuxSession(session.tmuxSession);
    } catch {
      log(`Invalid tmux session name: ${session.tmuxSession}`);
      resolve(false);
      return;
    }

    execFile(
      "tmux",
      ["kill-session", "-t", session.tmuxSession],
      EXEC_OPTIONS,
      (error) => {
        if (error) {
          log(`Warning: Failed to kill tmux session: ${error.message}`);
        }

        managedSessions.delete(id);
        gitStatusManager.untrack(id);
        // Clean up mapping
        for (const [claudeId, managedId] of claudeToManagedMap) {
          if (managedId === id) {
            claudeToManagedMap.delete(claudeId);
          }
        }
        // Remove from any group
        removeSessionFromGroup(id);

        log(`Deleted session: ${session.name} (${id.slice(0, 8)})`);
        broadcastSessions();
        saveSessions();
        resolve(true);
      },
    );
  });
}

/**
 * Send a prompt to a specific session
 */
async function sendPromptToSession(
  id: string,
  prompt: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = managedSessions.get(id);
  if (!session) {
    return { ok: false, error: "Session not found" };
  }

  try {
    await sendToTmuxSafe(session.tmuxSession, prompt);
    session.lastActivity = Date.now();
    log(`Prompt sent to ${session.name}: ${prompt.slice(0, 50)}...`);
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to send prompt to ${session.name}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Check if tmux sessions are still alive and update status
 */
function checkSessionHealth(): void {
  exec(
    'tmux list-sessions -F "#{session_name}"',
    EXEC_OPTIONS,
    (error, stdout) => {
      if (error) {
        // tmux might not be running
        for (const session of managedSessions.values()) {
          if (session.status !== "offline") {
            session.status = "offline";
          }
        }
        return;
      }

      const activeSessions = new Set(stdout.trim().split("\n"));
      let changed = false;

      for (const session of managedSessions.values()) {
        const isAlive = activeSessions.has(session.tmuxSession);
        const newStatus = isAlive
          ? session.status === "offline"
            ? "idle"
            : session.status
          : "offline";

        if (session.status !== newStatus) {
          session.status = newStatus;
          changed = true;
        }
      }

      if (changed) {
        broadcastSessions();
        saveSessions(); // Persist state changes
      }
    },
  );
}

/**
 * Check for stale "working" sessions and transition them to idle
 * This is a failsafe for missed stop events
 */
function checkWorkingTimeout(): void {
  const now = Date.now();
  let changed = false;

  for (const session of managedSessions.values()) {
    if (session.status === "working") {
      const timeSinceActivity = now - session.lastActivity;
      if (timeSinceActivity > WORKING_TIMEOUT_MS) {
        log(
          `Session "${session.name}" timed out after ${Math.round(timeSinceActivity / 1000)}s of no activity`,
        );
        session.status = "idle";
        session.currentTool = undefined;
        changed = true;
      }
    }
  }

  if (changed) {
    broadcastSessions();
    saveSessions();
  }
}

/**
 * Save sessions to disk for persistence across restarts
 */
function saveSessions(): void {
  try {
    const data = {
      sessions: Array.from(managedSessions.values()),
      claudeToManagedMap: Array.from(claudeToManagedMap.entries()),
      sessionCounter,
    };
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    debug(`Saved ${managedSessions.size} sessions to ${SESSIONS_FILE}`);
  } catch (e) {
    console.error("Failed to save sessions:", e);
  }
}

/**
 * Load sessions from disk on startup
 */
function loadSessions(): void {
  if (!existsSync(SESSIONS_FILE)) {
    debug("No saved sessions file found");
    return;
  }

  try {
    const content = readFileSync(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(content);

    // Restore sessions
    if (Array.isArray(data.sessions)) {
      for (const session of data.sessions) {
        // Mark all as offline initially - health check will update
        session.status = "offline";
        session.currentTool = undefined;
        managedSessions.set(session.id, session);
        // Track git status if session has a cwd
        if (session.cwd) {
          gitStatusManager.track(session.id, session.cwd);
        }
      }
    }

    // Restore linking map
    if (Array.isArray(data.claudeToManagedMap)) {
      for (const [claudeId, managedId] of data.claudeToManagedMap) {
        claudeToManagedMap.set(claudeId, managedId);
      }
    }

    // Restore counter
    if (typeof data.sessionCounter === "number") {
      sessionCounter = data.sessionCounter;
    }

    log(`Loaded ${managedSessions.size} sessions from ${SESSIONS_FILE}`);
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}

/**
 * Broadcast current sessions to all clients
 */
function broadcastSessions(): void {
  broadcast({
    type: "sessions",
    payload: getSessions(),
  });
}

// ============================================================================
// Text Tiles (Grid Labels)
// ============================================================================

/**
 * Get all text tiles
 */
function getTiles(): TextTile[] {
  return Array.from(textTiles.values());
}

/**
 * Save text tiles to disk
 */
function saveTiles(): void {
  try {
    const data = Array.from(textTiles.values());
    writeFileSync(TILES_FILE, JSON.stringify(data, null, 2));
    debug(`Saved ${textTiles.size} tiles to ${TILES_FILE}`);
  } catch (e) {
    console.error("Failed to save tiles:", e);
  }
}

/**
 * Load text tiles from disk
 */
function loadTiles(): void {
  if (!existsSync(TILES_FILE)) {
    debug("No saved tiles file found");
    return;
  }

  try {
    const content = readFileSync(TILES_FILE, "utf-8");
    const data = JSON.parse(content) as TextTile[];

    for (const tile of data) {
      textTiles.set(tile.id, tile);
    }

    log(`Loaded ${textTiles.size} tiles from ${TILES_FILE}`);
  } catch (e) {
    console.error("Failed to load tiles:", e);
  }
}

/**
 * Broadcast text tiles to all clients
 */
function broadcastTiles(): void {
  broadcast({
    type: "text_tiles",
    payload: getTiles(),
  });
}

// ============================================================================
// Zone Groups (Adjacent Hex Grouping)
// ============================================================================

/**
 * Get all zone groups
 */
function getGroups(): ZoneGroup[] {
  return Array.from(zoneGroups.values());
}

/**
 * Save zone groups to disk
 */
function saveGroups(): void {
  try {
    const data = Array.from(zoneGroups.values());
    writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2));
    debug(`Saved ${zoneGroups.size} groups to ${GROUPS_FILE}`);
  } catch (e) {
    console.error("Failed to save groups:", e);
  }
}

/**
 * Load zone groups from disk
 */
function loadGroups(): void {
  if (!existsSync(GROUPS_FILE)) {
    debug("No saved groups file found");
    return;
  }

  try {
    const content = readFileSync(GROUPS_FILE, "utf-8");
    const data = JSON.parse(content) as ZoneGroup[];

    for (const group of data) {
      zoneGroups.set(group.id, group);
    }

    log(`Loaded ${zoneGroups.size} groups from ${GROUPS_FILE}`);
  } catch (e) {
    console.error("Failed to load groups:", e);
  }
}

/**
 * Broadcast zone groups to all clients
 */
function broadcastGroups(): void {
  broadcast({
    type: "zone_groups",
    payload: getGroups(),
  });
}

/**
 * Find the group a session belongs to (by managed session ID)
 */
function findGroupForSession(managedSessionId: string): ZoneGroup | undefined {
  for (const group of zoneGroups.values()) {
    if (group.memberSessionIds.includes(managedSessionId)) {
      return group;
    }
  }
  return undefined;
}

/**
 * Remove a session from its group. If only 1 member remains, dissolve the group.
 */
function removeSessionFromGroup(managedSessionId: string): void {
  const group = findGroupForSession(managedSessionId);
  if (!group) return;

  group.memberSessionIds = group.memberSessionIds.filter(
    (id) => id !== managedSessionId,
  );

  // Clear groupId on the session
  const session = managedSessions.get(managedSessionId);
  if (session) {
    session.groupId = undefined;
  }

  // If 1 or fewer members remain, dissolve the group
  if (group.memberSessionIds.length <= 1) {
    // Clear groupId on remaining member
    if (group.memberSessionIds.length === 1) {
      const remaining = managedSessions.get(group.memberSessionIds[0]);
      if (remaining) {
        remaining.groupId = undefined;
      }
    }
    zoneGroups.delete(group.id);
    log(`Dissolved group "${group.name || group.id}" (too few members)`);
  }

  saveGroups();
  saveSessions();
  broadcastGroups();
  broadcastSessions();
}

// ============================================================================
// Voice Transcription (Deepgram)
// ============================================================================

/**
 * Start a voice transcription session for a WebSocket client
 */
function startVoiceSession(ws: WebSocket): boolean {
  if (!deepgramApiKey) {
    ws.send(
      JSON.stringify({
        type: "voice_error",
        payload: { error: "Voice input not configured" },
      }),
    );
    return false;
  }

  // Clean up any existing session
  stopVoiceSession(ws);

  try {
    const deepgram = createClient(deepgramApiKey);
    const connection = deepgram.listen.live({
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      encoding: "linear16",
      sample_rate: 16000,
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      ws.send(JSON.stringify({ type: "voice_ready", payload: {} }));
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript) {
        ws.send(
          JSON.stringify({
            type: "voice_transcript",
            payload: { transcript, isFinal: data.is_final },
          }),
        );
      }
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      ws.send(JSON.stringify({ type: "voice_utterance_end", payload: {} }));
    });

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      log(`Deepgram error: ${error}`);
      ws.send(
        JSON.stringify({
          type: "voice_error",
          payload: { error: String(error) },
        }),
      );
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      voiceSessions.delete(ws);
    });

    voiceSessions.set(ws, connection);
    debug("Voice session started");
    return true;
  } catch (e) {
    log(`Failed to start voice session: ${e}`);
    ws.send(
      JSON.stringify({ type: "voice_error", payload: { error: String(e) } }),
    );
    return false;
  }
}

/**
 * Stop a voice transcription session
 */
function stopVoiceSession(ws: WebSocket): void {
  const connection = voiceSessions.get(ws);
  if (connection) {
    try {
      connection.requestClose();
    } catch (e) {
      // Ignore close errors
    }
    voiceSessions.delete(ws);
    debug("Voice session stopped");
  }
}

/**
 * Send audio data to Deepgram for transcription
 */
function sendVoiceAudio(ws: WebSocket, audioData: Buffer): void {
  const connection = voiceSessions.get(ws);
  if (!connection) return;

  try {
    // Convert Node.js Buffer to ArrayBuffer for Deepgram SDK
    const arrayBuffer = audioData.buffer.slice(
      audioData.byteOffset,
      audioData.byteOffset + audioData.byteLength,
    );
    connection.send(arrayBuffer);
  } catch (e) {
    debug(`Error sending audio: ${e}`);
  }
}

/**
 * Link a Claude Code session ID to a managed session
 */
function linkClaudeSession(
  claudeSessionId: string,
  managedSessionId: string,
): void {
  claudeToManagedMap.set(claudeSessionId, managedSessionId);
}

/**
 * Find managed session by Claude Code session ID
 */
function findManagedSession(
  claudeSessionId: string,
): ManagedSession | undefined {
  const managedId = claudeToManagedMap.get(claudeSessionId);
  if (managedId) {
    return managedSessions.get(managedId);
  }
  return undefined;
}

// ============================================================================
// Event Processing
// ============================================================================

function processEvent(event: ClaudeEvent): ClaudeEvent {
  // Track pre_tool_use for duration calculation
  if (event.type === "pre_tool_use") {
    const preEvent = event as PreToolUseEvent;
    pendingToolUses.set(preEvent.toolUseId, preEvent);
    debug(`Tracking tool use: ${preEvent.tool} (${preEvent.toolUseId})`);
  }

  // Calculate duration for post_tool_use
  if (event.type === "post_tool_use") {
    const postEvent = event as PostToolUseEvent;
    const preEvent = pendingToolUses.get(postEvent.toolUseId);
    if (preEvent) {
      postEvent.duration = postEvent.timestamp - preEvent.timestamp;
      pendingToolUses.delete(postEvent.toolUseId);
      debug(`Tool ${postEvent.tool} took ${postEvent.duration}ms`);
    }
  }

  return event;
}

function addEvent(event: ClaudeEvent) {
  // Skip duplicates (hook writes to file AND posts to server)
  if (seenEventIds.has(event.id)) {
    debug(`Skipping duplicate event: ${event.id}`);
    return;
  }
  seenEventIds.add(event.id);

  // Trim old IDs to prevent memory leak (keep last 2x MAX_EVENTS)
  if (seenEventIds.size > MAX_EVENTS * 2) {
    const idsToKeep = [...seenEventIds].slice(-MAX_EVENTS);
    seenEventIds.clear();
    idsToKeep.forEach((id) => seenEventIds.add(id));
  }

  const processed = processEvent(event);
  events.push(processed);

  // Trim old events if over limit
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }

  // Update managed session status based on event
  const managedSession = findManagedSession(event.sessionId);
  if (managedSession) {
    const prevStatus = managedSession.status;
    managedSession.lastActivity = Date.now(); // Use current time for accurate timeout tracking
    managedSession.cwd = event.cwd;

    // Update status based on event type
    switch (event.type) {
      case "pre_tool_use":
        managedSession.status = "working";
        managedSession.currentTool = (event as PreToolUseEvent).tool;
        break;

      case "post_tool_use":
        // Tool completed - update activity time but stay "working"
        // (Claude might be using more tools, stop event marks idle)
        managedSession.currentTool = undefined;
        break;

      case "user_prompt_submit":
        // User submitted prompt - Claude is now processing
        managedSession.status = "working";
        managedSession.currentTool = undefined;
        break;

      case "stop":
      case "session_end":
        managedSession.status = "idle";
        managedSession.currentTool = undefined;
        break;
    }

    // Broadcast and persist if status changed
    if (managedSession.status !== prevStatus) {
      broadcastSessions();
      saveSessions();
    }
  }

  // Broadcast to all clients
  broadcast({ type: "event", payload: processed });
}

// ============================================================================
// File Watching
// ============================================================================

function loadEventsFromFile() {
  if (!existsSync(EVENTS_FILE)) {
    debug(`Events file not found: ${EVENTS_FILE}`);
    return;
  }

  const content = readFileSync(EVENTS_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as ClaudeEvent;
      processEvent(event);
      events.push(event);
    } catch (e) {
      debug(`Failed to parse event line: ${line}`);
    }
  }

  lastFileSize = content.length;
  log(`Loaded ${events.length} events from file`);
}

function watchEventsFile() {
  // Ensure directory exists
  const dir = dirname(EVENTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Create file if it doesn't exist
  if (!existsSync(EVENTS_FILE)) {
    appendFileSync(EVENTS_FILE, "");
  }

  const watcher = watch(EVENTS_FILE, {
    persistent: true,
    usePolling: true,
    interval: 100,
  });

  watcher.on("change", () => {
    try {
      const content = readFileSync(EVENTS_FILE, "utf-8");

      // Only process new content
      if (content.length > lastFileSize) {
        const newContent = content.slice(lastFileSize);
        const newLines = newContent.trim().split("\n").filter(Boolean);

        for (const line of newLines) {
          try {
            const event = JSON.parse(line) as ClaudeEvent;
            addEvent(event);
            debug(`New event from file: ${event.type}`);
          } catch (e) {
            debug(`Failed to parse new event: ${line}`);
          }
        }

        lastFileSize = content.length;
      }
    } catch (e) {
      debug(`Error reading events file: ${e}`);
    }
  });

  log(`Watching events file: ${EVENTS_FILE}`);
}

// ============================================================================
// WebSocket
// ============================================================================

function broadcast(message: ServerMessage) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case "subscribe":
      debug("Client subscribed");
      break;

    case "get_history": {
      const limit = message.payload?.limit ?? 100;
      const history = events.slice(-limit);
      const response: ServerMessage = { type: "history", payload: history };
      ws.send(JSON.stringify(response));
      debug(`Sent ${history.length} historical events`);
      break;
    }

    case "ping":
      // Just acknowledge, no response needed
      break;

    case "voice_start":
      startVoiceSession(ws);
      break;

    case "voice_stop":
      stopVoiceSession(ws);
      break;

    case "permission_response": {
      const { sessionId, response } = message.payload;
      sendPermissionResponse(sessionId, response);
      break;
    }

    default:
      debug(`Unknown message type: ${(message as { type: string }).type}`);
  }
}

// ============================================================================
// HTTP Server (for hook notifications)
// ============================================================================

function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;

  // CORS headers - only allow specific origins
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    // Preflight: reject if origin not allowed
    if (!origin || !isOriginAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/event") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const event = JSON.parse(body) as ClaudeEvent;
          addEvent(event);
          debug(`Received event via HTTP: ${event.type}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          debug(`Failed to parse HTTP event: ${e}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      })
      .catch(() => {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      });
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        clients: clients.size,
        events: events.length,
        voiceEnabled: !!deepgramApiKey,
      }),
    );
    return;
  }

  // Config (username, etc)
  if (req.method === "GET" && req.url === "/config") {
    const username = process.env.USER || process.env.USERNAME || "claude-user";
    const host = hostname();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        username,
        hostname: host,
        tmuxSession: TMUX_SESSION,
      }),
    );
    return;
  }

  // Stats
  if (req.method === "GET" && req.url === "/stats") {
    const toolCounts: Record<string, number> = {};
    const toolDurations: Record<string, number[]> = {};

    for (const event of events) {
      if (event.type === "post_tool_use") {
        const e = event as PostToolUseEvent;
        toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
        if (e.duration !== undefined) {
          toolDurations[e.tool] = toolDurations[e.tool] ?? [];
          toolDurations[e.tool].push(e.duration);
        }
      }
    }

    const avgDurations: Record<string, number> = {};
    for (const [tool, durations] of Object.entries(toolDurations)) {
      avgDurations[tool] = Math.round(
        durations.reduce((a, b) => a + b, 0) / durations.length,
      );
    }

    // Collect token data
    const tokens: Record<string, { current: number; cumulative: number }> = {};
    for (const [session, data] of sessionTokens) {
      tokens[session] = { current: data.lastSeen, cumulative: data.cumulative };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        totalEvents: events.length,
        toolCounts,
        avgDurations,
        tokens,
      }),
    );
    return;
  }

  // Submit prompt from browser
  if (req.method === "POST" && req.url === "/prompt") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const { prompt, send } = JSON.parse(body) as {
            prompt: string;
            send?: boolean;
          };
          if (!prompt || typeof prompt !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Prompt is required" }));
            return;
          }

          // Write prompt to file
          const dir = dirname(PENDING_PROMPT_FILE);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(PENDING_PROMPT_FILE, prompt, "utf-8");
          log(`Prompt saved: ${prompt.slice(0, 50)}...`);

          // If send=true, inject into tmux session
          if (send) {
            // Use safe helper to prevent command injection
            sendToTmuxSafe(TMUX_SESSION, prompt)
              .then(() => {
                log(`Prompt sent to tmux session: ${TMUX_SESSION}`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: true,
                    saved: PENDING_PROMPT_FILE,
                    sent: true,
                  }),
                );
              })
              .catch((error) => {
                log(`tmux send failed: ${error.message}`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: true,
                    saved: PENDING_PROMPT_FILE,
                    sent: false,
                    tmuxError: error.message,
                  }),
                );
              });
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, saved: PENDING_PROMPT_FILE }));
        } catch (e) {
          debug(`Failed to save prompt: ${e}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      })
      .catch(() => {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      });
    return;
  }

  // Get pending prompt
  if (req.method === "GET" && req.url === "/prompt") {
    if (existsSync(PENDING_PROMPT_FILE)) {
      const prompt = readFileSync(PENDING_PROMPT_FILE, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt, file: PENDING_PROMPT_FILE }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt: null }));
    }
    return;
  }

  // Clear pending prompt
  if (req.method === "DELETE" && req.url === "/prompt") {
    if (existsSync(PENDING_PROMPT_FILE)) {
      unlinkSync(PENDING_PROMPT_FILE);
      log("Pending prompt cleared");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Get tmux output (Claude's responses)
  if (req.method === "GET" && req.url === "/tmux-output") {
    try {
      validateTmuxSession(TMUX_SESSION);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "Invalid tmux session name",
          output: "",
        }),
      );
      return;
    }

    // Capture last 100 lines from tmux pane
    execFile(
      "tmux",
      ["capture-pane", "-t", TMUX_SESSION, "-p", "-S", "-100"],
      { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: error.message, output: "" }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, output: stdout }));
      },
    );
    return;
  }

  // Cancel - send Ctrl+C to tmux (legacy, for backwards compat)
  if (req.method === "POST" && req.url === "/cancel") {
    try {
      validateTmuxSession(TMUX_SESSION);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "Invalid tmux session name" }),
      );
      return;
    }

    execFile(
      "tmux",
      ["send-keys", "-t", TMUX_SESSION, "C-c"],
      EXEC_OPTIONS,
      (error) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (error) {
          log(`Cancel failed: ${error.message}`);
          res.end(JSON.stringify({ ok: false, error: error.message }));
        } else {
          log(`Sent Ctrl+C to tmux session: ${TMUX_SESSION}`);
          res.end(JSON.stringify({ ok: true }));
        }
      },
    );
    return;
  }

  // ============================================================================
  // Session Management Endpoints
  // ============================================================================

  // Get server info (cwd, etc.)
  if (req.method === "GET" && req.url === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cwd: process.cwd() }));
    return;
  }

  // List all sessions
  if (req.method === "GET" && req.url === "/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: getSessions() }));
    return;
  }

  // Force refresh sessions (trigger health check)
  if (req.method === "POST" && req.url === "/sessions/refresh") {
    log("Manual session refresh requested");
    checkSessionHealth();
    // Return current sessions (health check updates async, but we give immediate response)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: getSessions() }));
    return;
  }

  // Create a new session
  if (req.method === "POST" && req.url === "/sessions") {
    collectRequestBody(req)
      .then(async (body) => {
        try {
          const options = body
            ? (JSON.parse(body) as CreateSessionRequest)
            : {};
          const session = await createSession(options);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, session }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      })
      .catch(() => {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      });
    return;
  }

  // ============================================================================
  // Projects API (known directories for autocomplete)
  // ============================================================================

  // List all known projects
  if (req.method === "GET" && req.url === "/projects") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, projects: projectsManager.getProjects() }),
    );
    return;
  }

  // Autocomplete path
  if (req.method === "GET" && req.url?.startsWith("/projects/autocomplete")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const query = url.searchParams.get("q") || "";
    const results = projectsManager.autocomplete(query);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, results }));
    return;
  }

  // Remove a project from the list
  if (req.method === "DELETE" && req.url?.startsWith("/projects/")) {
    const path = decodeURIComponent(req.url.slice("/projects/".length));
    projectsManager.removeProject(path);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Session-specific endpoints: /sessions/:id
  const sessionMatch = req.url?.match(/^\/sessions\/([a-f0-9-]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const action = sessionMatch[2]; // e.g., "prompt", "cancel"

    // GET /sessions/:id - Get session details
    if (req.method === "GET" && !action) {
      const session = getSession(sessionId);
      if (session) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, session }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
      }
      return;
    }

    // PATCH /sessions/:id - Update session (rename)
    if (req.method === "PATCH" && !action) {
      collectRequestBody(req)
        .then((body) => {
          try {
            const updates = JSON.parse(body) as UpdateSessionRequest;
            const session = updateSession(sessionId, updates);
            if (session) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, session }));
            } else {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Session not found" }),
              );
            }
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }

    // DELETE /sessions/:id - Kill session
    if (req.method === "DELETE" && !action) {
      deleteSession(sessionId).then((deleted) => {
        if (deleted) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        }
      });
      return;
    }

    // POST /sessions/:id/prompt - Send prompt to specific session
    if (req.method === "POST" && action === "prompt") {
      collectRequestBody(req)
        .then(async (body) => {
          try {
            const { prompt } = JSON.parse(body) as SessionPromptRequest;
            if (!prompt) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Prompt is required" }),
              );
              return;
            }
            const result = await sendPromptToSession(sessionId, prompt);
            res.writeHead(result.ok ? 200 : 404, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }

    // POST /sessions/:id/cancel - Send Ctrl+C to specific session
    if (req.method === "POST" && action === "cancel") {
      const session = getSession(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }

      try {
        validateTmuxSession(session.tmuxSession);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "Invalid tmux session name" }),
        );
        return;
      }

      execFile(
        "tmux",
        ["send-keys", "-t", session.tmuxSession, "C-c"],
        EXEC_OPTIONS,
        (error) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          if (error) {
            res.end(JSON.stringify({ ok: false, error: error.message }));
          } else {
            log(`Sent Ctrl+C to ${session.name}`);
            res.end(JSON.stringify({ ok: true }));
          }
        },
      );
      return;
    }

    // POST /sessions/:id/mode - Switch Claude Code mode
    if (req.method === "POST" && action === "mode") {
      const session = getSession(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }

      collectRequestBody(req)
        .then(async (body) => {
          try {
            const { mode } = JSON.parse(body) as { mode: string };
            if (
              !mode ||
              !["auto-edit", "plan", "ask-before-edit"].includes(mode)
            ) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Invalid mode" }));
              return;
            }

            const oldMode = session.mode || "auto-edit";
            const needsRestart =
              (oldMode === "ask-before-edit" && mode !== "ask-before-edit") ||
              (oldMode !== "ask-before-edit" && mode === "ask-before-edit");

            if (needsRestart) {
              // Cannot switch between ask-before-edit and auto-edit/plan at runtime
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "restart_required",
                  message: `Switching from ${oldMode} to ${mode} requires a session restart`,
                }),
              );
              return;
            }

            // Toggle plan mode via /plan command
            if (mode === "plan" && oldMode !== "plan") {
              const result = await sendPromptToSession(session.id, "/plan");
              if (!result.ok) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: result.error }));
                return;
              }
            } else if (mode !== "plan" && oldMode === "plan") {
              // Exit plan mode by sending /plan again (toggle)
              const result = await sendPromptToSession(session.id, "/plan");
              if (!result.ok) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: result.error }));
                return;
              }
            }

            session.mode = mode as any;
            log(`Mode changed for ${session.name}: ${oldMode} -> ${mode}`);
            broadcastSessions();
            saveSessions();

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, session }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }

    // POST /sessions/:id/permission - Respond to a permission prompt
    if (req.method === "POST" && action === "permission") {
      const session = getSession(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }

      collectRequestBody(req)
        .then((body) => {
          try {
            const { response } = JSON.parse(body) as { response: string };
            if (!response) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Missing response field" }),
              );
              return;
            }

            sendPermissionResponse(sessionId, response);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }

    // POST /sessions/:id/restart - Restart an offline session
    if (req.method === "POST" && action === "restart") {
      const session = getSession(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }

      // Validate inputs to prevent command injection
      try {
        validateTmuxSession(session.tmuxSession);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "Invalid tmux session name" }),
        );
        return;
      }

      let cwd: string;
      try {
        cwd = validateDirectoryPath(session.cwd || process.cwd());
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: `Invalid directory: ${err instanceof Error ? err.message : err}`,
          }),
        );
        return;
      }

      // Kill existing tmux session if it exists (ignore errors)
      execFile(
        "tmux",
        ["kill-session", "-t", session.tmuxSession],
        EXEC_OPTIONS,
        () => {
          // Respawn tmux session with claude using execFile
          execFile(
            "tmux",
            [
              "new-session",
              "-d",
              "-s",
              session.tmuxSession,
              "-c",
              cwd,
              `PATH=${EXEC_PATH} claude -c --permission-mode=bypassPermissions --dangerously-skip-permissions`,
            ],
            EXEC_OPTIONS,
            (error) => {
              if (error) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: `Failed to restart: ${error.message}`,
                  }),
                );
                return;
              }

              // Update session state
              session.status = "idle";
              session.lastActivity = Date.now();
              session.claudeSessionId = undefined; // Will be re-linked when events come in
              session.currentTool = undefined;

              // Clear old linking
              for (const [claudeId, managedId] of claudeToManagedMap) {
                if (managedId === session.id) {
                  claudeToManagedMap.delete(claudeId);
                }
              }

              log(
                `Restarted session: ${session.name} (${session.id.slice(0, 8)})`,
              );
              broadcastSessions();
              saveSessions();

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, session }));
            },
          );
        },
      );
      return;
    }

    // POST /sessions/:id/link - Link Claude session ID to managed session
    if (req.method === "POST" && action === "link") {
      collectRequestBody(req)
        .then((body) => {
          try {
            const { claudeSessionId } = JSON.parse(body) as {
              claudeSessionId: string;
            };
            if (!claudeSessionId) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "claudeSessionId is required",
                }),
              );
              return;
            }
            const session = getSession(sessionId);
            if (!session) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Session not found" }),
              );
              return;
            }
            linkClaudeSession(claudeSessionId, sessionId);
            session.claudeSessionId = claudeSessionId;
            log(
              `Linked Claude session ${claudeSessionId.slice(0, 8)} to ${session.name}`,
            );
            broadcastSessions();
            saveSessions();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, session }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Zone Groups API
  // -------------------------------------------------------------------------

  // GET /groups - List all zone groups
  if (req.method === "GET" && req.url === "/groups") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, groups: getGroups() }));
    return;
  }

  // POST /groups - Create a new zone group
  if (req.method === "POST" && req.url === "/groups") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as CreateZoneGroupRequest;

          if (
            !data.memberSessionIds ||
            !Array.isArray(data.memberSessionIds) ||
            data.memberSessionIds.length < 2
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Need at least 2 session IDs",
              }),
            );
            return;
          }

          // Verify all sessions exist
          for (const sid of data.memberSessionIds) {
            if (!managedSessions.has(sid)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Session ${sid} not found`,
                }),
              );
              return;
            }
          }

          // Remove members from existing groups first
          for (const sid of data.memberSessionIds) {
            removeSessionFromGroup(sid);
          }

          const group: ZoneGroup = {
            id: crypto.randomUUID(),
            name: data.name,
            memberSessionIds: data.memberSessionIds,
            createdAt: Date.now(),
          };

          zoneGroups.set(group.id, group);

          // Set groupId on each member session
          for (const sid of group.memberSessionIds) {
            const session = managedSessions.get(sid);
            if (session) {
              session.groupId = group.id;
            }
          }

          saveGroups();
          saveSessions();
          broadcastGroups();
          broadcastSessions();

          log(
            `Created group "${group.name || group.id.slice(0, 8)}" with ${group.memberSessionIds.length} members`,
          );
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, group }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        }
      })
      .catch(() => {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      });
    return;
  }

  // Handle /groups/:id routes
  const groupsIdMatch = req.url?.match(/^\/groups\/([^/?]+)/);
  if (groupsIdMatch) {
    const groupId = groupsIdMatch[1];
    const group = zoneGroups.get(groupId);

    // DELETE /groups/:id - Dissolve a group
    if (req.method === "DELETE") {
      if (!group) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Group not found" }));
        return;
      }

      // Clear groupId on all members
      for (const sid of group.memberSessionIds) {
        const session = managedSessions.get(sid);
        if (session) {
          session.groupId = undefined;
        }
      }

      zoneGroups.delete(groupId);
      saveGroups();
      saveSessions();
      broadcastGroups();
      broadcastSessions();

      log(`Dissolved group "${group.name || groupId.slice(0, 8)}"`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Text Tiles API
  // -------------------------------------------------------------------------

  // GET /tiles - List all text tiles
  if (req.method === "GET" && req.url === "/tiles") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tiles: getTiles() }));
    return;
  }

  // POST /tiles - Create a new text tile
  if (req.method === "POST" && req.url === "/tiles") {
    collectRequestBody(req)
      .then((body) => {
        try {
          const data = JSON.parse(body) as CreateTextTileRequest;

          if (!data.text || !data.position) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ ok: false, error: "Missing text or position" }),
            );
            return;
          }

          const tile: TextTile = {
            id: crypto.randomUUID(),
            text: data.text,
            position: data.position,
            color: data.color,
            createdAt: Date.now(),
          };

          textTiles.set(tile.id, tile);
          saveTiles();
          broadcastTiles();

          log(
            `Created text tile: "${tile.text}" at (${tile.position.q}, ${tile.position.r})`,
          );
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, tile }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        }
      })
      .catch(() => {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      });
    return;
  }

  // Handle /tiles/:id routes
  const tilesIdMatch = req.url?.match(/^\/tiles\/([^/?]+)/);
  if (tilesIdMatch) {
    const tileId = tilesIdMatch[1];
    const tile = textTiles.get(tileId);

    // PUT /tiles/:id - Update a text tile
    if (req.method === "PUT") {
      if (!tile) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Tile not found" }));
        return;
      }

      collectRequestBody(req)
        .then((body) => {
          try {
            const data = JSON.parse(body) as UpdateTextTileRequest;

            if (data.text !== undefined) tile.text = data.text;
            if (data.position !== undefined) tile.position = data.position;
            if (data.color !== undefined) tile.color = data.color;

            saveTiles();
            broadcastTiles();

            log(`Updated text tile: "${tile.text}"`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, tile }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        })
        .catch(() => {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
      return;
    }

    // DELETE /tiles/:id - Delete a text tile
    if (req.method === "DELETE") {
      if (!tile) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Tile not found" }));
        return;
      }

      textTiles.delete(tileId);
      saveTiles();
      broadcastTiles();

      log(`Deleted text tile: "${tile.text}"`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // Static file serving for frontend (production mode)
  serveStaticFile(req, res);
}

/** MIME types for static files */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve static files from dist/ directory */
function serveStaticFile(req: IncomingMessage, res: ServerResponse): void {
  // Determine the dist directory (relative to this file when compiled)
  // Compiled server is at: dist/server/server/index.js
  // So ../../ gets us to dist/
  const distDir = resolve(dirname(new URL(import.meta.url).pathname), "../..");

  // Parse the URL path
  let urlPath = req.url?.split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  // Security: prevent directory traversal
  // 1. Decode URL-encoded characters to catch %2e%2e (encoded ..)
  // 2. Resolve to absolute path
  // 3. Verify result is within distDir
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    // Invalid URL encoding
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const filePath = resolve(distDir, "." + decodedPath);

  // Check for path traversal: resolved path must start with distDir
  if (!filePath.startsWith(distDir + "/") && filePath !== distDir) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Check if file exists
  if (!existsSync(filePath)) {
    // For SPA, serve index.html for non-API routes
    const indexPath = join(distDir, "index.html");
    if (existsSync(indexPath) && !decodedPath.startsWith("/api")) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Serve the file
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

// ============================================================================
// Main
// ============================================================================

function main() {
  log("Starting Vibecraft server...");

  // Load Deepgram API key for voice transcription
  deepgramApiKey = loadDeepgramKey();

  // Load existing events
  loadEventsFromFile();

  // Load saved sessions (for persistence across restarts)
  loadSessions();

  // Load saved text tiles
  loadTiles();

  // Load saved zone groups
  loadGroups();

  // Start git status tracking
  gitStatusManager.setUpdateHandler(({ sessionId, status }) => {
    const session = managedSessions.get(sessionId);
    if (session) {
      debug(
        `Git status updated for ${session.name}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`,
      );
      // Broadcast updated sessions to all clients
      broadcastSessions();
    }
  });
  gitStatusManager.start();

  // Watch for new events
  watchEventsFile();

  // Create HTTP server
  const httpServer = createServer(handleHttpRequest);

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    // CSRF protection: validate Origin header
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      log(`Rejected WebSocket connection from origin: ${origin}`);
      ws.close(1008, "Origin not allowed");
      return;
    }

    clients.add(ws);
    log(
      `Client connected (${clients.size} total)${origin ? ` from ${origin}` : ""}`,
    );

    // Send connection confirmation
    const connectMsg: ServerMessage = {
      type: "connected",
      payload: { sessionId: events[events.length - 1]?.sessionId ?? "unknown" },
    };
    ws.send(JSON.stringify(connectMsg));

    // IMPORTANT: Send sessions BEFORE history so client can link events to sessions
    const sessionsMsg: ServerMessage = {
      type: "sessions",
      payload: getSessions(),
    };
    ws.send(JSON.stringify(sessionsMsg));

    // Send text tiles
    const tilesMsg: ServerMessage = {
      type: "text_tiles",
      payload: getTiles(),
    };
    ws.send(JSON.stringify(tilesMsg));

    // Send zone groups
    const groupsMsg: ServerMessage = {
      type: "zone_groups",
      payload: getGroups(),
    };
    ws.send(JSON.stringify(groupsMsg));

    // Send recent history - filtered to only include events from current managed sessions
    const activeClaudeSessionIds = new Set(
      Array.from(managedSessions.values())
        .map((s) => s.claudeSessionId)
        .filter(Boolean),
    );
    const filteredHistory = events
      .filter((e) => activeClaudeSessionIds.has(e.sessionId))
      .slice(-50);
    const historyMsg: ServerMessage = {
      type: "history",
      payload: filteredHistory,
    };
    ws.send(JSON.stringify(historyMsg));

    ws.on("message", (data: RawData, isBinary: boolean) => {
      // Handle binary audio data for voice transcription
      if (isBinary) {
        const audioBuffer = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        sendVoiceAudio(ws, audioBuffer);
        return;
      }

      // Handle JSON messages
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        handleClientMessage(ws, message);
      } catch (e) {
        debug(`Failed to parse client message: ${e}`);
      }
    });

    ws.on("close", () => {
      stopVoiceSession(ws); // Clean up any voice session
      clients.delete(ws);
      log(`Client disconnected (${clients.size} total)`);
    });

    ws.on("error", (error) => {
      debug(`WebSocket error: ${error}`);
      stopVoiceSession(ws); // Clean up any voice session
      clients.delete(ws);
    });
  });

  httpServer.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
    log(``);
    log(`Open https://vibecraft.sh to view your workshop`);
    log(``);
    log(`Local API endpoints:`);
    log(`  WebSocket: ws://localhost:${PORT}`);
    log(`  Events: http://localhost:${PORT}/event`);
    log(`  Prompt: http://localhost:${PORT}/prompt`);
    log(`  Health: http://localhost:${PORT}/health`);
    log(`  Stats: http://localhost:${PORT}/stats`);
    log(`  Sessions: http://localhost:${PORT}/sessions`);

    // Start token polling after server is ready
    startTokenPolling();

    // Start permission prompt polling
    startPermissionPolling();

    // Start session health checking (every 5 seconds)
    setInterval(checkSessionHealth, 5000);

    // Start working timeout checking (every 10 seconds)
    setInterval(checkWorkingTimeout, WORKING_CHECK_INTERVAL_MS);

    // Run initial health check to update session statuses
    checkSessionHealth();
  });
}

main();
