/**
 * BotBridge
 *
 * Platform-agnostic interface for IM integrations (DingTalk, Feishu, Telegram, etc.)
 */

export interface BotMessage {
  bridgeName: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  senderName?: string;
}

export interface TaskCompletionMessage {
  taskGroupId?: string;
  originalMessage?: string;
  sessionName?: string;
  status?: string;
  response?: string;
  originalPrompt?: string;
  duration?: number;
  results?: Array<{
    sessionName: string;
    response: string;
  }>;
  durationMs?: number;
}

export interface BotBridge {
  name: string;
  onMessage(handler: (msg: BotMessage) => Promise<void>): void;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendTaskCompletion(chatId: string, msg: TaskCompletionMessage): Promise<void>;
  sendText?(text: string): Promise<void>;
  sendStatusUpdate?(
    sessionName: string,
    status: string,
    prompt: string,
  ): Promise<void>;
}
