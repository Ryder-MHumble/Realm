/**
 * Realm Server Configuration
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

  // Bot bridge (legacy env-based, prefer settings.json for new config)
  botEnabled: boolean;
  botPlatform: string;
  feishuWebhookUrl: string;
  feishuAppId: string;
  feishuAppSecret: string;

  // Settings file (agent providers + notification channels)
  settingsFile: string;
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
    if (url.hostname === "realm.sh" && url.protocol === "https:") {
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
      process.env.REALM_PORT ?? String(DEFAULTS.SERVER_PORT),
      10,
    ),
    eventsFile: resolve(
      expandHome(process.env.REALM_EVENTS_FILE ?? DEFAULTS.EVENTS_FILE),
    ),
    pendingPromptFile: resolve(
      expandHome(
        process.env.REALM_PROMPT_FILE ??
          "~/.realm/data/pending-prompt.txt",
      ),
    ),
    maxEvents: parseInt(
      process.env.REALM_MAX_EVENTS ?? String(DEFAULTS.MAX_EVENTS),
      10,
    ),
    debug: process.env.REALM_DEBUG === "true",
    tmuxSession: process.env.REALM_TMUX_SESSION ?? DEFAULTS.TMUX_SESSION,
    sessionsFile: resolve(
      expandHome(process.env.REALM_SESSIONS_FILE ?? DEFAULTS.SESSIONS_FILE),
    ),
    tilesFile: resolve(
      expandHome(
        process.env.REALM_TILES_FILE ?? "~/.realm/data/tiles.json",
      ),
    ),
    groupsFile: resolve(expandHome("~/.realm/data/groups.json")),
    workingTimeoutMs: 300_000,
    maxBodySize: 1024 * 1024,
    workingCheckIntervalMs: 10_000,
    uploadsDir: resolve(expandHome("~/.realm/uploads")),
    execPath,
    execOptions: { env: { ...process.env, PATH: execPath } },
    version: getPackageVersion(__dirname),

    // Bot bridge
    botEnabled: process.env.REALM_BOT_ENABLED === "true",
    botPlatform: process.env.REALM_BOT_PLATFORM ?? "feishu",
    feishuWebhookUrl: process.env.REALM_FEISHU_WEBHOOK_URL ?? "",
    feishuAppId: process.env.REALM_FEISHU_APP_ID ?? "",
    feishuAppSecret: process.env.REALM_FEISHU_APP_SECRET ?? "",

    settingsFile: resolve(
      expandHome(
        process.env.REALM_SETTINGS_FILE ??
          "~/.realm/data/settings.json",
      ),
    ),
  };
}
