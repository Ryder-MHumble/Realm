/**
 * API Router
 *
 * Defines the ServerContext type and dispatches HTTP requests to handlers.
 * Handles CORS and delegates to individual route handlers.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ServerConfig } from "../config.js";
import type { SessionManager } from "../managers/SessionManager.js";
import type { EventProcessor } from "../managers/EventProcessor.js";
import type { TilesManager } from "../managers/TilesManager.js";
import type { GroupsManager } from "../managers/GroupsManager.js";
import type { TokenTracker } from "../managers/TokenTracker.js";
import type { PermissionManager } from "../managers/PermissionManager.js";
import type { WebSocketManager } from "../managers/WebSocketManager.js";
import type { ProjectsManager } from "../ProjectsManager.js";
import type { AgentRegistry } from "../agents/AgentRegistry.js";
import type { SettingsManager } from "../managers/SettingsManager.js";
import type { NotificationManager } from "../bot/NotificationManager.js";
import type { AutoCompactManager } from "../managers/AutoCompactManager.js";
import type { AutoContinueManager } from "../managers/AutoContinueManager.js";
import { isOriginAllowed } from "../config.js";

import { handleEventRoutes } from "./eventsHandler.js";
import { handleSessionRoutes } from "./sessionsHandler.js";
import { handleGroupRoutes } from "./groupsHandler.js";
import { handleTileRoutes } from "./tilesHandler.js";
import { handleProjectRoutes } from "./projectsHandler.js";
import { handlePromptRoutes } from "./promptHandler.js";
import { handleAgentRoutes } from "./agentsHandler.js";
import { handleUploadRoutes } from "./uploadHandler.js";
import { handleSettingsRoutes } from "./settingsHandler.js";
import { serveStaticFile } from "./staticHandler.js";

/** All dependencies available to route handlers */
export interface ServerContext {
  config: ServerConfig;
  sessionManager: SessionManager;
  eventProcessor: EventProcessor;
  tilesManager: TilesManager;
  groupsManager: GroupsManager;
  tokenTracker: TokenTracker;
  permissionManager: PermissionManager;
  wsManager: WebSocketManager;
  projectsManager: ProjectsManager;
  agentRegistry: AgentRegistry;
  settingsManager: SettingsManager;
  notificationManager: NotificationManager | null;
  autoCompactManager: AutoCompactManager | null;
  autoContinueManager: AutoContinueManager | null;
}

/** Main HTTP request handler */
export function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): void {
  const origin = req.headers.origin;

  // CORS headers
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    if (!origin || !isOriginAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // Try each handler in order
  if (handleEventRoutes(req, res, ctx)) return;
  if (handlePromptRoutes(req, res, ctx)) return;
  if (handleSessionRoutes(req, res, ctx)) return;
  if (handleAgentRoutes(req, res, ctx)) return;
  if (handleProjectRoutes(req, res, ctx)) return;
  if (handleGroupRoutes(req, res, ctx)) return;
  if (handleTileRoutes(req, res, ctx)) return;
  if (handleSettingsRoutes(req, res, ctx)) return;
  if (handleUploadRoutes(req, res, ctx)) return;

  // Fallback: static file serving
  serveStaticFile(req, res);
}
