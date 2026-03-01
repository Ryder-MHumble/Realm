/**
 * Realm Event Types
 *
 * These types define the contract between:
 * - Hook scripts (produce events)
 * - WebSocket server (relay events)
 * - Three.js client (consume events)
 */

// ============================================================================
// Core Event Types
// ============================================================================

export type HookEventType =
  | "pre_tool_use"
  | "post_tool_use"
  | "stop"
  | "subagent_stop"
  | "session_start"
  | "session_end"
  | "user_prompt_submit"
  | "notification"
  | "pre_compact";

export type ToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Grep"
  | "Glob"
  | "WebFetch"
  | "WebSearch"
  | "Task"
  | "TodoWrite"
  | "AskUserQuestion"
  | "NotebookEdit"
  | string; // MCP tools and future tools

// ============================================================================
// Base Event
// ============================================================================

export interface BaseEvent {
  /** Unique event ID */
  id: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Event type */
  type: HookEventType;
  /** Claude Code session ID */
  sessionId: string;
  /** Current working directory */
  cwd: string;
}

// ============================================================================
// Tool Events
// ============================================================================

export interface PreToolUseEvent extends BaseEvent {
  type: "pre_tool_use";
  tool: ToolName;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  /** Assistant text that came before this tool call */
  assistantText?: string;
}

export interface PostToolUseEvent extends BaseEvent {
  type: "post_tool_use";
  tool: ToolName;
  toolInput: Record<string, unknown>;
  toolResponse: Record<string, unknown>;
  toolUseId: string;
  success: boolean;
  /** Duration in milliseconds (calculated from matching pre_tool_use) */
  duration?: number;
}

// ============================================================================
// Lifecycle Events
// ============================================================================

export interface StopEvent extends BaseEvent {
  type: "stop";
  stopHookActive: boolean;
  /** Claude's text response (extracted from transcript) */
  response?: string;
}

export interface SubagentStopEvent extends BaseEvent {
  type: "subagent_stop";
  stopHookActive: boolean;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  source: "startup" | "resume" | "clear" | "compact";
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  reason: "clear" | "logout" | "prompt_input_exit" | "other";
}

// ============================================================================
// User Interaction Events
// ============================================================================

export interface UserPromptSubmitEvent extends BaseEvent {
  type: "user_prompt_submit";
  prompt: string;
}

export interface NotificationEvent extends BaseEvent {
  type: "notification";
  message: string;
  notificationType:
    | "permission_prompt"
    | "idle_prompt"
    | "auth_success"
    | "elicitation_dialog"
    | string;
}

// ============================================================================
// Other Events
// ============================================================================

export interface PreCompactEvent extends BaseEvent {
  type: "pre_compact";
  trigger: "manual" | "auto";
  customInstructions?: string;
}

// ============================================================================
// Union Type
// ============================================================================

export type ClaudeEvent =
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent
  | SubagentStopEvent
  | SessionStartEvent
  | SessionEndEvent
  | UserPromptSubmitEvent
  | NotificationEvent
  | PreCompactEvent;

// ============================================================================
// WebSocket Messages
// ============================================================================

/** Permission option (number + label) */
export interface PermissionOption {
  number: string; // "1", "2", "3"
  label: string; // "Yes", "Yes, and always allow...", "No"
}

/** Server -> Client messages */
export type ServerMessage =
  | { type: "event"; payload: ClaudeEvent }
  | { type: "history"; payload: ClaudeEvent[] }
  | { type: "connected"; payload: { sessionId: string } }
  | { type: "error"; payload: { message: string } }
  | {
      type: "tokens";
      payload: { session: string; current: number; cumulative: number };
    }
  | { type: "sessions"; payload: ManagedSession[] }
  | { type: "session_update"; payload: ManagedSession }
  | {
      type: "permission_prompt";
      payload: {
        sessionId: string;
        tool: string;
        context: string;
        options: PermissionOption[];
      };
    }
  | { type: "permission_resolved"; payload: { sessionId: string } }
  | { type: "text_tiles"; payload: TextTile[] }
  | { type: "zone_groups"; payload: ZoneGroup[] }
  | { type: "settings_update"; payload: AgentProviderSettingsRedacted };

/** Client -> Server messages */
export type ClientMessage =
  | { type: "subscribe"; payload?: { sessionId?: string } }
  | { type: "get_history"; payload?: { limit?: number } }
  | { type: "ping" }
  | {
      type: "permission_response";
      payload: { sessionId: string; response: string };
    };

// ============================================================================
// Agent Types (Multi-Claw Framework Support)
// ============================================================================

/** Supported agent framework types */
export type AgentType = "claude_code" | "nanoclaw" | "zeroclaw" | "openclaw";

/** Visual configuration for each agent type */
export interface AgentTypeConfig {
  name: string;
  label: string;
  color: number;
  accentColor: number;
  statusColor: number;
  icon: string;
  description: string;
}

/** Pre-defined agent type configurations */
export const AGENT_TYPES: Record<AgentType, AgentTypeConfig> = {
  claude_code: {
    name: "Claude Code",
    label: "Claude Code",
    color: 0x1e3a5f,
    accentColor: 0x60a5fa,
    statusColor: 0x3b82f6,
    icon: "\u{1F916}",
    description: "Anthropic Claude Code CLI agent",
  },
  nanoclaw: {
    name: "NanoClaw",
    label: "NanoClaw",
    color: 0x2d1b4e,
    accentColor: 0xa78bfa,
    statusColor: 0x7c3aed,
    icon: "\u{1F980}",
    description: "Lightweight container-isolated AI agent",
  },
  zeroclaw: {
    name: "ZeroClaw",
    label: "ZeroClaw",
    color: 0x1a3c2a,
    accentColor: 0x4ade80,
    statusColor: 0x22c55e,
    icon: "\u26A1",
    description: "Ultra-lightweight Rust AI agent runtime",
  },
  openclaw: {
    name: "OpenClaw",
    label: "OpenClaw",
    color: 0x4a2c1a,
    accentColor: 0xfb923c,
    statusColor: 0xea580c,
    icon: "\u{1F419}",
    description: "Open-source autonomous AI agent",
  },
};

// ============================================================================
// Realm: AI Role Types
// ============================================================================

/** AI workforce role types */
export type RealmRole = "engineer" | "marketer" | "designer" | "analyst";

/** Visual configuration for each role */
export interface RoleConfig {
  name: string;
  label: string;
  color: number; // Primary body color
  accentColor: number; // Glow/accent color (eyes, antenna, accents)
  statusColor: number; // Status ring default color
  emoji: string; // For UI display
  description: string;
}

/** Pre-defined role configurations */
export const REALM_ROLES: Record<RealmRole, RoleConfig> = {
  engineer: {
    name: "Engineer",
    label: "AI Engineer",
    color: 0x1e3a5f,
    accentColor: 0x60a5fa,
    statusColor: 0x3b82f6,
    emoji: "⚙️",
    description: "Writes code, debugs, deploys",
  },
  marketer: {
    name: "Marketer",
    label: "AI Marketer",
    color: 0x5c3d1e,
    accentColor: 0xfbbf24,
    statusColor: 0xd97706,
    emoji: "📢",
    description: "Research, copywriting, SEO",
  },
  designer: {
    name: "Designer",
    label: "AI Designer",
    color: 0x3b1e5c,
    accentColor: 0xc084fc,
    statusColor: 0x7c3aed,
    emoji: "🎨",
    description: "UI design, asset creation",
  },
  analyst: {
    name: "Analyst",
    label: "AI Analyst",
    color: 0x1e4d3a,
    accentColor: 0x34d399,
    statusColor: 0x059669,
    emoji: "📊",
    description: "Data processing, reports",
  },
};

// ============================================================================
// Visualization State
// ============================================================================

/** Represents Claude's current activity state */
export type ClaudeState =
  | "idle" // Waiting for user input
  | "thinking" // Processing (between tools)
  | "working" // Using a tool
  | "finished"; // Completed response

/** Station/location in the 3D workshop */
export type StationType =
  | "center" // Default idle position
  | "bookshelf" // Read
  | "desk" // Write
  | "workbench" // Edit
  | "terminal" // Bash
  | "scanner" // Grep/Glob
  | "antenna" // WebFetch/WebSearch
  | "portal" // Task (spawning subagents)
  | "taskboard"; // TodoWrite

/** Map tools to stations */
export const TOOL_STATION_MAP: Record<ToolName, StationType> = {
  Read: "bookshelf",
  Write: "desk",
  Edit: "workbench",
  Bash: "terminal",
  Grep: "scanner",
  Glob: "scanner",
  WebFetch: "antenna",
  WebSearch: "antenna",
  Task: "portal",
  TodoWrite: "taskboard",
  AskUserQuestion: "center",
  NotebookEdit: "desk",
};

/** Get station for a tool (handles unknown/MCP tools) */
export function getStationForTool(tool: string): StationType {
  return TOOL_STATION_MAP[tool as ToolName] ?? "center";
}

// ============================================================================
// Utility Types
// ============================================================================

/** Extract specific tool input types */
export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface TaskToolInput {
  description: string;
  prompt: string;
  subagent_type: string;
}

// ============================================================================
// Session Management (Orchestration)
// ============================================================================

/** Status of a managed Claude session */
export type SessionStatus = "idle" | "working" | "waiting" | "offline";

/** Claude Code operating mode */
export type ClaudeMode = "auto-edit" | "plan" | "ask-before-edit";

/** A managed agent session */
export interface ManagedSession {
  /** Our internal ID (UUID) */
  id: string;
  /** User-friendly name ("Frontend", "Tests") */
  name: string;
  /** Agent framework type (defaults to 'claude_code' for backward compat) */
  agentType: AgentType;
  /** Process identifier (tmux session name for claude_code, container ID for nanoclaw, etc.) */
  tmuxSession: string;
  /** Current status */
  status: SessionStatus;
  /** Claude Code session ID (from events, may differ from our ID) */
  claudeSessionId?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Working directory */
  cwd?: string;
  /** Current tool being used (if working) */
  currentTool?: string;
  /** Token count for this session */
  tokens?: {
    current: number;
    cumulative: number;
  };
  /** Git status for this session's working directory */
  gitStatus?: GitStatus;
  /** Zone position in hex grid (for layout persistence) */
  zonePosition?: {
    q: number;
    r: number;
  };
  /** Claude Code operating mode */
  mode?: ClaudeMode;
  /** Zone group ID (if this session belongs to a group) */
  groupId?: string;
  /** User-provided description for routing prompts */
  description?: string;
  /** Agent-specific config (container ID, binary path, etc.) */
  agentConfig?: Record<string, unknown>;
  /** Capabilities reported by the agent */
  capabilities?: string[];
  /** Launch mode used to create this session */
  launchMode?: LaunchModeConfig;
  /** LLM provider key used by this session */
  llmProvider?: string;
}

/** Git repository status */
export interface GitStatus {
  /** Current branch name */
  branch: string;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Staged file counts */
  staged: {
    added: number;
    modified: number;
    deleted: number;
  };
  /** Unstaged file counts */
  unstaged: {
    added: number;
    modified: number;
    deleted: number;
  };
  /** Untracked file count */
  untracked: number;
  /** Total changed files (staged + unstaged + untracked) */
  totalFiles: number;
  /** Lines added (staged + unstaged) */
  linesAdded: number;
  /** Lines removed (staged + unstaged) */
  linesRemoved: number;
  /** Last commit timestamp (unix seconds) */
  lastCommitTime: number | null;
  /** Last commit message (first line) */
  lastCommitMessage: string | null;
  /** Whether directory is a git repo */
  isRepo: boolean;
  /** Last time we checked (unix ms) */
  lastChecked: number;
}

/** Known project directory for autocomplete */
export interface KnownProject {
  /** Absolute path to the directory */
  path: string;
  /** Display name (defaults to directory basename) */
  name: string;
  /** Last time this project was used (unix ms) */
  lastUsed: number;
  /** Number of times this project has been opened */
  useCount: number;
}

/** Request to create a new session */
export interface CreateSessionRequest {
  name?: string;
  cwd?: string;
  /** Agent framework type (default: 'claude_code') */
  agentType?: AgentType;
  /** Claude command flags (claude_code only) */
  flags?: {
    continue?: boolean; // -c (continue last conversation)
    skipPermissions?: boolean; // --dangerously-skip-permissions
    chrome?: boolean; // --chrome
  };
  /** Claude Code operating mode (claude_code only) */
  mode?: ClaudeMode;
  /** User-provided description for routing prompts */
  description?: string;
  /** Agent-specific config (container settings, binary path, etc.) */
  agentConfig?: Record<string, unknown>;
  /** Launch mode configuration (non-claude_code agents) */
  launchMode?: LaunchModeConfig;
  /** LLM provider key (references AgentProviderSettings.llmProviders) */
  llmProvider?: string;
}

/** Request to update a session */
export interface UpdateSessionRequest {
  name?: string;
  zonePosition?: {
    q: number;
    r: number;
  };
}

/** Request to send a prompt to a session */
export interface SessionPromptRequest {
  prompt: string;
  send?: boolean;
}

/** Response for session operations */
export interface SessionResponse {
  ok: boolean;
  session?: ManagedSession;
  error?: string;
}

/** Response for listing sessions */
export interface SessionListResponse {
  ok: boolean;
  sessions: ManagedSession[];
}

// ============================================================================
// File Upload
// ============================================================================

/** Response from file upload endpoint */
export interface FileUploadResponse {
  ok: boolean;
  files?: UploadedFileInfo[];
  error?: string;
}

/** Metadata for an uploaded file */
export interface UploadedFileInfo {
  /** Original filename */
  originalName: string;
  /** Absolute path on disk where file was saved */
  savedPath: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
}

// ============================================================================
// Text Tiles (Grid Labels)
// ============================================================================

/** A text label tile on the hex grid */
export interface TextTile {
  /** Unique ID (UUID) */
  id: string;
  /** The label text */
  text: string;
  /** Hex grid position */
  position: {
    q: number;
    r: number;
  };
  /** Optional color (hex string, default white) */
  color?: string;
  /** Creation timestamp */
  createdAt: number;
}

/** Request to create a text tile */
export interface CreateTextTileRequest {
  text: string;
  position: {
    q: number;
    r: number;
  };
  color?: string;
}

/** Request to update a text tile */
export interface UpdateTextTileRequest {
  text?: string;
  position?: {
    q: number;
    r: number;
  };
  color?: string;
}

// ============================================================================
// Zone Groups (Civ6-style adjacent hex grouping)
// ============================================================================

/** A group of zones linked together as a "department" */
export interface ZoneGroup {
  /** Unique group ID (UUID) */
  id: string;
  /** Optional group/department label */
  name?: string;
  /** CSS hex color for department visual identity (e.g., "#60a5fa") */
  color?: string;
  /** Session IDs (managed session IDs) of grouped zones */
  memberSessionIds: string[];
  /** Creation timestamp */
  createdAt: number;
}

/** Request to create a zone group */
export interface CreateZoneGroupRequest {
  /** Session IDs to group together */
  memberSessionIds: string[];
  /** Optional group name */
  name?: string;
  /** Optional color */
  color?: string;
}

/** Request to update a zone group (add/remove members, rename, recolor) */
export interface UpdateZoneGroupRequest {
  /** New group name */
  name?: string;
  /** Session IDs to add to the group */
  addMembers?: string[];
  /** Session IDs to remove from the group */
  removeMembers?: string[];
  /** New color */
  color?: string;
}

// ============================================================================
// Agent Provider Configuration (Settings)
// ============================================================================

/** LLM provider configuration (reusable across agent instances) */
export interface LLMProviderConfig {
  /** Provider name: "anthropic", "openai", "deepseek", "ollama", "custom" */
  provider: string;
  /** API key (stored server-side only, never sent to client) */
  apiKey?: string;
  /** Model name (e.g., "claude-sonnet-4-20250514", "gpt-4o", "deepseek-chat") */
  model?: string;
  /** Custom API base URL (for custom/self-hosted providers) */
  baseUrl?: string;
  /** Max tokens per request */
  maxTokens?: number;
}

/** Redacted LLM config sent to client (API key masked) */
export interface LLMProviderConfigRedacted {
  provider: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** True if an API key is configured (key itself not sent) */
  hasApiKey: boolean;
}

/** Auto-compact settings */
export interface AutoCompactSettings {
  enabled: boolean;
  /** Token threshold to trigger compact (default: 150000) */
  threshold: number;
  /** Minimum seconds between compactions (default: 120) */
  cooldownSeconds: number;
}

/** Auto-continue settings */
export interface AutoContinueSettings {
  enabled: boolean;
  /** Max consecutive auto-continues per task (default: 3) */
  maxRetries: number;
  /** Minimum seconds between continues (default: 5) */
  cooldownSeconds: number;
  /** Prompt text to send (default: "continue") */
  continuePrompt: string;
}

/** Complete agent provider settings (persisted server-side) */
export interface AgentProviderSettings {
  /** Named LLM provider configurations */
  llmProviders: Record<string, LLMProviderConfig>;
  /** Default provider name for new agents */
  defaultProvider?: string;
  /** Auto-compact configuration */
  autoCompact?: AutoCompactSettings;
  /** Auto-continue configuration */
  autoContinue?: AutoContinueSettings;
}

/** Redacted settings sent to client */
export interface AgentProviderSettingsRedacted {
  llmProviders: Record<string, LLMProviderConfigRedacted>;
  defaultProvider?: string;
  autoCompact?: AutoCompactSettings;
  autoContinue?: AutoContinueSettings;
}

// ============================================================================
// Agent Launch Mode
// ============================================================================

/** How an agent instance is launched */
export type LaunchMode = "local" | "docker" | "gateway";

/** Launch mode configuration */
export interface LaunchModeConfig {
  mode: LaunchMode;
  /** Local mode: path to binary or project directory */
  binaryPath?: string;
  projectDir?: string;
  /** Docker mode: image, volumes, env */
  dockerImage?: string;
  dockerVolumes?: string[];
  dockerEnv?: Record<string, string>;
  useAppleContainer?: boolean;
  /** Gateway mode: remote URL and auth */
  gatewayUrl?: string;
  gatewayToken?: string;
}

// ============================================================================
// Settings API Types
// ============================================================================

export interface GetSettingsResponse {
  ok: boolean;
  settings: AgentProviderSettingsRedacted;
}

export interface UpdateSettingsRequest {
  llmProviders?: Record<string, LLMProviderConfig>;
  defaultProvider?: string;
  autoCompact?: Partial<AutoCompactSettings>;
  autoContinue?: Partial<AutoContinueSettings>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface RealmConfig {
  /** WebSocket server port */
  serverPort: number;
  /** Path to events JSONL file */
  eventsFile: string;
  /** Maximum events to keep in memory */
  maxEventsInMemory: number;
  /** Enable debug logging */
  debug: boolean;
}

export const DEFAULT_CONFIG: RealmConfig = {
  serverPort: 4003,
  eventsFile: "./data/events.jsonl",
  maxEventsInMemory: 1000,
  debug: false,
};
