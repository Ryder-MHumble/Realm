/**
 * Event Processor
 *
 * Handles event storage, deduplication, duration calculation,
 * file watching, and event broadcasting.
 */

import { watch } from "chokidar";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import type {
  ClaudeEvent,
  PreToolUseEvent,
  PostToolUseEvent,
  ServerMessage,
} from "../../shared/types.js";
import { log, debug } from "../logger.js";

export class EventProcessor {
  private events: ClaudeEvent[] = [];
  private seenEventIds = new Set<string>();
  private pendingToolUses = new Map<string, PreToolUseEvent>();
  private lastFileSize = 0;
  private maxEvents: number;
  private eventsFile: string;

  private broadcastFn: ((msg: ServerMessage) => void) | null = null;
  private eventHandler: ((event: ClaudeEvent) => void) | null = null;

  constructor(eventsFile: string, maxEvents: number) {
    this.eventsFile = eventsFile;
    this.maxEvents = maxEvents;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  /** Set handler for processed events (used by SessionManager to update status) */
  setEventHandler(handler: (event: ClaudeEvent) => void): void {
    this.eventHandler = handler;
  }

  /** Get all events */
  getEvents(): ClaudeEvent[] {
    return this.events;
  }

  /** Get the last N events */
  getRecentEvents(limit: number): ClaudeEvent[] {
    return this.events.slice(-limit);
  }

  /** Load existing events from the JSONL file */
  loadFromFile(): void {
    if (!existsSync(this.eventsFile)) {
      debug(`Events file not found: ${this.eventsFile}`);
      return;
    }

    const content = readFileSync(this.eventsFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as ClaudeEvent;
        this.processEvent(event);
        this.events.push(event);
      } catch {
        debug(`Failed to parse event line: ${line}`);
      }
    }

    this.lastFileSize = content.length;
    log(`Loaded ${this.events.length} events from file`);
  }

  /** Start watching the events file for changes */
  startWatching(): void {
    const dir = dirname(this.eventsFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.eventsFile)) {
      appendFileSync(this.eventsFile, "");
    }

    const watcher = watch(this.eventsFile, {
      persistent: true,
      usePolling: true,
      interval: 100,
    });

    watcher.on("change", () => {
      try {
        const content = readFileSync(this.eventsFile, "utf-8");

        if (content.length > this.lastFileSize) {
          const newContent = content.slice(this.lastFileSize);
          const newLines = newContent.trim().split("\n").filter(Boolean);

          for (const line of newLines) {
            try {
              const event = JSON.parse(line) as ClaudeEvent;
              this.addEvent(event);
              debug(`New event from file: ${event.type}`);
            } catch {
              debug(`Failed to parse new event: ${line}`);
            }
          }

          this.lastFileSize = content.length;
        }
      } catch (e) {
        debug(`Error reading events file: ${e}`);
      }
    });

    log(`Watching events file: ${this.eventsFile}`);
  }

  /** Add an event (from HTTP POST or file watcher) */
  addEvent(event: ClaudeEvent): void {
    // Skip duplicates
    if (this.seenEventIds.has(event.id)) {
      debug(`Skipping duplicate event: ${event.id}`);
      return;
    }
    this.seenEventIds.add(event.id);

    // Trim old IDs to prevent memory leak
    if (this.seenEventIds.size > this.maxEvents * 2) {
      const idsToKeep = [...this.seenEventIds].slice(-this.maxEvents);
      this.seenEventIds.clear();
      idsToKeep.forEach((id) => this.seenEventIds.add(id));
    }

    const processed = this.processEvent(event);
    this.events.push(processed);

    // Trim old events
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    // Notify SessionManager to update session status
    this.eventHandler?.(processed);

    // Broadcast to all clients
    this.broadcastFn?.({ type: "event", payload: processed });
  }

  /** Truncate events file on startup */
  pruneEventsFile(): void {
    if (!existsSync(this.eventsFile)) return;

    try {
      const content = readFileSync(this.eventsFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length > this.maxEvents) {
        const kept = lines.slice(-this.maxEvents);
        writeFileSync(this.eventsFile, kept.join("\n") + "\n");
        log(`Pruned events.jsonl: ${lines.length} → ${kept.length} lines`);
      } else {
        log(`events.jsonl OK (${lines.length} lines)`);
      }
    } catch (e) {
      log(`Failed to prune events.jsonl: ${e}`);
    }
  }

  /** Process an event (calculate tool duration) */
  private processEvent(event: ClaudeEvent): ClaudeEvent {
    if (event.type === "pre_tool_use") {
      const preEvent = event as PreToolUseEvent;
      this.pendingToolUses.set(preEvent.toolUseId, preEvent);
      debug(`Tracking tool use: ${preEvent.tool} (${preEvent.toolUseId})`);
    }

    if (event.type === "post_tool_use") {
      const postEvent = event as PostToolUseEvent;
      const preEvent = this.pendingToolUses.get(postEvent.toolUseId);
      if (preEvent) {
        postEvent.duration = postEvent.timestamp - preEvent.timestamp;
        this.pendingToolUses.delete(postEvent.toolUseId);
        debug(`Tool ${postEvent.tool} took ${postEvent.duration}ms`);
      }
    }

    return event;
  }
}
