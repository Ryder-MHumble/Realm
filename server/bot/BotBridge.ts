/**
 * BotBridge — Platform-agnostic interface for IM integration.
 *
 * Adapters implement this to connect Vibecraft to messaging platforms
 * (Feishu, DingTalk, WeChat Work, Slack, etc.)
 */

// ============================================================================
// Types
// ============================================================================

/** Inbound message from an IM platform */
export interface BotMessage {
  /** Raw text content (bot @mention already stripped by adapter) */
  text: string;
  /** Sender display name */
  senderName: string;
  /** Sender platform-specific ID */
  senderId: string;
  /** Chat/group ID where the message was sent */
  chatId: string;
  /** Platform-specific message ID */
  messageId: string;
}

/** Outbound task completion report */
export interface TaskCompletionMessage {
  /** Session name (e.g., "Frontend") */
  sessionName: string;
  /** Completion status */
  status: "completed" | "error";
  /** Claude's response text (from StopEvent.response) */
  response?: string;
  /** Original prompt that was dispatched */
  originalPrompt?: string;
  /** Duration of work in ms */
  duration?: number;
}

// ============================================================================
// Interface
// ============================================================================

export interface BotBridge {
  /** Platform name (e.g., "feishu", "dingtalk") */
  readonly platform: string;

  /** Initialize the bot connection */
  start(): Promise<void>;

  /** Shut down the bot connection */
  stop(): Promise<void>;

  /** Send a task completion report to the IM group */
  sendTaskCompletion(msg: TaskCompletionMessage): Promise<void>;

  /** Send a status update (e.g., "Frontend is now working...") */
  sendStatusUpdate(
    sessionName: string,
    status: string,
    detail?: string,
  ): Promise<void>;

  /** Send a plain text message to the IM group */
  sendText(text: string): Promise<void>;

  /** Register a callback for incoming messages from the IM group */
  onMessage(handler: (msg: BotMessage) => void): void;
}
