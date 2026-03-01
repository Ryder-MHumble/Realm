/**
 * EventBus - Decoupled event handling for Realm
 *
 * Allows modules to subscribe to events they care about without
 * coupling everything in one giant switch statement.
 *
 * Usage:
 * ```typescript
 * // Subscribe to events
 * eventBus.on('pre_tool_use', (event, context) => {
 *   soundManager.playTool(event.tool)
 * })
 *
 * // Emit events (from handleEvent)
 * eventBus.emit('pre_tool_use', event, context)
 * ```
 */

import type {
  ClaudeEvent,
  PreToolUseEvent,
  PostToolUseEvent,
  StopEvent,
  UserPromptSubmitEvent,
} from '../../shared/types'
import type { WorkshopScene } from '../scene/WorkshopScene'
import type { FeedManager } from '../ui/FeedManager'
import type { TimelineManager } from '../ui/TimelineManager'

// ============================================================================
// Types
// ============================================================================

/** Context passed to all event handlers */
export interface EventContext {
  /** The workshop scene */
  scene: WorkshopScene | null
  /** Feed manager */
  feedManager: FeedManager | null
  /** Timeline manager */
  timelineManager: TimelineManager | null
  /** Session state for the event's session */
  session: SessionContext | null
  /** Sound enabled flag */
  soundEnabled: boolean
}

/**
 * Per-session context
 * Uses loose typing to avoid import cycles and complex type matching.
 * Handlers should cast to specific types if needed.
 */
export interface SessionContext {
  /** Session ID */
  id: string
  /** Session color */
  color: number
  /** Claude character instance */
  claude: any
  /** Subagent manager */
  subagents: any
  /** Zone data */
  zone: any
  /** Stats */
  stats: {
    toolsUsed: number
    filesTouched: Set<string>
    activeSubagents: number
  }
}

/** Event type to event data mapping */
export interface EventTypeMap {
  'pre_tool_use': PreToolUseEvent
  'post_tool_use': PostToolUseEvent
  'stop': StopEvent
  'user_prompt_submit': UserPromptSubmitEvent
  'session_start': ClaudeEvent
  'notification': ClaudeEvent
}

export type EventType = keyof EventTypeMap

/** Handler function signature */
export type EventHandler<T extends EventType> = (
  event: EventTypeMap[T],
  context: EventContext
) => void

// ============================================================================
// EventBus Class
// ============================================================================

export class EventBus {
  private handlers: Map<EventType, Set<EventHandler<any>>> = new Map()

  /**
   * Subscribe to an event type
   */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.handlers.get(type)?.delete(handler)
    }
  }

  /**
   * Emit an event to all subscribers
   */
  emit<T extends EventType>(type: T, event: EventTypeMap[T], context: EventContext): void {
    const handlers = this.handlers.get(type)
    if (!handlers) return

    for (const handler of handlers) {
      try {
        handler(event, context)
      } catch (error) {
        console.error(`[EventBus] Error in handler for ${type}:`, error)
      }
    }
  }

  /**
   * Remove all handlers for an event type
   */
  off(type: EventType): void {
    this.handlers.delete(type)
  }

  /**
   * Remove all handlers
   */
  clear(): void {
    this.handlers.clear()
  }

  /**
   * Get handler count for debugging
   */
  getHandlerCount(type?: EventType): number {
    if (type) {
      return this.handlers.get(type)?.size ?? 0
    }
    let total = 0
    for (const handlers of this.handlers.values()) {
      total += handlers.size
    }
    return total
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const eventBus = new EventBus()
