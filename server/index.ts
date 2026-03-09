/**
 * Realm WebSocket Server — Orchestrator
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
import { SettingsManager } from "./managers/SettingsManager.js";
import { AutoCompactManager } from "./managers/AutoCompactManager.js";
import { AutoContinueManager } from "./managers/AutoContinueManager.js";

// Existing managers (untouched)
import { GitStatusManager } from "./GitStatusManager.js";
import { ProjectsManager } from "./ProjectsManager.js";

// Agent adapters
import { AgentRegistry } from "./agents/AgentRegistry.js";
import { ClaudeCodeAdapter } from "./agents/ClaudeCodeAdapter.js";
import { NanoClawAdapter } from "./agents/NanoClawAdapter.js";
import { ZeroClawAdapter } from "./agents/ZeroClawAdapter.js";
import { OpenClawAdapter } from "./agents/OpenClawAdapter.js";

// API router
import { routeRequest, type ServerContext } from "./api/router.js";

// Bot
import { TaskOrchestrator } from "./bot/TaskOrchestrator.js";

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

  log("Starting Realm server...");

  // ---- Create agent registry ----
  const agentRegistry = new AgentRegistry();
  const claudeCodeAdapter = new ClaudeCodeAdapter({ log });
  agentRegistry.register(claudeCodeAdapter);

  const nanoAdapter = new NanoClawAdapter(log);
  const zeroAdapter = new ZeroClawAdapter(log);
  const openAdapter = new OpenClawAdapter(log);
  agentRegistry.register(nanoAdapter);
  agentRegistry.register(zeroAdapter);
  agentRegistry.register(openAdapter);

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

  // ---- Create settings manager ----
  const settingsManager = new SettingsManager(config.settingsFile);

  // Inject settings provider into non-Claude adapters for LLM config resolution
  const settingsProvider = {
    getLLMProvider: (name: string) => settingsManager.getLLMProvider(name),
  };
  nanoAdapter.setSettingsProvider(settingsProvider);
  zeroAdapter.setSettingsProvider(settingsProvider);
  openAdapter.setSettingsProvider(settingsProvider);

  // ---- Create automation managers ----
  const autoCompactManager = new AutoCompactManager(
    settingsManager.getAutoCompact() || undefined,
  );
  const autoContinueManager = new AutoContinueManager(
    settingsManager.getAutoContinue() || undefined,
  );

  // ---- Create task orchestrator (IM → sessions dispatcher) ----
  const taskOrchestrator = new TaskOrchestrator({
    getSettings: () => settingsManager.getSettings(),
    getSessions: () => sessionManager.getSessions(),
    getProjects: () => projectsManager.getProjects(),
    createSession: (options) => sessionManager.createSession(options),
    sendPrompt: (id, prompt) => sessionManager.sendPromptToSession(id, prompt),
    getBridge: (name) => undefined,
  });

  // ---- Wire broadcast callbacks ----
  const broadcast = wsManager.broadcast.bind(wsManager);
  sessionManager.setBroadcast(broadcast);
  eventProcessor.setBroadcast(broadcast);
  tilesManager.setBroadcast(broadcast);
  groupsManager.setBroadcast(broadcast);
  tokenTracker.setBroadcast(broadcast);
  permissionManager.setBroadcast(broadcast);
  settingsManager.setBroadcast(broadcast);

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

  // Events → Sessions + Notifications + Auto-Continue + Orchestrator
  eventProcessor.setEventHandler((event) => {
    sessionManager.handleEvent(event);
    autoContinueManager.handleEvent(event);

    if (event.type === "stop") {
      // Resolve managed session from Claude Code session ID or direct managed ID
      const session =
        sessionManager.findManagedSession(event.sessionId) ??
        sessionManager.getSession(event.sessionId);

      if (session) {
        const stopEvent = event as import("../shared/types.js").StopEvent;

        // Orchestrated task completion (only fires when session was dispatched by orchestrator)
        taskOrchestrator.handleSessionStop(
          session.id,
          stopEvent.response ?? "",
        );
      }
    }
  });

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

  // Token → Auto-Compact
  tokenTracker.setTokenUpdateHandler((tmuxSession, tokens) => {
    autoCompactManager.onTokenUpdate(tmuxSession, tokens);
  });
  autoCompactManager.setSessionProvider(() =>
    Array.from(sessionManager.getSessions()),
  );
  autoCompactManager.setSendPrompt((id, prompt) =>
    sessionManager.sendPromptToSession(id, prompt),
  );
  autoCompactManager.setBroadcast(broadcast);

  // Auto-Continue wiring
  autoContinueManager.setSendPrompt((claudeSessionId, prompt) => {
    const managed = sessionManager.findManagedSession(claudeSessionId);
    if (!managed) return Promise.resolve({ ok: false });
    return sessionManager.sendPromptToSession(managed.id, prompt);
  });
  autoContinueManager.setBroadcast(broadcast);
  autoContinueManager.setSessionStatusProvider((claudeSessionId) => {
    const managed = sessionManager.findManagedSession(claudeSessionId);
    return managed?.status;
  });

  // Sync automation configs when settings change
  settingsManager.onChange(() => {
    const ac = settingsManager.getAutoCompact();
    if (ac) autoCompactManager.updateConfig(ac);
    const acn = settingsManager.getAutoContinue();
    if (acn) autoContinueManager.updateConfig(acn);
  });

  // ---- Startup cleanup ----
  cleanupOnStartup(config.eventsFile, config.maxEvents, config.execPath);

  // ---- Prune events file ----
  eventProcessor.pruneEventsFile();

  // ---- Load persisted state ----
  eventProcessor.loadFromFile();
  sessionManager.loadSessions();
  tilesManager.load();
  groupsManager.load();
  settingsManager.load();

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
    settingsManager,
    autoCompactManager,
    autoContinueManager,
    taskOrchestrator,
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
    log(`Open https://realm.sh to view your workshop`);
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
 * 1. Kill orphaned realm-* tmux sessions
 * 2. Remove stale /tmp/realm-prompt-* temp files
 *
 * Note: events.jsonl pruning is handled by EventProcessor.pruneEventsFile()
 */
function cleanupOnStartup(
  _eventsFile: string,
  _maxEvents: number,
  execPath: string,
): void {
  // Kill orphaned realm-* tmux sessions (skip realm-dev)
  execFile(
    "tmux",
    ["list-sessions", "-F", "#{session_name}"],
    { env: { ...process.env, PATH: execPath } },
    (err, stdout) => {
      if (err || !stdout) return;
      const orphans = stdout
        .trim()
        .split("\n")
        .filter((name) => name.startsWith("realm-") && name !== "realm-dev");
      if (orphans.length === 0) return;
      log(
        `Killing ${orphans.length} orphaned tmux session(s): ${orphans.join(", ")}`,
      );
      for (const name of orphans) {
        execFile("tmux", ["kill-session", "-t", name], () => {});
      }
    },
  );

  // Clean stale /tmp/realm-prompt-* files
  try {
    const tmpFiles = readdirSync("/tmp").filter((f) =>
      f.startsWith("realm-prompt-"),
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
