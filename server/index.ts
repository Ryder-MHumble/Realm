/**
 * Vibecraft WebSocket Server — Orchestrator
 *
 * Slim entrypoint that instantiates all managers, wires their callbacks,
 * and starts the HTTP + WebSocket server.
 */

import { createServer } from "http";
import { WebSocketServer, RawData } from "ws";
import { execFile } from "child_process";
import { readdirSync, unlinkSync } from "fs";

// Foundation
import { loadConfig, isOriginAllowed } from "./config.js";
import { log, debug, setDebug } from "./logger.js";
import { initTmuxUtils } from "./tmuxUtils.js";

// Managers
import { WebSocketManager } from "./managers/WebSocketManager.js";
import { SessionManager } from "./managers/SessionManager.js";
import { EventProcessor } from "./managers/EventProcessor.js";
import { TilesManager } from "./managers/TilesManager.js";
import { GroupsManager } from "./managers/GroupsManager.js";
import { TokenTracker } from "./managers/TokenTracker.js";
import { PermissionManager } from "./managers/PermissionManager.js";

// Existing managers (untouched)
import { GitStatusManager } from "./GitStatusManager.js";
import { ProjectsManager } from "./ProjectsManager.js";

// Agent adapters
import { AgentRegistry } from "./agents/AgentRegistry.js";
import { ClaudeCodeAdapter } from "./agents/ClaudeCodeAdapter.js";
import { NanoClawAdapter } from "./agents/NanoClawAdapter.js";
import { ZeroClawAdapter } from "./agents/ZeroClawAdapter.js";

// API router
import { routeRequest, type ServerContext } from "./api/router.js";

// Types
import type { ClientMessage } from "../shared/types.js";

// ============================================================================
// Main
// ============================================================================

function main() {
  // ---- Load config ----
  const config = loadConfig();
  setDebug(config.debug);
  initTmuxUtils(config.execOptions);

  log("Starting Vibecraft server...");

  // ---- Create agent registry ----
  const agentRegistry = new AgentRegistry();
  const claudeCodeAdapter = new ClaudeCodeAdapter({ log });
  agentRegistry.register(claudeCodeAdapter);
  agentRegistry.register(new NanoClawAdapter({}, log));
  agentRegistry.register(new ZeroClawAdapter({}, log));

  // ---- Create existing managers ----
  const gitStatusManager = new GitStatusManager();
  const projectsManager = new ProjectsManager();

  // ---- Create new managers ----
  const wsManager = new WebSocketManager();
  const eventProcessor = new EventProcessor(
    config.eventsFile,
    config.maxEvents,
  );
  const tilesManager = new TilesManager(config.tilesFile);
  const groupsManager = new GroupsManager(config.groupsFile);
  const tokenTracker = new TokenTracker(config.tmuxSession);
  const permissionManager = new PermissionManager();
  const sessionManager = new SessionManager({
    sessionsFile: config.sessionsFile,
    execPath: config.execPath,
    workingTimeoutMs: config.workingTimeoutMs,
    gitStatusManager,
    projectsManager,
    agentRegistry,
  });

  // ---- Wire broadcast callbacks ----
  const broadcast = wsManager.broadcast.bind(wsManager);
  sessionManager.setBroadcast(broadcast);
  eventProcessor.setBroadcast(broadcast);
  tilesManager.setBroadcast(broadcast);
  groupsManager.setBroadcast(broadcast);
  tokenTracker.setBroadcast(broadcast);
  permissionManager.setBroadcast(broadcast);

  // ---- Wire cross-manager callbacks ----

  // Groups ↔ Sessions
  groupsManager.setSessionAccessors({
    getSession: (id) => sessionManager.getSession(id),
    hasSession: (id) => sessionManager.hasSession(id),
    broadcastSessions: () => sessionManager.broadcastSessions(),
    saveSessions: () => sessionManager.saveSessions(),
  });
  sessionManager.setGroupRemover((id) =>
    groupsManager.removeSessionFromGroup(id),
  );
  sessionManager.setPermissionCleaner((id) =>
    permissionManager.clearSession(id),
  );

  // Events → Sessions
  eventProcessor.setEventHandler((event) => sessionManager.handleEvent(event));

  // WebSocket → History + Permissions
  wsManager.setHistoryProvider((limit) =>
    eventProcessor.getRecentEvents(limit),
  );
  wsManager.setPermissionResponseHandler((sessionId, response) =>
    permissionManager.sendPermissionResponse(sessionId, response),
  );

  // Token/Permission → Session provider
  tokenTracker.setSessionProvider(() =>
    Array.from(sessionManager.getSessions()),
  );
  permissionManager.setSessionProvider(() =>
    Array.from(sessionManager.getSessions()),
  );

  // Permission → Session status change
  permissionManager.setStatusChangeHandler((sessionId, status, tool) =>
    sessionManager.updateSessionStatus(sessionId, status, tool),
  );

  // ---- Startup cleanup ----
  cleanupOnStartup(config.eventsFile, config.maxEvents, config.execPath);

  // ---- Prune events file ----
  eventProcessor.pruneEventsFile();

  // ---- Load persisted state ----
  eventProcessor.loadFromFile();
  sessionManager.loadSessions();
  tilesManager.load();
  groupsManager.load();

  // ---- Start git status tracking ----
  gitStatusManager.setUpdateHandler(({ sessionId, status }) => {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      debug(
        `Git status updated for ${session.name}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`,
      );
      sessionManager.broadcastSessions();
    }
  });
  gitStatusManager.start();

  // ---- Start file watching ----
  eventProcessor.startWatching();

  // ---- Build server context ----
  const ctx: ServerContext = {
    config,
    sessionManager,
    eventProcessor,
    tilesManager,
    groupsManager,
    tokenTracker,
    permissionManager,
    wsManager,
    projectsManager,
    agentRegistry,
  };

  // ---- Create HTTP server ----
  const httpServer = createServer((req, res) => routeRequest(req, res, ctx));

  // ---- Create WebSocket server ----
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      log(`Rejected WebSocket connection from origin: ${origin}`);
      ws.close(1008, "Origin not allowed");
      return;
    }

    wsManager.addClient(ws);
    log(
      `Client connected (${wsManager.getClientCount()} total)${origin ? ` from ${origin}` : ""}`,
    );

    // Send initial state
    const events = eventProcessor.getEvents();
    const sessions = sessionManager.getSessions();
    const activeClaudeSessionIds = new Set(
      sessions
        .map((s) => s.claudeSessionId)
        .filter((id): id is string => !!id && !id.startsWith("managed:")),
    );
    const filteredHistory = events
      .filter((e) => activeClaudeSessionIds.has(e.sessionId))
      .slice(-50);

    wsManager.sendInitialState(
      ws,
      sessions,
      tilesManager.getAll(),
      groupsManager.getAll(),
      filteredHistory,
      events[events.length - 1]?.sessionId ?? "unknown",
    );

    ws.on("message", (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        wsManager.handleClientMessage(ws, message);
      } catch (e) {
        debug(`Failed to parse client message: ${e}`);
      }
    });

    ws.on("close", () => {
      wsManager.removeClient(ws);
      log(`Client disconnected (${wsManager.getClientCount()} total)`);
    });

    ws.on("error", (error) => {
      debug(`WebSocket error: ${error}`);
      wsManager.removeClient(ws);
    });
  });

  // ---- Start listening ----
  httpServer.listen(config.port, () => {
    log(`Server running on port ${config.port}`);
    log(``);
    log(`Open https://vibecraft.sh to view your workshop`);
    log(``);
    log(`Local API endpoints:`);
    log(`  WebSocket: ws://localhost:${config.port}`);
    log(`  Events: http://localhost:${config.port}/event`);
    log(`  Prompt: http://localhost:${config.port}/prompt`);
    log(`  Health: http://localhost:${config.port}/health`);
    log(`  Stats: http://localhost:${config.port}/stats`);
    log(`  Sessions: http://localhost:${config.port}/sessions`);

    // Start polling
    tokenTracker.start();
    permissionManager.start();

    // Health checks (every 5 seconds)
    setInterval(() => sessionManager.checkSessionHealth(), 5000);

    // Working timeout checks
    setInterval(
      () => sessionManager.checkWorkingTimeout(),
      config.workingCheckIntervalMs,
    );

    // Initial health check + auto-restart
    sessionManager.checkSessionHealth();
    setTimeout(() => {
      sessionManager.autoRestartOfflineSessions();
    }, 2000);
  });
}

// ============================================================================
// Startup Cleanup
// ============================================================================

/**
 * Clean up stale data on server startup:
 * 1. Kill orphaned vibecraft-* tmux sessions
 * 2. Remove stale /tmp/vibecraft-prompt-* temp files
 *
 * Note: events.jsonl pruning is handled by EventProcessor.pruneEventsFile()
 */
function cleanupOnStartup(
  _eventsFile: string,
  _maxEvents: number,
  execPath: string,
): void {
  // Kill orphaned vibecraft-* tmux sessions (skip vibecraft-dev)
  execFile(
    "tmux",
    ["list-sessions", "-F", "#{session_name}"],
    { env: { ...process.env, PATH: execPath } },
    (err, stdout) => {
      if (err || !stdout) return;
      const orphans = stdout
        .trim()
        .split("\n")
        .filter(
          (name) => name.startsWith("vibecraft-") && name !== "vibecraft-dev",
        );
      if (orphans.length === 0) return;
      log(
        `Killing ${orphans.length} orphaned tmux session(s): ${orphans.join(", ")}`,
      );
      for (const name of orphans) {
        execFile("tmux", ["kill-session", "-t", name], () => {});
      }
    },
  );

  // Clean stale /tmp/vibecraft-prompt-* files
  try {
    const tmpFiles = readdirSync("/tmp").filter((f) =>
      f.startsWith("vibecraft-prompt-"),
    );
    for (const f of tmpFiles) {
      try {
        unlinkSync(`/tmp/${f}`);
      } catch {
        // ignore
      }
    }
    if (tmpFiles.length > 0) {
      log(`Cleaned ${tmpFiles.length} stale temp file(s)`);
    }
  } catch {
    // /tmp read failed, ignore
  }
}

main();
