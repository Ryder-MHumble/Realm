/**
 * Vibecraft Server Configuration
 *
 * Loads configuration from environment variables with defaults from shared/defaults.ts.
 * Also provides path validation and origin checking utilities.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { DEFAULTS } from "../shared/defaults.js";

// ============================================================================
// Types
// ============================================================================

export interface ServerConfig {
  port: number;
  eventsFile: string;
  pendingPromptFile: string;
  maxEvents: number;
  debug: boolean;
  tmuxSession: string;
  sessionsFile: string;
  tilesFile: string;
  groupsFile: string;
  workingTimeoutMs: number;
  maxBodySize: number;
  workingCheckIntervalMs: number;
  uploadsDir: string;
  execPath: string;
  execOptions: { env: NodeJS.ProcessEnv };
  version: string;

  // Bot bridge
  botEnabled: boolean;
  botPlatform: string;
  feishuWebhookUrl: string;
  feishuAppId: string;
  feishuAppSecret: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Expand ~ to home directory in paths */
export function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}

/**
 * Validate WebSocket origin header to prevent CSRF attacks.
 * Only browser clients should connect, so we require a valid origin.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
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
    return false;
  }
}

// ============================================================================
// Version
// ============================================================================

function getPackageVersion(serverDir: string): string {
  try {
    const locations = [
      resolve(serverDir, "../package.json"),
      resolve(serverDir, "../../package.json"),
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

// ============================================================================
// Load Config
// ============================================================================

export function loadConfig(): ServerConfig {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const HOME = process.env.HOME || "";
  const execPath = [
    `${HOME}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ].join(":");

  return {
    port: parseInt(
      process.env.VIBECRAFT_PORT ?? String(DEFAULTS.SERVER_PORT),
      10,
    ),
    eventsFile: resolve(
      expandHome(process.env.VIBECRAFT_EVENTS_FILE ?? DEFAULTS.EVENTS_FILE),
    ),
    pendingPromptFile: resolve(
      expandHome(
        process.env.VIBECRAFT_PROMPT_FILE ??
          "~/.vibecraft/data/pending-prompt.txt",
      ),
    ),
    maxEvents: parseInt(
      process.env.VIBECRAFT_MAX_EVENTS ?? String(DEFAULTS.MAX_EVENTS),
      10,
    ),
    debug: process.env.VIBECRAFT_DEBUG === "true",
    tmuxSession: process.env.VIBECRAFT_TMUX_SESSION ?? DEFAULTS.TMUX_SESSION,
    sessionsFile: resolve(
      expandHome(process.env.VIBECRAFT_SESSIONS_FILE ?? DEFAULTS.SESSIONS_FILE),
    ),
    tilesFile: resolve(
      expandHome(
        process.env.VIBECRAFT_TILES_FILE ?? "~/.vibecraft/data/tiles.json",
      ),
    ),
    groupsFile: resolve(expandHome("~/.vibecraft/data/groups.json")),
    workingTimeoutMs: 300_000,
    maxBodySize: 1024 * 1024,
    workingCheckIntervalMs: 10_000,
    uploadsDir: resolve(expandHome("~/.vibecraft/uploads")),
    execPath,
    execOptions: { env: { ...process.env, PATH: execPath } },
    version: getPackageVersion(__dirname),

    // Bot bridge
    botEnabled: process.env.VIBECRAFT_BOT_ENABLED === "true",
    botPlatform: process.env.VIBECRAFT_BOT_PLATFORM ?? "feishu",
    feishuWebhookUrl: process.env.VIBECRAFT_FEISHU_WEBHOOK_URL ?? "",
    feishuAppId: process.env.VIBECRAFT_FEISHU_APP_ID ?? "",
    feishuAppSecret: process.env.VIBECRAFT_FEISHU_APP_SECRET ?? "",
  };
}
