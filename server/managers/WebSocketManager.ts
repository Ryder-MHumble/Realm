/**
 * WebSocket Manager
 *
 * Manages connected WebSocket clients, handles broadcasting,
 * and routes incoming client messages.
 */

import { WebSocket } from "ws";
import type {
  ServerMessage,
  ClientMessage,
  ClaudeEvent,
  ManagedSession,
  TextTile,
  ZoneGroup,
} from "../../shared/types.js";
import { debug } from "../logger.js";

export class WebSocketManager {
  private clients = new Set<WebSocket>();

  /** Callback for handling permission responses from clients */
  private permissionResponseHandler:
    | ((sessionId: string, response: string) => void)
    | null = null;

  /** Callback for getting event history */
  private historyProvider: ((limit: number) => ClaudeEvent[]) | null = null;

  setPermissionResponseHandler(
    handler: (sessionId: string, response: string) => void,
  ): void {
    this.permissionResponseHandler = handler;
  }

  setHistoryProvider(provider: (limit: number) => ClaudeEvent[]): void {
    this.historyProvider = provider;
  }

  /** Add a new client */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  /** Remove a client */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /** Get connected client count */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Broadcast a message to all connected clients */
  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** Send a message to a specific client */
  send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Handle incoming client message */
  handleClientMessage(ws: WebSocket, message: ClientMessage): void {
    switch (message.type) {
      case "subscribe":
        debug("Client subscribed");
        break;

      case "get_history": {
        const limit = message.payload?.limit ?? 100;
        const history = this.historyProvider
          ? this.historyProvider(limit)
          : [];
        const response: ServerMessage = { type: "history", payload: history };
        ws.send(JSON.stringify(response));
        debug(`Sent ${history.length} historical events`);
        break;
      }

      case "ping":
        break;

      case "permission_response": {
        const { sessionId, response } = message.payload;
        if (this.permissionResponseHandler) {
          this.permissionResponseHandler(sessionId, response);
        }
        break;
      }

      default:
        debug(`Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Send initial state to a newly connected client.
   * Order matters: sessions before history so client can link events to sessions.
   */
  sendInitialState(
    ws: WebSocket,
    sessions: ManagedSession[],
    tiles: TextTile[],
    groups: ZoneGroup[],
    filteredHistory: ClaudeEvent[],
    lastSessionId: string,
  ): void {
    this.send(ws, {
      type: "connected",
      payload: { sessionId: lastSessionId },
    });

    this.send(ws, { type: "sessions", payload: sessions });
    this.send(ws, { type: "text_tiles", payload: tiles });
    this.send(ws, { type: "zone_groups", payload: groups });
    this.send(ws, { type: "history", payload: filteredHistory });
  }
}
