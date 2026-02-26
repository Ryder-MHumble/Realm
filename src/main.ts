/**
 * Vibecraft - Main Entry Point
 *
 * Visualize Claude Code as an interactive 3D workshop
 * Supports multiple Claude instances in separate zones
 */

import "./styles/index.css";
import * as THREE from "three";
import {
  WorkshopScene,
  ZONE_COLORS,
  type Zone,
  type CameraMode,
} from "./scene/WorkshopScene";
// Character model - swap by changing the import:
// import { Claude } from './entities/Claude'      // Original simple character
import { Claude } from "./entities/ClaudeMon"; // Robot buddy character
import { SubagentManager } from "./entities/SubagentManager";
import { EventClient } from "./events/EventClient";
import { eventBus, type EventContext, type EventType } from "./events/EventBus";
import { registerAllHandlers } from "./events/handlers";
import {
  AGENT_TYPES,
  type ClaudeEvent,
  type ClaudeMode,
  type PreToolUseEvent,
  type PostToolUseEvent,
  type ManagedSession,
} from "../shared/types";
import { soundManager } from "./audio";

// Expose for console testing (can remove in production)
(window as any).soundManager = soundManager;
import {
  setupVoiceControl,
  joinText,
  type VoiceState,
} from "./ui/VoiceControl";
import { getToolIcon } from "./utils/ToolUtils";
import { AttentionSystem } from "./systems/AttentionSystem";
import { TimelineManager } from "./ui/TimelineManager";
import {
  FeedManager,
  formatTokens,
  formatTimeAgo,
  escapeHtml,
} from "./ui/FeedManager";
import { ContextMenu, type ContextMenuContext } from "./ui/ContextMenu";
import {
  setupKeyboardShortcuts,
  getSessionKeybind,
} from "./ui/KeyboardShortcuts";
import { setupKeybindSettings, updateVoiceHint } from "./ui/KeybindSettings";
import {
  setupQuestionModal,
  showQuestionModal,
  hideQuestionModal,
  type QuestionData,
} from "./ui/QuestionModal";
import { toast } from "./ui/Toast";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";
import {
  setupZoneInfoModal,
  showZoneInfoModal,
  setZoneInfoSoundEnabled,
} from "./ui/ZoneInfoModal";
import {
  setupZoneCommandModal,
  showZoneCommandModal,
} from "./ui/ZoneCommandModal";
import {
  setupPermissionModal,
  showPermissionModal,
  hidePermissionModal,
} from "./ui/PermissionModal";
import { setupSlashCommands } from "./ui/SlashCommands";
import { setupDirectoryAutocomplete } from "./ui/DirectoryAutocomplete";
import { checkForUpdates } from "./ui/VersionChecker";
import { drawMode } from "./ui/DrawMode";
import { setupTextLabelModal, showTextLabelModal } from "./ui/TextLabelModal";
import { createSessionAPI, type SessionAPI } from "./api";
import { initI18n, t, setLocale, getLocale } from "./i18n";
import type { Locale } from "./i18n";

// ============================================================================
// Configuration
// ============================================================================

// Injected by Vite at build time from shared/defaults.ts
declare const __VIBECRAFT_DEFAULT_PORT__: number;

// Port configuration: URL param > localStorage > default from shared/defaults.ts
function getAgentPort(): number {
  const params = new URLSearchParams(window.location.search);
  const urlPort = params.get("port");
  if (urlPort) return parseInt(urlPort, 10);

  const storedPort = localStorage.getItem("vibecraft-agent-port");
  if (storedPort) return parseInt(storedPort, 10);

  return __VIBECRAFT_DEFAULT_PORT__;
}

const AGENT_PORT = getAgentPort();

// In dev, Vite proxies /ws and /api to the server
// In prod (hosted), connect to localhost where user's agent runs
const WS_URL = import.meta.env.DEV
  ? `ws://${window.location.host}/ws`
  : `ws://localhost:${AGENT_PORT}`;

const API_URL = import.meta.env.DEV ? "/api" : `http://localhost:${AGENT_PORT}`;

// Create session API instance
const sessionAPI = createSessionAPI(API_URL);

// ============================================================================
// State
// ============================================================================

/** Per-session state */
interface SessionState {
  claude: Claude;
  subagents: SubagentManager;
  zone: Zone;
  color: number;
  stats: {
    toolsUsed: number;
    filesTouched: Set<string>;
    activeSubagents: number;
  };
}

interface AppState {
  scene: WorkshopScene | null;
  client: EventClient | null;
  sessions: Map<string, SessionState>;
  focusedSessionId: string | null; // Currently focused session for camera/prompts
  eventHistory: ClaudeEvent[];
  managedSessions: ManagedSession[]; // Managed sessions from server
  zoneGroups: import("../shared/types").ZoneGroup[]; // Zone groups from server
  selectedManagedSession: string | null; // Selected managed session ID for prompts
  serverCwd: string; // Server's working directory
  attentionSystem: AttentionSystem | null; // Manages attention queue and notifications
  timelineManager: TimelineManager | null; // Manages icon timeline
  feedManager: FeedManager | null; // Manages activity feed
  soundEnabled: boolean; // Whether to play sounds
  hasAutoOverviewed: boolean; // Whether we've done initial auto-overview for 2+ sessions
  userChangedCamera: boolean; // Whether user has manually changed camera (to avoid overriding)
  voice: VoiceState | null; // Voice input state and controls
  lastPrompts: Map<string, string>; // Last prompt sent per Claude session ID
  promptHistory: string[]; // History of sent prompts for up/down navigation
  historyIndex: number; // Current position in history (-1 = not navigating)
  historyDraft: string; // Saved draft when navigating history
}

const state: AppState = {
  scene: null,
  client: null,
  sessions: new Map(),
  focusedSessionId: null,
  eventHistory: [],
  serverCwd: "~",
  managedSessions: [],
  zoneGroups: [],
  selectedManagedSession: null,
  attentionSystem: null, // Initialized in init()
  timelineManager: null, // Initialized in init()
  feedManager: null, // Initialized in init()
  soundEnabled: true,
  hasAutoOverviewed: false,
  userChangedCamera: false,
  voice: null, // Initialized in setupVoiceInput()
  lastPrompts: new Map(),
  promptHistory: [],
  historyIndex: -1,
  historyDraft: "",
};

// Expose for console testing (can remove in production)
(window as any).state = state;

// Track pending zone hints for direction-aware placement
// Maps managed session name → click position (used when zone is created)
const pendingZoneHints = new Map<string, { x: number; z: number }>();

// Track pending zones to clean up when real zone appears
// Maps managed session name → pending zone ID
const pendingZonesToCleanup = new Map<string, string>();

// Track zone creation timeouts (pendingId → timeoutId)
const pendingZoneTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// Zone creation timeout in ms
const ZONE_CREATION_TIMEOUT = 30000;

// ============================================================================
// Managed Sessions (Orchestration)
// ============================================================================

/**
 * Render a single session option element (vertical dropdown item for session chip)
 */
function renderSessionOption(
  session: ManagedSession,
  globalIndex: number,
  _isGrouped: boolean,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "session-option";
  if (session.id === state.selectedManagedSession) {
    el.classList.add("active");
  }

  const needsAttention =
    state.attentionSystem?.needsAttention(session.id) ?? false;
  if (needsAttention) {
    el.classList.add("needs-attention");
  }

  const statusClass = session.status;
  const hotkey = getSessionKeybind(globalIndex) || "";

  // Build tooltip with full details
  const lastPrompt = session.claudeSessionId
    ? state.lastPrompts.get(session.claudeSessionId)
    : null;
  const tooltipParts = [
    `Name: ${session.name}`,
    `Status: ${session.status}`,
    session.cwd ? `Dir: ${session.cwd}` : "",
    session.currentTool ? `Tool: ${session.currentTool}` : "",
    session.lastActivity
      ? `Last active: ${new Date(session.lastActivity).toLocaleString()}`
      : "",
    lastPrompt ? `Last prompt: ${lastPrompt}` : "",
  ].filter(Boolean);
  el.title = tooltipParts.join("\n");

  el.innerHTML = `
    <span class="session-option-status ${statusClass}"></span>
    <span class="session-option-name">${escapeHtml(session.name)}</span>
    ${hotkey ? `<span class="session-option-hotkey">${hotkey}</span>` : ""}
  `;

  // Left click selects and closes dropdown
  el.addEventListener("click", () => {
    selectManagedSession(session.id);
    closeSessionChipDropdown();
  });

  // Right-click for context menu (rename/delete/restart)
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const items: Array<{
      key: string;
      label: string;
      action: string;
      danger?: boolean;
    }> = [];

    if (session.status === "offline") {
      items.push({ key: "R", label: "Restart", action: "pill_restart" });
    }
    items.push({ key: "N", label: "Rename", action: "pill_rename" });
    items.push({
      key: "X",
      label: "Delete",
      action: "pill_delete",
      danger: true,
    });

    if (contextMenu) {
      contextMenu.show(e.clientX, e.clientY, items, {
        managedSessionId: session.id,
        managedSessionName: session.name,
      });
    }
  });

  return el;
}

/** Close the session chip dropdown */
function closeSessionChipDropdown(): void {
  const dropdown = document.getElementById("session-chip-dropdown");
  const btn = document.getElementById("session-chip-btn");
  dropdown?.classList.add("hidden");
  btn?.classList.remove("open");
}

/** Update the session chip button to reflect the currently selected session */
function updateSessionChip(): void {
  const label = document.getElementById("session-chip-label");
  const dot = document.getElementById("session-chip-dot");
  if (!label || !dot) return;

  if (state.selectedManagedSession) {
    const session = state.managedSessions.find(
      (s) => s.id === state.selectedManagedSession,
    );
    if (session) {
      label.textContent = session.name;
      dot.className = `pill-status ${session.status}`;
      dot.style.display = "";
    } else {
      label.textContent = t("commandBar.allSessions");
      dot.style.display = "none";
    }
  } else {
    label.textContent = t("commandBar.allSessions");
    dot.style.display = "none";
  }
}

/**
 * Render the managed sessions as vertical options in the session chip dropdown
 */
/** Track existing option elements by session ID for diff-based updates */
const _pillElements = new Map<string, HTMLElement>();

function renderManagedSessions(): void {
  const container = document.getElementById("session-options");
  if (!container) return;

  // Update "All" option active state
  const allOption = document.querySelector(".session-option-all");
  if (allOption) {
    allOption.classList.toggle("active", state.selectedManagedSession === null);
  }

  // Update session chip button
  updateSessionChip();

  // Empty state hint
  if (state.managedSessions.length === 0) {
    // Remove all existing options
    for (const [id, el] of _pillElements) {
      el.remove();
      _pillElements.delete(id);
    }
    // Show hint if not already present
    if (!container.querySelector(".sessions-empty-hint")) {
      container.innerHTML = "";
      const hint = document.createElement("span");
      hint.className = "sessions-empty-hint";
      hint.textContent = t("commandBar.noZones");
      container.appendChild(hint);
    }
    return;
  }

  // Remove empty hint if present
  const hint = container.querySelector(".sessions-empty-hint");
  if (hint) hint.remove();

  // Build global index map for hotkey assignment
  const globalIndexMap = new Map<string, number>();
  state.managedSessions.forEach((s, i) => globalIndexMap.set(s.id, i));

  const currentIds = new Set(state.managedSessions.map((s) => s.id));

  // Remove options for sessions that no longer exist
  for (const [id, el] of _pillElements) {
    if (!currentIds.has(id)) {
      el.remove();
      _pillElements.delete(id);
    }
  }

  // Add or update options for each session
  for (const session of state.managedSessions) {
    const idx = globalIndexMap.get(session.id) ?? -1;
    const isGrouped = !!session.groupId;
    const existing = _pillElements.get(session.id);

    if (existing) {
      // Update existing option in-place (classes + content)
      updateSessionOption(existing, session, idx);
    } else {
      // Create new option
      const el = renderSessionOption(session, idx, isGrouped);
      el.dataset.sessionId = session.id;
      _pillElements.set(session.id, el);
      container.appendChild(el);
    }
  }

  // Ensure correct order
  for (const session of state.managedSessions) {
    const el = _pillElements.get(session.id);
    if (el) container.appendChild(el);
  }
}

/**
 * Update an existing session option element in-place without recreating it
 */
function updateSessionOption(
  el: HTMLElement,
  session: ManagedSession,
  globalIndex: number,
): void {
  // Update classes
  const needsAttention =
    state.attentionSystem?.needsAttention(session.id) ?? false;
  el.className = "session-option";
  if (session.id === state.selectedManagedSession) el.classList.add("active");
  if (needsAttention) el.classList.add("needs-attention");

  // Update status dot
  const statusDot = el.querySelector(".session-option-status");
  if (statusDot) {
    statusDot.className = `session-option-status ${session.status}`;
  }

  // Update name
  const nameSpan = el.querySelector(".session-option-name");
  if (nameSpan && nameSpan.textContent !== session.name) {
    nameSpan.textContent = session.name;
  }

  // Update hotkey
  const hotkey = getSessionKeybind(globalIndex) || "";
  const hotkeySpan = el.querySelector(".session-option-hotkey");
  if (hotkey && !hotkeySpan) {
    const span = document.createElement("span");
    span.className = "session-option-hotkey";
    span.textContent = hotkey;
    el.appendChild(span);
  } else if (!hotkey && hotkeySpan) {
    hotkeySpan.remove();
  } else if (hotkey && hotkeySpan && hotkeySpan.textContent !== hotkey) {
    hotkeySpan.textContent = hotkey;
  }

  // Update agent type badge
  const agentType = session.agentType || "claude_code";
  const agentBadge = el.querySelector(".session-option-agent-badge");
  if (agentType !== "claude_code") {
    const agentConfig = AGENT_TYPES[agentType];
    if (agentConfig && !agentBadge) {
      const badge = document.createElement("span");
      badge.className = "session-option-agent-badge";
      badge.textContent = agentConfig.icon;
      badge.title = agentConfig.name;
      // Insert before name
      const nameEl = el.querySelector(".session-option-name");
      if (nameEl) {
        nameEl.parentElement?.insertBefore(badge, nameEl);
      }
    }
  } else if (agentBadge) {
    agentBadge.remove();
  }

  // Update tooltip
  const lastPrompt = session.claudeSessionId
    ? state.lastPrompts.get(session.claudeSessionId)
    : null;
  const agentLabel = AGENT_TYPES[agentType]?.name || agentType;
  const tooltipParts = [
    `Name: ${session.name}`,
    `Agent: ${agentLabel}`,
    `Status: ${session.status}`,
    session.cwd ? `Dir: ${session.cwd}` : "",
    session.currentTool ? `Tool: ${session.currentTool}` : "",
    session.lastActivity
      ? `Last active: ${new Date(session.lastActivity).toLocaleString()}`
      : "",
    lastPrompt ? `Last prompt: ${lastPrompt}` : "",
  ].filter(Boolean);
  el.title = tooltipParts.join("\n");
}

/**
 * Select a managed session for prompts (null = all/legacy mode)
 * Also focuses the 3D zone if available
 */
function selectManagedSession(sessionId: string | null): void {
  state.selectedManagedSession = sessionId;
  renderManagedSessions();
  // Sound is played in focusSession() when the zone is focused

  // Persist selection to localStorage
  if (sessionId) {
    localStorage.setItem("vibecraft-selected-session", sessionId);
  } else {
    localStorage.removeItem("vibecraft-selected-session");
  }

  // Update feed filter to show only this session's events (or all if null)
  if (sessionId) {
    const session = state.managedSessions.find((s) => s.id === sessionId);
    // Filter by claudeSessionId if available, otherwise show nothing (session has no events yet)
    state.feedManager?.setFilter(session?.claudeSessionId ?? "__none__");

    // Focus the 3D zone if session is linked
    if (session?.claudeSessionId && state.scene) {
      state.scene.focusZone(session.claudeSessionId);
      focusSession(session.claudeSessionId);
    }
  } else {
    state.feedManager?.setFilter(null); // Show all sessions

    // Switch to overview mode showing all zones
    if (state.scene) {
      state.scene.setOverviewMode();
    }
  }

  // Update prompt target indicator for "all sessions" / null selection
  if (!sessionId) {
    const targetEl = document.getElementById("prompt-target");
    if (targetEl) {
      targetEl.innerHTML =
        '<span style="color: rgba(255,255,255,0.4)">all sessions</span>';
      targetEl.title = t("commandBar.selectSessionHint");
    }
    updateModeSelector(null);
  }
  // Note: when sessionId is set, focusSession() handles the prompt target update
}

/**
 * Create a new managed session
 */
interface SessionFlags {
  continue?: boolean;
  skipPermissions?: boolean;
  chrome?: boolean;
}

async function createManagedSession(
  name?: string,
  cwd?: string,
  flags?: SessionFlags,
  hintPosition?: { x: number; z: number },
  pendingZoneId?: string,
  mode?: ClaudeMode,
  description?: string,
  agentType?: import("../shared/types").AgentType,
  agentConfig?: Record<string, unknown>,
  launchMode?: import("../shared/types").LaunchModeConfig,
  llmProvider?: string,
  notificationChannels?: string[],
): Promise<void> {
  // Pre-store hint position and pending zone ID BEFORE the API call.
  // The server broadcasts sessions via WebSocket before the HTTP response returns,
  // so the WebSocket handler may create the zone before we get the response.
  // By pre-storing with the user-provided name, the WebSocket handler can find the hint.
  if (name) {
    if (hintPosition) {
      pendingZoneHints.set(name, hintPosition);
    }
    if (pendingZoneId) {
      pendingZonesToCleanup.set(name, pendingZoneId);
    }
  }

  const data = await sessionAPI.createSession(
    name,
    cwd,
    flags,
    mode,
    description,
    agentType,
    agentConfig,
    launchMode,
    llmProvider,
    notificationChannels,
  );

  if (!data.ok) {
    console.error("Failed to create session:", data.error);
    // Clean up pre-stored entries on failure
    if (name) {
      pendingZoneHints.delete(name);
      pendingZonesToCleanup.delete(name);
    }
    // Show offline banner if not connected, otherwise show alert
    if (!state.client?.isConnected) {
      showOfflineBanner();
    } else {
      alert(`Failed to create session: ${data.error}`);
    }
    // Clean up pending zone on failure
    if (pendingZoneId && state.scene) {
      state.scene.removePendingZone(pendingZoneId);
    }
    return;
  }

  // Re-key hint data if server used a different name than what we pre-stored
  const actualName = data.session?.name;
  if (actualName) {
    if (name && name !== actualName) {
      // Server changed the name — move pre-stored entries to actual name
      const existingHint = pendingZoneHints.get(name);
      if (existingHint) {
        pendingZoneHints.delete(name);
        pendingZoneHints.set(actualName, existingHint);
      }
      const existingPzId = pendingZonesToCleanup.get(name);
      if (existingPzId) {
        pendingZonesToCleanup.delete(name);
        pendingZonesToCleanup.set(actualName, existingPzId);
      }
    } else if (!name) {
      // No name was provided, server auto-generated one — store now
      // (race condition may still occur in this case)
      if (hintPosition) {
        pendingZoneHints.set(actualName, hintPosition);
      }
      if (pendingZoneId) {
        pendingZonesToCleanup.set(actualName, pendingZoneId);
      }
    }

    // Handle race condition: the WebSocket broadcast may have already
    // created the zone before this HTTP response returned. If so,
    // clean up the pending zone immediately to prevent the 30s timeout.
    if (pendingZoneId) {
      const zoneId =
        data.session?.claudeSessionId || `managed:${data.session?.id}`;
      if (state.scene && state.scene.zones.has(zoneId)) {
        state.scene.removePendingZone(pendingZoneId);
        pendingZonesToCleanup.delete(actualName);
        const timeoutId = pendingZoneTimeouts.get(pendingZoneId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          pendingZoneTimeouts.delete(pendingZoneId);
        }
      }
    }
  }
}

/**
 * Fetch server info (cwd, etc.) and update UI
 */
async function fetchServerInfo(): Promise<void> {
  const data = await sessionAPI.getServerInfo();
  if (data.ok && data.cwd) {
    state.serverCwd = data.cwd;
    // Update feed manager for path shortening
    state.feedManager?.setCwd(data.cwd);
    // Update modal display
    const cwdEl = document.getElementById("modal-default-cwd");
    if (cwdEl) {
      cwdEl.textContent = data.cwd;
    }
  }
}

/**
 * Rename a managed session
 */
async function renameManagedSession(
  sessionId: string,
  name: string,
): Promise<void> {
  const data = await sessionAPI.renameSession(sessionId, name);
  if (!data.ok) {
    console.error("Failed to rename session:", data.error);
  }
  // Update will be broadcast via WebSocket
}

/**
 * Save zone position for a managed session (persists grid layout)
 */
async function saveZonePosition(
  sessionId: string,
  position: { q: number; r: number },
): Promise<void> {
  const data = await sessionAPI.saveZonePosition(sessionId, position);
  if (!data.ok) {
    console.error("Failed to save zone position:", data.error);
  }
}

/**
 * Delete a managed session
 */
async function deleteManagedSession(sessionId: string): Promise<void> {
  const data = await sessionAPI.deleteSession(sessionId);
  if (!data.ok) {
    console.error("Failed to delete session:", data.error);
  }
  // If we deleted the selected session, clear selection
  if (state.selectedManagedSession === sessionId) {
    state.selectedManagedSession = null;
    const targetEl = document.getElementById("prompt-target");
    if (targetEl) targetEl.innerHTML = "";
  }
  // Update will be broadcast via WebSocket
}

/**
 * Restart an offline session
 */
async function restartManagedSession(
  sessionId: string,
  sessionName: string,
): Promise<void> {
  // Show feedback while restarting
  const statusEl = document.getElementById("connection-status");
  const originalText = statusEl?.textContent;
  if (statusEl) {
    statusEl.textContent = `Restarting ${sessionName}...`;
    statusEl.className = "";
  }

  const data = await sessionAPI.restartSession(sessionId);

  if (!data.ok) {
    console.error("Failed to restart session:", data.error);
    if (statusEl) {
      statusEl.textContent = `Failed: ${data.error}`;
      statusEl.className = "error";
      setTimeout(() => {
        statusEl.textContent = originalText || "Connected";
        statusEl.className = "connected";
      }, 3000);
    }
  } else {
    if (statusEl) {
      statusEl.textContent = `${sessionName} restarted!`;
      statusEl.className = "connected";
      setTimeout(() => {
        statusEl.textContent = originalText || "Connected";
      }, 2000);
    }
  }
  // Update will be broadcast via WebSocket
}

/**
 * Send a prompt to the selected managed session
 */
async function sendPromptToManagedSession(
  prompt: string,
  sessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const targetSession = sessionId ?? state.selectedManagedSession;
  if (!targetSession) {
    return { ok: false, error: "No session selected" };
  }

  return sessionAPI.sendPrompt(targetSession, prompt);
}

// ============================================================================
// Attention System Helpers
// ============================================================================

/** Go to the next session needing attention */
function goToNextAttention(): void {
  if (!state.attentionSystem) return;

  const session = state.attentionSystem.getNext(state.managedSessions);
  if (!session) return;

  // Select and focus
  state.userChangedCamera = true; // User intentionally chose this view
  selectManagedSession(session.id);
  if (session.claudeSessionId && state.scene) {
    state.scene.focusZone(session.claudeSessionId);
    focusSession(session.claudeSessionId);
  }
}

/**
 * Setup managed sessions UI
 */

// Current zone hint for the open modal (set when modal opens from click)
let currentModalHint: { x: number; z: number } | null = null;

/**
 * Open the new session modal (callable from anywhere)
 * @param hintPosition - Optional world position from click for direction-aware placement
 */
function openNewSessionModal(hintPosition?: { x: number; z: number }): void {
  const modal = document.getElementById("new-session-modal");
  const nameInput = document.getElementById(
    "session-name-input",
  ) as HTMLInputElement;
  const cwdInput = document.getElementById(
    "session-cwd-input",
  ) as HTMLInputElement;

  if (!modal) return;

  // Store hint for when session is created
  currentModalHint = hintPosition ?? null;

  // Request notification permission on first interaction
  AttentionSystem.requestPermission();

  // Reset inputs
  if (nameInput) {
    nameInput.value = "";
    nameInput.dataset.autoFilled = "false";
  }
  if (cwdInput) cwdInput.value = "";

  // Reset agent type selector and all agent-specific sections
  const agentTypeSelect = document.getElementById(
    "session-agent-type",
  ) as HTMLSelectElement;
  if (agentTypeSelect) agentTypeSelect.value = "claude_code";
  const claudeCodeOptions = document.getElementById("claude-code-options");
  if (claudeCodeOptions) claudeCodeOptions.style.display = "";

  // Hide non-Claude sections
  for (const id of [
    "generic-agent-options",
    "launch-local-options",
    "launch-docker-options",
    "launch-gateway-options",
    "session-llm-options",
    "session-notification-options",
  ]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }

  // Reset launch mode to local
  const localRadio = document.querySelector(
    'input[name="launch-mode"][value="local"]',
  ) as HTMLInputElement;
  if (localRadio) localRadio.checked = true;

  modal.classList.add("visible");

  // Play modal open sound
  soundManager.play("modal_open");

  // Focus directory input after animation (it's now first)
  setTimeout(() => cwdInput?.focus(), 100);
}

function setupManagedSessions(): void {
  // Modal elements
  const modal = document.getElementById("new-session-modal");
  const nameInput = document.getElementById(
    "session-name-input",
  ) as HTMLInputElement;
  const cwdInput = document.getElementById(
    "session-cwd-input",
  ) as HTMLInputElement;
  const defaultCwdEl = document.getElementById("modal-default-cwd");
  const cancelBtn = document.getElementById("modal-cancel");
  const createBtn = document.getElementById("modal-create");

  // Default cwd will be set by fetchServerInfo()

  // Setup directory autocomplete
  if (cwdInput) {
    setupDirectoryAutocomplete(cwdInput);
  }

  // Agent type selector: show/hide type-specific options
  const agentTypeSelect = document.getElementById(
    "session-agent-type",
  ) as HTMLSelectElement;
  const claudeCodeOptions = document.getElementById("claude-code-options");
  const genericAgentOptions = document.getElementById("generic-agent-options");
  const sessionLlmOptions = document.getElementById("session-llm-options");
  const sessionNotificationOptions = document.getElementById(
    "session-notification-options",
  );
  const launchLocalOptions = document.getElementById("launch-local-options");
  const launchDockerOptions = document.getElementById("launch-docker-options");
  const launchGatewayOptions = document.getElementById(
    "launch-gateway-options",
  );

  const updateLaunchModeVisibility = (): void => {
    const selectedMode =
      (
        document.querySelector(
          'input[name="launch-mode"]:checked',
        ) as HTMLInputElement
      )?.value || "local";
    if (launchLocalOptions)
      launchLocalOptions.style.display = selectedMode === "local" ? "" : "none";
    if (launchDockerOptions)
      launchDockerOptions.style.display =
        selectedMode === "docker" ? "" : "none";
    if (launchGatewayOptions)
      launchGatewayOptions.style.display =
        selectedMode === "gateway" ? "" : "none";
  };

  const populateSettingsDropdowns = async (): Promise<void> => {
    try {
      const resp = await sessionAPI.getSettings();
      if (!resp.ok) return;
      const { settings } = resp;

      // Populate LLM provider dropdown
      const llmSelect = document.getElementById(
        "session-llm-provider",
      ) as HTMLSelectElement;
      if (llmSelect) {
        // Keep the first "Use Default" option, remove the rest
        while (llmSelect.options.length > 1) llmSelect.options.remove(1);
        for (const [name, config] of Object.entries(settings.llmProviders)) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = `${name} (${config.provider}${config.model ? " / " + config.model : ""})`;
          llmSelect.appendChild(opt);
        }
      }

      // Populate notification channel checkboxes
      const channelContainer = document.getElementById(
        "session-notification-channels",
      );
      if (channelContainer) {
        channelContainer.innerHTML = "";
        for (const [name, channel] of Object.entries(
          settings.notificationChannels,
        )) {
          if (!channel.enabled) continue;
          const label = document.createElement("label");
          label.className = "modal-checkbox";
          label.innerHTML = `<input type="checkbox" value="${name}" checked /><span class="checkbox-label">${name} (${channel.platform})</span>`;
          channelContainer.appendChild(label);
        }
        if (channelContainer.children.length === 0) {
          channelContainer.innerHTML =
            '<span class="field-hint" style="margin:0;">No channels configured</span>';
        }
      }
    } catch {
      // Settings fetch failed — silently skip
    }
  };

  if (agentTypeSelect) {
    agentTypeSelect.addEventListener("change", () => {
      const isClaudeCode = agentTypeSelect.value === "claude_code";
      if (claudeCodeOptions)
        claudeCodeOptions.style.display = isClaudeCode ? "" : "none";
      if (genericAgentOptions)
        genericAgentOptions.style.display = isClaudeCode ? "none" : "";
      if (sessionLlmOptions)
        sessionLlmOptions.style.display = isClaudeCode ? "none" : "";
      if (sessionNotificationOptions)
        sessionNotificationOptions.style.display = isClaudeCode ? "none" : "";

      if (!isClaudeCode) {
        updateLaunchModeVisibility();
        populateSettingsDropdowns();
      } else {
        if (launchLocalOptions) launchLocalOptions.style.display = "none";
        if (launchDockerOptions) launchDockerOptions.style.display = "none";
        if (launchGatewayOptions) launchGatewayOptions.style.display = "none";
      }
    });
  }

  // Launch mode radio change
  document.querySelectorAll('input[name="launch-mode"]').forEach((radio) => {
    radio.addEventListener("change", updateLaunchModeVisibility);
  });

  // Auto-populate name from directory when cwd changes
  if (cwdInput && nameInput) {
    cwdInput.addEventListener("input", () => {
      // Only auto-fill if name is empty or was auto-filled before
      if (
        nameInput.value.trim() === "" ||
        nameInput.dataset.autoFilled === "true"
      ) {
        const cwd = cwdInput.value.trim();
        if (cwd) {
          // Extract basename (last path component)
          const basename = cwd.replace(/\/+$/, "").split("/").pop() || "";
          if (basename) {
            // Check for duplicate names and add suffix if needed
            let name = basename;
            let suffix = 1;
            while (state.managedSessions.some((s) => s.name === name)) {
              suffix++;
              name = `${basename} ${suffix}`;
            }
            nameInput.value = name;
            nameInput.dataset.autoFilled = "true";
          }
        }
      }
    });

    // Mark as manually edited when user types in name field
    nameInput.addEventListener("input", () => {
      nameInput.dataset.autoFilled = "false";
    });
  }

  const descriptionInput = document.getElementById(
    "session-description-input",
  ) as HTMLTextAreaElement;

  const closeModal = (): void => {
    modal?.classList.remove("visible");
    currentModalHint = null; // Clear hint when modal closes
  };

  const handleCreate = (): void => {
    const name = nameInput?.value.trim() || undefined;
    const cwd = cwdInput?.value.trim() || undefined;
    const description = descriptionInput?.value.trim() || undefined;

    // Read agent type selector
    const agentTypeSelect = document.getElementById(
      "session-agent-type",
    ) as HTMLSelectElement;
    const agentType = (agentTypeSelect?.value ||
      "claude_code") as import("../shared/types").AgentType;

    // Read flag checkboxes (only relevant for claude_code)
    const continueCheck = document.getElementById(
      "session-opt-continue",
    ) as HTMLInputElement;
    const skipPermsCheck = document.getElementById(
      "session-opt-skip-perms",
    ) as HTMLInputElement;
    const chromeCheck = document.getElementById(
      "session-opt-chrome",
    ) as HTMLInputElement;

    const flags: SessionFlags =
      agentType === "claude_code"
        ? {
            continue: continueCheck?.checked ?? true,
            skipPermissions: skipPermsCheck?.checked ?? true,
            chrome: chromeCheck?.checked ?? false,
          }
        : {};

    // Collect launch mode config for non-Claude agents
    let launchMode: import("../shared/types").LaunchModeConfig | undefined;
    let llmProvider: string | undefined;
    let notificationChannels: string[] | undefined;

    if (agentType !== "claude_code") {
      const selectedMode =
        (
          document.querySelector(
            'input[name="launch-mode"]:checked',
          ) as HTMLInputElement
        )?.value || "local";

      launchMode = {
        mode: selectedMode as import("../shared/types").LaunchMode,
      };

      if (selectedMode === "local") {
        const binaryPath = (
          document.getElementById("session-binary-path") as HTMLInputElement
        )?.value.trim();
        if (binaryPath) launchMode.binaryPath = binaryPath;
      } else if (selectedMode === "docker") {
        const dockerImage = (
          document.getElementById("session-docker-image") as HTMLInputElement
        )?.value.trim();
        const appleContainer = (
          document.getElementById("session-apple-container") as HTMLInputElement
        )?.checked;
        if (dockerImage) launchMode.dockerImage = dockerImage;
        if (appleContainer) launchMode.useAppleContainer = true;
      } else if (selectedMode === "gateway") {
        const gatewayUrl = (
          document.getElementById("session-gateway-url") as HTMLInputElement
        )?.value.trim();
        const gatewayToken = (
          document.getElementById("session-gateway-token") as HTMLInputElement
        )?.value.trim();
        if (gatewayUrl) launchMode.gatewayUrl = gatewayUrl;
        if (gatewayToken) launchMode.gatewayToken = gatewayToken;
      }

      // LLM provider
      const llmSelect = document.getElementById(
        "session-llm-provider",
      ) as HTMLSelectElement;
      if (llmSelect?.value) llmProvider = llmSelect.value;

      // Notification channels
      const channelCheckboxes = document.querySelectorAll(
        "#session-notification-channels input[type=checkbox]:checked",
      ) as NodeListOf<HTMLInputElement>;
      if (channelCheckboxes.length > 0) {
        notificationChannels = Array.from(channelCheckboxes).map(
          (cb) => cb.value,
        );
      }
    }

    // Capture hint before closing modal (closeModal clears it)
    const hintPosition = currentModalHint;

    // Create pending zone immediately for visual feedback
    const pendingId = `pending-${Date.now()}`;
    if (state.scene) {
      state.scene.createPendingZone(pendingId, hintPosition ?? undefined);
    }

    // Set timeout to show troubleshooting modal if zone doesn't start
    const timeoutId = setTimeout(() => {
      // Check if this pending zone still exists (wasn't cleaned up)
      for (const [, pId] of pendingZonesToCleanup) {
        if (pId === pendingId) {
          showZoneTimeoutModal();
          break;
        }
      }
      pendingZoneTimeouts.delete(pendingId);
    }, ZONE_CREATION_TIMEOUT);
    pendingZoneTimeouts.set(pendingId, timeoutId);

    // Play confirm sound
    soundManager.play("modal_confirm");

    closeModal();
    createManagedSession(
      name,
      cwd,
      flags,
      hintPosition ?? undefined,
      pendingId,
      undefined,
      description,
      agentType,
      undefined,
      launchMode,
      llmProvider,
      notificationChannels,
    );
  };

  const handleCancel = (): void => {
    soundManager.play("modal_cancel");
    closeModal();
  };

  // New session pill opens modal (no hint position from button click)
  const newBtn = document.getElementById("new-session-pill");
  if (newBtn) {
    newBtn.addEventListener("click", () => openNewSessionModal());
  }

  // Modal cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", handleCancel);
  }

  // Modal create button
  if (createBtn) {
    createBtn.addEventListener("click", handleCreate);
  }

  // Close on Escape key (also plays cancel sound)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("visible")) {
      soundManager.play("modal_cancel");
      closeModal();
    }
  });

  // Close on backdrop click
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        soundManager.play("modal_cancel");
        closeModal();
      }
    });
  }

  // Enter key in inputs triggers create
  const handleEnter = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && modal?.classList.contains("visible")) {
      handleCreate();
    }
  };
  nameInput?.addEventListener("keydown", handleEnter);
  cwdInput?.addEventListener("keydown", handleEnter);

  // "All" option click handler (in session chip dropdown)
  const allOption = document.querySelector(".session-option-all");
  if (allOption) {
    allOption.addEventListener("click", () => {
      selectManagedSession(null);
      closeSessionChipDropdown();
    });
  }

  // Session chip dropdown toggle
  const chipBtn = document.getElementById("session-chip-btn");
  const chipDropdown = document.getElementById("session-chip-dropdown");
  if (chipBtn && chipDropdown) {
    chipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = !chipDropdown.classList.contains("hidden");
      if (isOpen) {
        closeSessionChipDropdown();
      } else {
        chipDropdown.classList.remove("hidden");
        chipBtn.classList.add("open");
      }
    });
    // Close on outside click
    document.addEventListener("click", () => {
      closeSessionChipDropdown();
    });
    chipDropdown.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // New zone button in session chip dropdown
  const newSessionOption = document.getElementById("new-session-option");
  if (newSessionOption) {
    newSessionOption.addEventListener("click", () => {
      closeSessionChipDropdown();
      openNewSessionModal();
    });
  }

  // Feed drawer toggle & close (floating button)
  const feedDrawer = document.getElementById("feed-drawer");
  const feedToggleBtn = document.getElementById("feed-toggle-floating");
  const drawerClose = document.getElementById("feed-drawer-close");

  const syncFeedToggle = () => {
    const isOpen = feedDrawer?.classList.contains("open");
    feedToggleBtn?.classList.toggle("active", !!isOpen);
  };

  if (feedToggleBtn && feedDrawer) {
    feedToggleBtn.addEventListener("click", () => {
      feedDrawer.classList.toggle("open");
      syncFeedToggle();
    });
  }
  if (drawerClose && feedDrawer) {
    drawerClose.addEventListener("click", () => {
      feedDrawer.classList.remove("open");
      syncFeedToggle();
    });
  }

  // Initial render
  renderManagedSessions();
}

// ============================================================================
// Context Menu (appears at click location for create/delete actions)
// ============================================================================

let contextMenu: ContextMenu | null = null;

function handleContextMenuAction(
  action: string,
  context: ContextMenuContext,
): void {
  if (action === "create" && context.worldPosition) {
    openNewSessionModal({
      x: context.worldPosition.x,
      z: context.worldPosition.z,
    });
  } else if (action === "command" && context.zoneId) {
    showZoneCommand(context.zoneId);
  } else if (action === "mode" && context.zoneId) {
    showModeMenu(context.zoneId, context.screenPosition);
  } else if (action === "info" && context.zoneId) {
    showZoneInfo(context.zoneId);
  } else if (action === "rename_group" && context.zoneId) {
    const managed = state.managedSessions.find(
      (s) => s.claudeSessionId === context.zoneId,
    );
    if (managed?.groupId) renameGroup(managed.groupId);
  } else if (action === "remove_from_group" && context.zoneId) {
    const managed = state.managedSessions.find(
      (s) => s.claudeSessionId === context.zoneId,
    );
    if (managed?.groupId) removeFromGroup(managed.groupId, context.zoneId);
  } else if (action === "add_to_group_menu" && context.zoneId) {
    // Show secondary context menu listing available groups
    const groupItems = state.zoneGroups.map((g, i) => ({
      key: String(i + 1),
      label: g.name || `Department ${i + 1}`,
      action: `join_group_${g.id}`,
    }));
    if (groupItems.length > 0 && context.screenPosition) {
      contextMenu?.show(
        context.screenPosition.x,
        context.screenPosition.y,
        groupItems,
        { zoneId: context.zoneId },
      );
    }
  } else if (action.startsWith("join_group_") && context.zoneId) {
    const groupId = action.replace("join_group_", "");
    addToGroup(groupId, context.zoneId);
  } else if (action === "pill_rename" && context.managedSessionId) {
    const sid = context.managedSessionId as string;
    const sname = (context.managedSessionName as string) || "";
    const newName = prompt(t("contextMenu.enterNewName"), sname);
    if (newName && newName !== sname) {
      renameManagedSession(sid, newName);
    }
  } else if (action === "pill_delete" && context.managedSessionId) {
    const sid = context.managedSessionId as string;
    const sname = (context.managedSessionName as string) || "";
    if (confirm(t("contextMenu.confirmDelete", { name: sname }))) {
      deleteManagedSession(sid);
    }
  } else if (action === "pill_restart" && context.managedSessionId) {
    const sid = context.managedSessionId as string;
    const sname = (context.managedSessionName as string) || "";
    restartManagedSession(sid, sname);
  } else if (action === "delete" && context.zoneId) {
    deleteZoneBySessionId(context.zoneId);
  } else if (action === "create_text_tile" && context.hexPosition) {
    createTextTileAtHex(context.hexPosition as { q: number; r: number });
  } else if (action === "edit_text_tile" && context.textTileId) {
    editTextTile(context.textTileId as string);
  } else if (action === "delete_text_tile" && context.textTileId) {
    deleteTextTile(context.textTileId as string);
  } else if (action.startsWith("mode_") && context.zoneId) {
    const newMode = action.replace("mode_", "") as ClaudeMode;
    switchSessionMode(context.zoneId, newMode);
  }
}

/**
 * Show mode submenu for a zone
 */
function showModeMenu(sessionId: string, pos: { x: number; y: number }): void {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed) return;

  const currentMode = managed.mode || "auto-edit";

  // Build mode options with checkmark for current
  const modes: Array<{
    key: string;
    label: string;
    action: string;
  }> = [
    {
      key: "1",
      label: `${currentMode === "auto-edit" ? "● " : "  "}Auto-edit`,
      action: "mode_auto-edit",
    },
    {
      key: "2",
      label: `${currentMode === "plan" ? "● " : "  "}Plan`,
      action: "mode_plan",
    },
    {
      key: "3",
      label: `${currentMode === "ask-before-edit" ? "● " : "  "}Ask before edit`,
      action: "mode_ask-before-edit",
    },
  ];

  contextMenu?.show(pos.x + 10, pos.y, modes, { zoneId: sessionId });
}

/**
 * Switch a session's mode via the API
 */
async function switchSessionMode(
  sessionId: string,
  newMode: ClaudeMode,
): Promise<void> {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed) return;

  const currentMode = managed.mode || "auto-edit";
  if (currentMode === newMode) return;

  const result = await sessionAPI.switchMode(managed.id, newMode);
  if (result.ok) {
    toast.success(
      `Mode changed to ${newMode === "auto-edit" ? "Auto-edit" : newMode === "plan" ? "Plan" : "Ask before edit"}`,
    );
  } else if (result.error === "restart_required") {
    // Show restart confirmation
    const confirmed = confirm(
      `Switching from "${currentMode}" to "${newMode}" requires restarting the session. Continue?`,
    );
    if (confirmed) {
      // Delete and recreate with new mode
      toast.info("Restarting session with new mode...");
      // TODO: Could implement a restart-with-mode endpoint
      // For now, just inform the user
      toast.warning(
        "Please delete and recreate the zone with the desired mode.",
      );
    }
  } else {
    toast.error(`Failed to switch mode: ${result.error}`);
  }
}

// ============================================================================
// Mode Selector (inline dropdown near prompt input)
// ============================================================================

const MODE_CONFIG: Record<
  ClaudeMode,
  { icon: string; label: string; cssClass: string }
> = {
  "auto-edit": { icon: "⚡", label: "Auto-edit", cssClass: "mode-auto-edit" },
  plan: { icon: "📋", label: "Plan", cssClass: "mode-plan" },
  "ask-before-edit": {
    icon: "🔒",
    label: "Ask before edit",
    cssClass: "mode-ask-before-edit",
  },
};

function setupModeSelector(): void {
  const btn = document.getElementById("mode-selector-btn");
  const dropdown = document.getElementById("mode-selector-dropdown");
  const options = document.querySelectorAll(".mode-option");

  if (!btn || !dropdown) return;

  // Toggle dropdown
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains("hidden");
    if (isOpen) {
      closeModeDropdown();
    } else {
      dropdown.classList.remove("hidden");
      btn.classList.add("open");
    }
  });

  // Close on outside click
  document.addEventListener("click", () => {
    closeModeDropdown();
  });

  dropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Handle option clicks
  options.forEach((opt) => {
    opt.addEventListener("click", () => {
      const mode = (opt as HTMLElement).dataset.mode as ClaudeMode;
      if (!mode) return;

      // Find the focused/selected session
      const sessionId = state.focusedSessionId;
      if (sessionId) {
        switchSessionMode(sessionId, mode);
      }
      closeModeDropdown();
    });
  });

  function closeModeDropdown(): void {
    dropdown!.classList.add("hidden");
    btn!.classList.remove("open");
  }
}

/**
 * Update the mode selector button to reflect the current session's mode
 */
function updateModeSelector(sessionId: string | null): void {
  const container = document.getElementById("mode-selector");
  const btn = document.getElementById("mode-selector-btn");
  const iconEl = document.getElementById("mode-selector-icon");
  const labelEl = document.getElementById("mode-selector-label");
  const options = document.querySelectorAll(".mode-option");

  if (!container || !btn || !iconEl || !labelEl) return;

  // Find managed session
  const managed = sessionId
    ? state.managedSessions.find((s) => s.claudeSessionId === sessionId)
    : null;

  if (!managed) {
    // No session selected or not a managed session
    container.classList.add("disabled");
    iconEl.textContent = "";
    labelEl.textContent = t("commandBar.noSession");
    btn.className = ""; // Reset mode classes
    btn.id = "mode-selector-btn";
    options.forEach((o) => o.classList.remove("active"));
    return;
  }

  container.classList.remove("disabled");
  const currentMode = managed.mode || "auto-edit";
  const config = MODE_CONFIG[currentMode];

  iconEl.textContent = config.icon;
  labelEl.textContent = config.label;
  btn.className = config.cssClass;
  btn.id = "mode-selector-btn";

  // Update active state on options
  options.forEach((o) => {
    const optMode = (o as HTMLElement).dataset.mode;
    o.classList.toggle("active", optMode === currentMode);
  });
}

/**
 * Group two zones together (or add to existing group).
 * Takes claude session IDs and resolves to managed IDs for API call.
 * Smart merge: if either zone is already in a group, add the other to it.
 */
async function groupZonesWith(
  draggedClaudeId: string,
  targetClaudeId: string,
): Promise<void> {
  const draggedManaged = state.managedSessions.find(
    (s) => s.claudeSessionId === draggedClaudeId,
  );
  const targetManaged = state.managedSessions.find(
    (s) => s.claudeSessionId === targetClaudeId,
  );

  if (!draggedManaged || !targetManaged) {
    toast.error("Cannot group: session not found");
    return;
  }

  // Case 1: Target is already in a group → add dragged to that group
  if (targetManaged.groupId && !draggedManaged.groupId) {
    const result = await sessionAPI.updateGroup(targetManaged.groupId, {
      addMembers: [draggedManaged.id],
    });
    if (result.ok) {
      const group = state.zoneGroups.find(
        (g) => g.id === targetManaged.groupId,
      );
      toast.info(
        `Added "${draggedManaged.name}" to "${group?.name || "department"}"`,
      );
      if (state.soundEnabled) soundManager.play("spawn");
    } else {
      toast.error(`Failed to add to group: ${result.error}`);
    }
    return;
  }

  // Case 2: Dragged is already in a group → add target to that group
  if (draggedManaged.groupId && !targetManaged.groupId) {
    const result = await sessionAPI.updateGroup(draggedManaged.groupId, {
      addMembers: [targetManaged.id],
    });
    if (result.ok) {
      const group = state.zoneGroups.find(
        (g) => g.id === draggedManaged.groupId,
      );
      toast.info(
        `Added "${targetManaged.name}" to "${group?.name || "department"}"`,
      );
      if (state.soundEnabled) soundManager.play("spawn");
    } else {
      toast.error(`Failed to add to group: ${result.error}`);
    }
    return;
  }

  // Case 3: Both in different groups → server merges via POST
  // Case 4: Neither in a group → create fresh group
  const memberIds = [draggedManaged.id, targetManaged.id];
  const result = await sessionAPI.createGroup(memberIds);
  if (result.ok) {
    toast.info(`Grouped "${draggedManaged.name}" with "${targetManaged.name}"`);
    if (state.soundEnabled) soundManager.play("spawn");
  } else {
    toast.error(`Failed to group: ${result.error}`);
  }
}

/**
 * Add a session to an existing group/department
 */
async function addToGroup(groupId: string, sessionId: string): Promise<void> {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId || s.id === sessionId,
  );
  if (!managed) return;

  const result = await sessionAPI.updateGroup(groupId, {
    addMembers: [managed.id],
  });
  if (result.ok) {
    const group = state.zoneGroups.find((g) => g.id === groupId);
    toast.info(`Added "${managed.name}" to "${group?.name || "department"}"`);
    if (state.soundEnabled) soundManager.play("spawn");
  } else {
    toast.error(`Failed: ${result.error}`);
  }
}

/**
 * Remove one session from its group (vs dissolving the entire group)
 */
async function removeFromGroup(
  groupId: string,
  sessionId: string,
): Promise<void> {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId || s.id === sessionId,
  );
  if (!managed) return;

  const result = await sessionAPI.updateGroup(groupId, {
    removeMembers: [managed.id],
  });
  if (result.ok) {
    toast.info(`Removed "${managed.name}" from department`);
  } else {
    toast.error(`Failed: ${result.error}`);
  }
}

/**
 * Rename a group/department
 */
async function renameGroup(groupId: string): Promise<void> {
  const group = state.zoneGroups.find((g) => g.id === groupId);
  if (!group) return;

  const newName = prompt(t("contextMenu.enterNewName"), group.name || "");
  if (newName === null) return;

  const result = await sessionAPI.updateGroup(groupId, {
    name: newName || undefined,
  });
  if (result.ok) {
    toast.info(newName ? `Renamed to "${newName}"` : "Cleared department name");
  } else {
    toast.error(`Failed to rename: ${result.error}`);
  }
}

/**
 * Ungroup a zone (dissolve its entire group)
 */
async function ungroupZone(sessionId: string): Promise<void> {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed?.groupId) return;

  const result = await sessionAPI.deleteGroup(managed.groupId);
  if (result.ok) {
    toast.info(`Dissolved department`);
  } else {
    toast.error(`Failed to ungroup: ${result.error}`);
  }
}

/**
 * Focus camera on group centroid
 */
function focusOnGroup(groupId: string): void {
  const group = state.zoneGroups.find((g) => g.id === groupId);
  if (!group || !state.scene) return;

  const positions: { x: number; z: number }[] = [];
  for (const memberId of group.memberSessionIds) {
    const session = state.managedSessions.find((s) => s.id === memberId);
    if (session?.claudeSessionId) {
      const pos = state.scene.getZoneWorldPosition(session.claudeSessionId);
      if (pos) positions.push(pos);
    }
  }

  if (positions.length === 0) return;

  const centroid = {
    x: positions.reduce((sum, p) => sum + p.x, 0) / positions.length,
    z: positions.reduce((sum, p) => sum + p.z, 0) / positions.length,
  };

  state.scene.focusCentroid(centroid, positions.length);
}

/**
 * Show the zone info modal for a session
 */
function showZoneInfo(sessionId: string): void {
  // Find the managed session
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed) {
    console.warn("No managed session found for zone:", sessionId);
    return;
  }

  // Get session stats if available
  const sessionState = state.sessions.get(sessionId);
  const stats = sessionState?.stats;

  showZoneInfoModal({
    managedSession: managed,
    stats,
  });
}

/**
 * Show the zone command modal for quick commands to a specific zone
 */
function showZoneCommand(sessionId: string): void {
  // Find the managed session
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed) {
    console.warn("No managed session found for zone:", sessionId);
    return;
  }

  // Get zone position
  const zone = state.scene?.getZone(sessionId);
  if (!zone || !state.scene) {
    console.warn("No zone found for session:", sessionId);
    return;
  }

  showZoneCommandModal({
    sessionId: managed.id,
    sessionName: managed.name,
    sessionColor: zone.color,
    zonePosition: zone.position,
    camera: state.scene.camera,
    renderer: state.scene.renderer,
    onSend: async (id: string, prompt: string) => {
      return sendPromptToManagedSession(prompt, id);
    },
  });
}

/**
 * Create a text tile at a hex position (opens modal for text)
 */
async function createTextTileAtHex(hex: {
  q: number;
  r: number;
}): Promise<void> {
  const text = await showTextLabelModal({
    title: "Add Label",
    placeholder: "Enter your label text here...\nSupports multiple lines.",
  });
  if (!text?.trim()) return;

  try {
    await fetch(`${API_URL}/tiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.trim(),
        position: hex,
      }),
    });
  } catch (e) {
    console.error("Failed to create text tile:", e);
  }
}

/**
 * Edit an existing text tile
 */
async function editTextTile(tileId: string): Promise<void> {
  const tile = state.scene?.getTextTiles().find((t) => t.id === tileId);
  if (!tile) return;

  const text = await showTextLabelModal({
    title: "Edit Label",
    placeholder: "Enter your label text here...",
    initialText: tile.text,
  });
  if (text === null || text.trim() === tile.text) return;

  try {
    await fetch(`${API_URL}/tiles/${tileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    });
  } catch (e) {
    console.error("Failed to update text tile:", e);
  }
}

/**
 * Delete a text tile
 */
async function deleteTextTile(tileId: string): Promise<void> {
  try {
    await fetch(`${API_URL}/tiles/${tileId}`, {
      method: "DELETE",
    });
  } catch (e) {
    console.error("Failed to delete text tile:", e);
  }
}

/**
 * Delete a zone (finds the managed session and deletes it)
 */
async function deleteZoneBySessionId(zoneId: string): Promise<void> {
  // Find the managed session for this zone
  const managedSession = state.managedSessions.find(
    (s) => s.claudeSessionId === zoneId,
  );

  if (!managedSession) {
    console.warn("No managed session found for zone:", zoneId);
    return;
  }

  // Use existing delete function
  await deleteManagedSession(managedSession.id);
}

function setupContextMenu(): void {
  contextMenu = new ContextMenu({
    onAction: handleContextMenuAction,
  });
}

// ============================================================================
// Keyboard Shortcuts & Camera Modes
// ============================================================================

/**
 * Setup click handler to focus session when clicking on Claude
 */
function setupClickToPrompt(): void {
  if (!state.scene) return;

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Track mousedown position to distinguish clicks from drags
  let mouseDownPos: { x: number; y: number } | null = null;
  const CLICK_THRESHOLD = 5; // pixels - if moved more than this, it's a drag

  // Draw mode drag painting state
  let isDrawModeDragging = false;
  const paintedThisDrag = new Set<string>(); // Track hexes painted during current drag

  // Zone drag-and-drop state
  let isDraggingZone = false;
  let draggedZoneId: string | null = null;
  let draggedZoneButton: number = -1;

  // Debounced save for hex art persistence (includes zone elevations)
  let hexArtSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveHexArt = () => {
    if (hexArtSaveTimer) clearTimeout(hexArtSaveTimer);
    hexArtSaveTimer = setTimeout(() => {
      if (!state.scene) return;
      const hexes = state.scene.getPaintedHexes();
      const zoneElevations = state.scene.getZoneElevations();
      localStorage.setItem("vibecraft-hexart", JSON.stringify(hexes));
      localStorage.setItem(
        "vibecraft-zone-elevations",
        JSON.stringify(zoneElevations),
      );
      const elevCount = Object.keys(zoneElevations).length;
      console.log(
        `Saved ${hexes.length} painted hexes and ${elevCount} zone elevations to localStorage`,
      );
    }, 500); // Debounce 500ms
  };

  // Helper to paint with brush size
  const paintWithBrush = (
    centerHex: { q: number; r: number },
    playSound: boolean,
  ) => {
    if (!state.scene) return;

    const brushSize = drawMode.getBrushSize();
    const color = drawMode.getSelectedColor();
    const hexesToPaint = state.scene.hexGrid.getHexesInRadius(
      centerHex,
      brushSize,
    );

    let anyPainted = false;
    for (const hex of hexesToPaint) {
      const hexKey = `${hex.q},${hex.r}`;
      if (!paintedThisDrag.has(hexKey)) {
        paintedThisDrag.add(hexKey);
        if (color === null) {
          state.scene.clearPaintedHex(hex);
        } else {
          state.scene.paintHex(hex, color);
        }
        anyPainted = true;
      }
    }

    if (anyPainted && playSound && state.soundEnabled) {
      soundManager.play("click");
    }

    // Save to localStorage (debounced)
    if (anyPainted) {
      saveHexArt();
    }
  };

  // Helper to convert mouse event to normalized coordinates and raycast
  const raycastFromMouse = (event: MouseEvent) => {
    const rect = state.scene!.renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, state.scene!.camera);
  };

  // Helper to find which zone was clicked (returns sessionId or null)
  const findClickedZone = (): string | null => {
    for (const [sessionId, zone] of state.scene!.zones) {
      const intersects = raycaster.intersectObject(zone.group, true);
      if (intersects.length > 0) return sessionId;
    }
    // Also check Claude meshes
    for (const [sessionId, session] of state.sessions) {
      const intersects = raycaster.intersectObject(session.claude.mesh, true);
      if (intersects.length > 0) return sessionId;
    }
    return null;
  };

  state.scene.renderer.domElement.addEventListener("mousedown", (event) => {
    mouseDownPos = { x: event.clientX, y: event.clientY };

    // Right-click on a zone: prepare for potential zone drag
    if (event.button === 2 && !drawMode.isEnabled()) {
      raycastFromMouse(event);
      const zoneId = findClickedZone();
      if (zoneId) {
        draggedZoneId = zoneId;
        draggedZoneButton = 2;
      }
    }

    // Start draw mode drag painting
    if (drawMode.isEnabled() && event.button === 0) {
      isDrawModeDragging = true;
      paintedThisDrag.clear();

      // Paint the initial hex(es) with brush
      raycastFromMouse(event);
      if (state.scene!.worldFloor) {
        const floorIntersects = raycaster.intersectObject(
          state.scene!.worldFloor,
        );
        if (floorIntersects.length > 0) {
          const point = floorIntersects[0].point;
          const hex = state.scene!.hexGrid.cartesianToHex(point.x, point.z);
          paintWithBrush(hex, true);
          // Spawn click pulse at zone elevation if clicking on a zone
          const zone = state.scene!.getZoneAtHex(hex);
          const pulseY = zone ? zone.elevation + 0.03 : 0.03;
          state.scene!.spawnClickPulse(point.x, point.z, 0x4ac8e8, pulseY);
        }
      }
    }
  });

  // Stop draw mode dragging if mouse released anywhere (safety net)
  window.addEventListener("mouseup", () => {
    if (isDrawModeDragging) {
      isDrawModeDragging = false;
      paintedThisDrag.clear();
    }
    // Clean up zone drag state if mouseup outside canvas
    if (isDraggingZone) {
      isDraggingZone = false;
      draggedZoneId = null;
      draggedZoneButton = -1;
      state.scene?.hideDragPreview();
      if (state.scene) state.scene.controls.enabled = true;
      state.scene?.renderer.domElement.style.removeProperty("cursor");
    }
  });

  // Zone drag-and-drop on mousemove
  state.scene.renderer.domElement.addEventListener("mousemove", (event) => {
    if (!state.scene || !draggedZoneId || !mouseDownPos) return;

    // Check if mouse moved enough to start dragging
    if (!isDraggingZone) {
      const dx = event.clientX - mouseDownPos.x;
      const dy = event.clientY - mouseDownPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > CLICK_THRESHOLD) {
        isDraggingZone = true;
        state.scene.controls.enabled = false; // Disable orbit during drag
        state.scene.renderer.domElement.style.cursor = "grabbing";
      }
    }

    if (isDraggingZone) {
      raycastFromMouse(event);
      if (state.scene.worldFloor) {
        const floorIntersects = raycaster.intersectObject(
          state.scene.worldFloor,
        );
        if (floorIntersects.length > 0) {
          const point = floorIntersects[0].point;
          const hex = state.scene.hexGrid.cartesianToHex(point.x, point.z);
          const zone = state.scene.zones.get(draggedZoneId!);
          if (zone) {
            const isAvailable = state.scene.isHexAvailable(hex, draggedZoneId!);
            const occupant = state.scene.hexGrid.getOccupant(hex);
            const isGroupTarget =
              !isAvailable && occupant && occupant !== draggedZoneId;
            const previewColor = isAvailable
              ? zone.color
              : isGroupTarget
                ? 0x60a5fa // Blue for merge/group
                : 0xff4444; // Red for invalid
            state.scene.showDragPreview(hex, previewColor);
          }
        }
      }
    }
  });

  // Draw mode drag painting on mousemove
  state.scene.renderer.domElement.addEventListener("mousemove", (event) => {
    if (!state.scene || !isDrawModeDragging || !drawMode.isEnabled()) return;

    raycastFromMouse(event);
    if (state.scene.worldFloor) {
      // Check both floor and painted hexes (for painting on top of existing)
      const floorIntersects = raycaster.intersectObject(state.scene.worldFloor);
      const paintedHexMeshes = state.scene.getPaintedHexMeshes();
      const paintedIntersects =
        paintedHexMeshes.length > 0
          ? raycaster.intersectObjects(paintedHexMeshes)
          : [];

      const allIntersects = [...floorIntersects, ...paintedIntersects].sort(
        (a, b) => a.distance - b.distance,
      );

      if (allIntersects.length > 0) {
        const point = allIntersects[0].point;
        const hex = state.scene.hexGrid.cartesianToHex(point.x, point.z);
        paintWithBrush(hex, true);
      }
    }
  });

  // Left-click handler
  state.scene.renderer.domElement.addEventListener("mouseup", (event) => {
    // Stop draw mode dragging
    if (isDrawModeDragging) {
      isDrawModeDragging = false;
      paintedThisDrag.clear();
    }

    // Complete zone drag-and-drop
    if (isDraggingZone && draggedZoneId && state.scene) {
      raycastFromMouse(event);
      if (state.scene.worldFloor) {
        const floorIntersects = raycaster.intersectObject(
          state.scene.worldFloor,
        );
        if (floorIntersects.length > 0) {
          const point = floorIntersects[0].point;
          const targetHex = state.scene.hexGrid.cartesianToHex(
            point.x,
            point.z,
          );

          // Check what's at the target hex
          if (state.scene.isHexAvailable(targetHex, draggedZoneId)) {
            // Free hex - move zone there, update group links after animation
            const sceneRef = state.scene;
            const groupsRef = state.zoneGroups;
            const sessionsRef = state.managedSessions;
            state.scene.moveZone(draggedZoneId, targetHex, true, () => {
              if (groupsRef.length > 0) {
                sceneRef.updateGroupLinks(groupsRef, sessionsRef);
              }
            });

            // Persist position via server API
            const managed = state.managedSessions.find(
              (s) => s.claudeSessionId === draggedZoneId,
            );
            if (managed) {
              sessionAPI.saveZonePosition(managed.id, targetHex);
            }

            // Play placement sound
            if (state.soundEnabled) {
              soundManager.play("click");
            }
          } else {
            // Occupied hex - try to group with the zone there
            const targetOccupant = state.scene.hexGrid.getOccupant(targetHex);
            if (targetOccupant && targetOccupant !== draggedZoneId) {
              groupZonesWith(draggedZoneId, targetOccupant);
            }
          }
        }
      }

      // Clean up drag state
      state.scene.hideDragPreview();
      state.scene.controls.enabled = true;
      state.scene.renderer.domElement.style.removeProperty("cursor");
      isDraggingZone = false;
      draggedZoneId = null;
      draggedZoneButton = -1;
      mouseDownPos = null;
      return; // Don't process as a normal click
    }

    // Clean up zone drag state even if drag didn't start (quick right-click)
    if (draggedZoneId) {
      draggedZoneId = null;
      draggedZoneButton = -1;
    }

    if (!state.scene || !mouseDownPos) return;

    // Check if this was a drag (mouse moved too much)
    const dx = event.clientX - mouseDownPos.x;
    const dy = event.clientY - mouseDownPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    mouseDownPos = null;

    if (distance > CLICK_THRESHOLD) {
      // This was a drag/pan, not a click - ignore
      return;
    }

    raycastFromMouse(event);

    // In draw mode, skip zone/Claude focus - painting is handled in mousedown/mousemove
    if (drawMode.isEnabled()) {
      return;
    }

    // Check entire zone groups (platform, ring, stations, everything)
    // This makes clicking anywhere in a zone select it
    for (const [sessionId, zone] of state.scene.zones) {
      const intersects = raycaster.intersectObject(zone.group, true);
      if (intersects.length > 0) {
        state.userChangedCamera = true; // User clicked to select
        state.scene!.focusZone(sessionId);
        focusSession(sessionId);

        // Play focus sound for zone click
        if (state.soundEnabled) {
          soundManager.play("focus");
        }

        // Select the managed session if linked, otherwise clear selection
        const managed = state.managedSessions.find(
          (s) => s.claudeSessionId === sessionId,
        );
        if (managed) {
          selectManagedSession(managed.id);
          state.attentionSystem?.remove(managed.id);
        } else {
          // Legacy/unlinked session - clear managed selection but filter to this session
          selectManagedSession(null);
          state.feedManager?.setFilter(sessionId);
        }
        return;
      }
    }

    // Also check Claude meshes (they're not in the zone group)
    for (const [sessionId, session] of state.sessions) {
      const intersects = raycaster.intersectObject(session.claude.mesh, true);
      if (intersects.length > 0) {
        state.userChangedCamera = true; // User clicked to select
        state.scene!.focusZone(sessionId);
        focusSession(sessionId);

        // Play focus sound for Claude click
        if (state.soundEnabled) {
          soundManager.play("focus");
        }

        const managed = state.managedSessions.find(
          (s) => s.claudeSessionId === sessionId,
        );
        if (managed) {
          selectManagedSession(managed.id);
          state.attentionSystem?.remove(managed.id);
        } else {
          // Legacy/unlinked session - clear managed selection but filter to this session
          selectManagedSession(null);
          state.feedManager?.setFilter(sessionId);
        }
        return;
      }
    }

    // Nothing was clicked - check if we hit the world floor or painted hexes
    // If so, show the context menu with create/text tile options
    if (state.scene.worldFloor) {
      // Check both floor and painted hexes (painted hexes block floor raycast)
      const floorIntersects = raycaster.intersectObject(state.scene.worldFloor);
      const paintedHexMeshes = state.scene.getPaintedHexMeshes();
      const paintedIntersects =
        paintedHexMeshes.length > 0
          ? raycaster.intersectObjects(paintedHexMeshes)
          : [];

      // Use whichever hit is closest (painted hex is usually on top of floor)
      const allIntersects = [...floorIntersects, ...paintedIntersects].sort(
        (a, b) => a.distance - b.distance,
      );

      if (allIntersects.length > 0) {
        const point = allIntersects[0].point;

        // Get hex position
        const hex = state.scene.hexGrid.cartesianToHex(point.x, point.z);

        // Normal mode: context menu (draw mode returns early above)
        // Spawn visual pulse feedback at click location
        state.scene.spawnClickPulse(point.x, point.z);
        // Play click sound
        soundManager.play("click");

        // Check if there's already a text tile at this position
        const existingTile = state.scene.getTextTileAtHex(hex);

        if (existingTile) {
          // Show edit/delete menu for existing text tile
          contextMenu?.show(
            event.clientX,
            event.clientY,
            [
              {
                key: "E",
                label: t("contextMenu.editLabel"),
                action: "edit_text_tile",
              },
              {
                key: "D",
                label: t("contextMenu.deleteLabel"),
                action: "delete_text_tile",
                danger: true,
              },
            ],
            { textTileId: existingTile.id },
          );
        } else {
          // Show create menu for empty space
          contextMenu?.show(
            event.clientX,
            event.clientY,
            [
              {
                key: "C",
                label: t("contextMenu.createZone"),
                action: "create",
              },
              {
                key: "T",
                label: t("contextMenu.addLabel"),
                action: "create_text_tile",
              },
            ],
            { worldPosition: { x: point.x, z: point.z }, hexPosition: hex },
          );
        }
      }
    }
  });

  // Right-click handler for zones (delete menu)
  state.scene.renderer.domElement.addEventListener("contextmenu", (event) => {
    if (!state.scene) return;
    event.preventDefault(); // Prevent browser context menu

    // Don't show context menu if we were dragging a zone
    if (isDraggingZone) return;

    raycastFromMouse(event);
    const sessionId = findClickedZone();

    if (sessionId) {
      // Find the managed session name for display
      const managed = state.managedSessions.find(
        (s) => s.claudeSessionId === sessionId,
      );
      const zoneName = managed?.name || sessionId.slice(0, 8);

      // Current mode label for display
      const currentMode = managed?.mode || "auto-edit";
      const modeLabel =
        currentMode === "auto-edit"
          ? "Auto"
          : currentMode === "plan"
            ? "Plan"
            : "Ask";

      // Build context menu items
      const menuItems: Array<{
        key: string;
        label: string;
        action: string;
        danger?: boolean;
      }> = [
        { key: "C", label: t("contextMenu.command"), action: "command" },
        {
          key: "M",
          label: `${t("contextMenu.mode")}: ${modeLabel}`,
          action: "mode",
        },
        { key: "I", label: t("contextMenu.info"), action: "info" },
      ];

      // Group operations
      if (managed?.groupId) {
        menuItems.push({
          key: "N",
          label: t("contextMenu.renameDepartment"),
          action: "rename_group",
        });
        menuItems.push({
          key: "U",
          label: t("contextMenu.removeFromDepartment"),
          action: "remove_from_group",
        });
      } else if (state.zoneGroups.length > 0) {
        menuItems.push({
          key: "G",
          label: t("contextMenu.addToDepartment"),
          action: "add_to_group_menu",
        });
      }

      menuItems.push({
        key: "D",
        label: t("contextMenu.deleteZone"),
        action: "delete",
        danger: true,
      });

      contextMenu?.show(event.clientX, event.clientY, menuItems, {
        zoneId: sessionId,
      });
    }
  });
}

/**
 * Update the keybind helper UI based on current camera mode
 */
function updateKeybindHelper(mode: CameraMode): void {
  const helper = document.getElementById("keybind-helper");
  if (!helper) return;

  const modeLabel = document.getElementById("camera-mode-label");
  const modeDesc = document.getElementById("camera-mode-desc");

  if (modeLabel && modeDesc) {
    switch (mode) {
      case "focused":
        modeLabel.textContent = "Focused";
        modeDesc.textContent = state.focusedSessionId?.slice(0, 8) || "none";
        break;
      case "overview":
        modeLabel.textContent = "Overview";
        modeDesc.textContent = t("commandBar.allSessions");
        break;
      case "follow-active":
        modeLabel.textContent = "Follow";
        modeDesc.textContent = "auto-tracking";
        break;
    }
  }
}

/**
 * Setup the dev panel for testing animations
 * Toggle with Alt+D
 */
function setupDevPanel(): void {
  const devPanel = document.getElementById("dev-panel");
  const animationsContainer = document.getElementById("dev-animations");
  if (!devPanel || !animationsContainer) return;

  // Helper to get target Claude
  const getTargetClaude = (): InstanceType<typeof Claude> | null => {
    if (state.focusedSessionId) {
      const claude = state.sessions.get(state.focusedSessionId)?.claude;
      if (claude) return claude;
    }
    for (const session of state.sessions.values()) {
      return session.claude;
    }
    return null;
  };

  // We need to wait for a session to exist to get the behavior names
  const checkForSession = () => {
    let claude: InstanceType<typeof Claude> | null = null;
    for (const session of state.sessions.values()) {
      claude = session.claude;
      break;
    }

    if (!claude) {
      setTimeout(checkForSession, 1000);
      return;
    }

    animationsContainer.innerHTML = "";

    // --- Idle Behaviors Section ---
    const idleHeader = document.createElement("div");
    idleHeader.className = "dev-section-header";
    idleHeader.textContent = "Idle";
    animationsContainer.appendChild(idleHeader);

    const behaviors = claude.getIdleBehaviorNames();
    for (const name of behaviors) {
      const btn = document.createElement("button");
      btn.className = "dev-anim-btn";
      btn.textContent = name;
      btn.addEventListener("click", () => {
        const target = getTargetClaude();
        if (target) {
          target.playIdleBehavior(name);
          document
            .querySelectorAll(".dev-anim-btn")
            .forEach((b) => b.classList.remove("playing"));
          btn.classList.add("playing");
          setTimeout(() => btn.classList.remove("playing"), 2000);
        }
      });
      animationsContainer.appendChild(btn);
    }

    // --- Working Behaviors Section ---
    const workingHeader = document.createElement("div");
    workingHeader.className = "dev-section-header";
    workingHeader.textContent = "Working (by station)";
    animationsContainer.appendChild(workingHeader);

    const stations = claude.getWorkingBehaviorStations();
    for (const station of stations) {
      const btn = document.createElement("button");
      btn.className = "dev-anim-btn dev-anim-btn-working";
      btn.textContent = station;
      btn.addEventListener("click", () => {
        const target = getTargetClaude();
        if (target) {
          target.playWorkingBehavior(station);
          document
            .querySelectorAll(".dev-anim-btn")
            .forEach((b) => b.classList.remove("playing"));
          btn.classList.add("playing");
          // Working behaviors loop, so keep playing indicator longer
          setTimeout(() => btn.classList.remove("playing"), 4000);
        }
      });
      animationsContainer.appendChild(btn);
    }

    // --- Stop Button ---
    const stopBtn = document.createElement("button");
    stopBtn.className = "dev-anim-btn dev-anim-btn-stop";
    stopBtn.textContent = "⏹ Stop → Idle";
    stopBtn.addEventListener("click", () => {
      const target = getTargetClaude();
      if (target) {
        target.setState("idle");
        document
          .querySelectorAll(".dev-anim-btn")
          .forEach((b) => b.classList.remove("playing"));
      }
    });
    animationsContainer.appendChild(stopBtn);
  };

  checkForSession();
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Get or create a session for a given sessionId
 * Returns null if the session can't be linked to a managed session
 */
/** Map Claude sessionIds to managed session IDs */
const claudeToManagedLink = new Map<string, string>();

/** Map managed session ID → synthetic zone ID (for zones created before claudeSessionId is known) */
const managedToSyntheticZone = new Map<string, string>();

/** Snapshot of last received sessions for dedup (avoids redundant UI rebuilds) */
let _lastSessionsSnapshot = "";

function getOrCreateSession(
  sessionId: string,
  eventCwd?: string,
): SessionState | null {
  let session = state.sessions.get(sessionId);
  if (session) return session;

  if (!state.scene) {
    throw new Error("Scene not initialized");
  }

  // Check if this session can be linked to a managed session
  // Only create zones for sessions that are linked or can be linked
  const canLink = canLinkToManagedSession(sessionId, eventCwd);
  if (!canLink) {
    // Unlinked session - don't create a zone for it
    console.log(
      `Ignoring unlinked session ${sessionId.slice(0, 8)} (no matching managed session)`,
    );
    return null;
  }

  // Try to link to a managed session (prefers CWD match, falls back to timing)
  const linkedManagedSession = tryLinkToManagedSession(sessionId, eventCwd);

  // Check if a zone already exists with a synthetic ID for this managed session
  // If so, re-key it to the real Claude session ID instead of creating a new zone
  if (linkedManagedSession) {
    const syntheticId = managedToSyntheticZone.get(linkedManagedSession.id);
    if (syntheticId && state.scene.zones.has(syntheticId)) {
      const existingZone = state.scene.zones.get(syntheticId)!;
      const existingSession = state.sessions.get(syntheticId);

      // Re-key zone and session state
      state.scene.zones.delete(syntheticId);
      state.scene.zones.set(sessionId, existingZone);
      if (existingSession) {
        state.sessions.delete(syntheticId);
        state.sessions.set(sessionId, existingSession);
      }
      managedToSyntheticZone.delete(linkedManagedSession.id);

      // Update zone label
      const keybindIndex = state.managedSessions.indexOf(linkedManagedSession);
      const keybind =
        keybindIndex >= 0 ? getSessionKeybind(keybindIndex) : undefined;
      state.scene.updateZoneLabel(
        sessionId,
        linkedManagedSession.name,
        keybind,
      );

      console.log(
        `Re-keyed zone "${linkedManagedSession.name}" from synthetic to ${sessionId.slice(0, 8)}`,
      );

      // Save zone position to server if not already saved
      if (!linkedManagedSession.zonePosition) {
        const hexPos = state.scene.getZoneHexPosition(sessionId);
        if (hexPos) {
          saveZonePosition(linkedManagedSession.id, hexPos);
        }
      }

      return state.sessions.get(sessionId) || null;
    }
  }

  // No existing synthetic zone — create a new zone
  let hintPosition: { x: number; z: number } | undefined;
  if (linkedManagedSession) {
    if (linkedManagedSession.zonePosition) {
      const cartesian = state.scene.hexGrid.axialToCartesian(
        linkedManagedSession.zonePosition,
      );
      hintPosition = { x: cartesian.x, z: cartesian.z };
    } else {
      hintPosition = pendingZoneHints.get(linkedManagedSession.name);
      if (hintPosition) {
        pendingZoneHints.delete(linkedManagedSession.name);
      }
    }
  }

  // Create zone in the 3D scene with direction-aware placement
  const zone = state.scene.createZone(sessionId, { hintPosition });

  // Clean up pending zone now that real zone exists
  if (linkedManagedSession) {
    const pendingZoneId = pendingZonesToCleanup.get(linkedManagedSession.name);
    if (pendingZoneId && state.scene) {
      state.scene.removePendingZone(pendingZoneId);
      pendingZonesToCleanup.delete(linkedManagedSession.name);
      const timeoutId = pendingZoneTimeouts.get(pendingZoneId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        pendingZoneTimeouts.delete(pendingZoneId);
      }
    }
  }

  // Play zone creation sound
  if (state.soundEnabled) {
    soundManager.play("zone_create", { zoneId: sessionId });
  }

  if (linkedManagedSession) {
    // Update the zone label with the managed session name and keybind
    const keybindIndex = state.managedSessions.indexOf(linkedManagedSession);
    const keybind =
      keybindIndex >= 0 ? getSessionKeybind(keybindIndex) : undefined;
    state.scene.updateZoneLabel(sessionId, linkedManagedSession.name, keybind);
    console.log(
      `Linked Claude session ${sessionId.slice(0, 8)} to "${linkedManagedSession.name}"`,
    );

    // Save zone position to server if not already saved
    if (!linkedManagedSession.zonePosition) {
      const hexPos = state.scene.getZoneHexPosition(sessionId);
      if (hexPos) {
        saveZonePosition(linkedManagedSession.id, hexPos);
      }
    }
  }

  // Determine character color: use agent type color if linked to a non-claude_code session
  let characterColor = zone.color;
  let characterStatusColor: number | undefined;
  if (
    linkedManagedSession?.agentType &&
    linkedManagedSession.agentType !== "claude_code"
  ) {
    const agentConfig = AGENT_TYPES[linkedManagedSession.agentType];
    if (agentConfig) {
      characterColor = agentConfig.color;
      characterStatusColor = agentConfig.statusColor;
    }
  }

  // Create character with matching color, positioned at zone center
  const claude = new Claude(state.scene, {
    color: characterColor,
    statusColor: characterStatusColor,
    startStation: "center",
  });

  // Position Claude at the zone's center station
  const centerStation = zone.stations.get("center");
  if (centerStation) {
    claude.mesh.position.copy(centerStation.position);
  }

  // Create subagent manager
  const subagents = new SubagentManager(state.scene);

  session = {
    claude,
    subagents,
    zone,
    color: zone.color,
    stats: {
      toolsUsed: 0,
      filesTouched: new Set(),
      activeSubagents: 0,
    },
  };

  state.sessions.set(sessionId, session);
  console.log(
    `Created session ${sessionId.slice(0, 8)} (color: #${zone.color.toString(16)}, position: ${zone.position.x}, ${zone.position.z})`,
  );

  // Focus on first session
  if (state.sessions.size === 1) {
    focusSession(sessionId);
  }

  updateSessionList();
  return session;
}

/**
 * Check if a Claude session can be linked to a managed session
 * Returns true if already linked or if there's a matching unlinked managed session
 */
function canLinkToManagedSession(
  claudeSessionId: string,
  eventCwd?: string,
): boolean {
  // Already linked?
  if (claudeToManagedLink.has(claudeSessionId)) {
    return true;
  }

  // Is this session already known to a managed session?
  for (const managed of state.managedSessions) {
    if (managed.claudeSessionId === claudeSessionId) {
      return true;
    }
  }

  // Is there an unlinked managed session with matching CWD?
  if (eventCwd) {
    for (const managed of state.managedSessions) {
      if (!managed.claudeSessionId && managed.cwd === eventCwd) {
        return true;
      }
    }
  }

  // No timing-based fallback: it incorrectly links unrelated Claude sessions
  // (e.g. from VSCode) to newly-created managed sessions. The server handles
  // linking via CWD matching which is more reliable.
  return false;
}

/**
 * Try to link a Claude session to a managed session.
 * Priority: 1) CWD match, 2) timing (recently created within 30s).
 * CWD matching is more reliable because each managed session was spawned
 * in a specific directory - this prevents cross-linking when multiple
 * sessions exist.
 */
function tryLinkToManagedSession(
  claudeSessionId: string,
  eventCwd?: string,
): ManagedSession | null {
  // Check if already linked
  if (claudeToManagedLink.has(claudeSessionId)) {
    const managedId = claudeToManagedLink.get(claudeSessionId)!;
    return state.managedSessions.find((s) => s.id === managedId) || null;
  }

  // Priority 1: Match by CWD (most reliable)
  if (eventCwd) {
    for (const managed of state.managedSessions) {
      if (managed.claudeSessionId) continue;
      if (managed.cwd && managed.cwd === eventCwd) {
        claudeToManagedLink.set(claudeSessionId, managed.id);
        managed.claudeSessionId = claudeSessionId;
        linkSessionOnServer(managed.id, claudeSessionId);
        console.log(
          `Linked session ${claudeSessionId.slice(0, 8)} to "${managed.name}" by CWD match`,
        );
        return managed;
      }
    }
  }

  // No timing-based fallback: it incorrectly links unrelated Claude sessions
  // (e.g. from VSCode) to newly-created managed sessions. The server handles
  // linking via CWD matching which is more reliable.
  return null;
}

/**
 * Notify server about session linking
 */
async function linkSessionOnServer(
  managedId: string,
  claudeSessionId: string,
): Promise<void> {
  await sessionAPI.linkSession(managedId, claudeSessionId);
}

/**
 * Sync zone labels with managed session names
 * Uses explicit links first, then falls back to index matching
 */
function syncZoneLabels(): void {
  if (!state.scene) return;

  const zones = Array.from(state.scene.zones.entries());
  const managedSessions = state.managedSessions;

  // First pass: update zones that have explicit claudeSessionId links
  for (let i = 0; i < managedSessions.length; i++) {
    const managed = managedSessions[i];
    if (managed.claudeSessionId) {
      const keybind = getSessionKeybind(i);
      state.scene.updateZoneLabel(
        managed.claudeSessionId,
        managed.name,
        keybind,
      );
    }
  }

  // Second pass: for unlinked zones, try to match by index
  // Get zones that aren't linked to any managed session
  const linkedClaudeIds = new Set(
    managedSessions
      .filter((m) => m.claudeSessionId)
      .map((m) => m.claudeSessionId),
  );
  const unlinkedZones = zones.filter(([id]) => !linkedClaudeIds.has(id));

  // Get managed sessions that don't have a claudeSessionId link
  const unlinkedManaged = managedSessions.filter((m) => !m.claudeSessionId);

  // Match by index (first unlinked zone → first unlinked managed, etc.)
  for (
    let i = 0;
    i < Math.min(unlinkedZones.length, unlinkedManaged.length);
    i++
  ) {
    const [zoneId] = unlinkedZones[i];
    const managed = unlinkedManaged[i];

    // Update the zone label with keybind
    const managedIndex = managedSessions.indexOf(managed);
    const keybind =
      managedIndex >= 0 ? getSessionKeybind(managedIndex) : undefined;
    state.scene.updateZoneLabel(zoneId, managed.name, keybind);

    // Track locally for client-side zone management only.
    // Do NOT persist synthetic managed: IDs to server — real linking
    // happens when actual Claude Code events arrive via tryLinkToManagedSession.
    claudeToManagedLink.set(zoneId, managed.id);

    console.log(
      `Mapped zone ${zoneId.slice(0, 8)} to managed session "${managed.name}" (local only)`,
    );
  }
}

/**
 * Focus camera and UI on a specific session
 */
function focusSession(sessionId: string): void {
  const session = state.sessions.get(sessionId);
  if (!session || !state.scene) return;

  state.focusedSessionId = sessionId;
  state.scene.focusZone(sessionId);

  // Play focus sound
  if (state.soundEnabled) {
    soundManager.play("focus");
  }

  // Play a random idle animation when zone becomes active (if Claude is idle)
  if (
    session.claude.state === "idle" &&
    "playRandomIdleBehavior" in session.claude
  ) {
    (
      session.claude as { playRandomIdleBehavior: () => void }
    ).playRandomIdleBehavior();
  }

  // Update HUD
  const sessionEl = document.getElementById("session-id");
  if (sessionEl) {
    const shortId = sessionId.slice(0, 8);
    sessionEl.textContent = shortId;
    sessionEl.title = `Session: ${sessionId}`;
    sessionEl.style.color = `#${session.color.toString(16).padStart(6, "0")}`;
  }

  // Update prompt target indicator
  updatePromptTarget(sessionId, session.color);

  // Update mode selector to reflect this session's mode
  updateModeSelector(sessionId);

  updateStats();
}

/**
 * Update the prompt target indicator to show which session will receive prompts
 */
function updatePromptTarget(sessionId: string, color: number): void {
  const targetEl = document.getElementById("prompt-target");
  if (!targetEl) return;

  // Look up managed session to get name and index
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  const colorHex = `#${color.toString(16).padStart(6, "0")}`;

  if (managed) {
    const index = state.managedSessions.indexOf(managed) + 1;
    targetEl.innerHTML = `
      <span class="target-badge" style="background: ${colorHex}">${index}</span>
      <span style="color: ${colorHex}">${escapeHtml(managed.name)}</span>
    `;
    targetEl.title = `Prompts will be sent to ${managed.name}`;
  } else {
    targetEl.innerHTML = `
      <span class="target-dot" style="background: ${colorHex}"></span>
      <span>→ ${sessionId.slice(0, 8)}</span>
    `;
    targetEl.title = `Prompts will be sent to session ${sessionId}`;
  }
}

/**
 * Update session list in UI (for multi-session)
 */
function updateSessionList(): void {
  // Could add a session picker dropdown here later
  const count = state.sessions.size;
  const sessionEl = document.getElementById("session-id");
  if (sessionEl && count > 1) {
    sessionEl.title += ` (${count} sessions)`;
  }
}

// ============================================================================
// UI Updates
// ============================================================================

function updateStatus(connected: boolean, text?: string) {
  const dot = document.getElementById("status-dot");
  const textEl = document.getElementById("status-text");

  if (dot) {
    // Add 'working' class when actively working, 'connected' when idle, nothing when disconnected
    if (connected && text === "Working") {
      dot.className = "working";
    } else if (connected) {
      dot.className = "connected";
    } else {
      dot.className = "";
    }
  }

  if (textEl) {
    // Only show text when disconnected or connecting
    if (!connected || text === "Connecting...") {
      textEl.textContent = ` · ${text || "Disconnected"}`;
    } else {
      textEl.textContent = "";
    }
  }
}

function updateActivity(activity: string) {
  const el = document.getElementById("current-activity");
  if (el) {
    el.textContent = activity;
  }
}

function updateAttentionBadge() {
  const badge = document.getElementById("attention-badge");
  if (!badge || !state.scene) return;

  const needsAttention = state.scene.getZonesNeedingAttention();
  const count = needsAttention.length;

  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function updateStats() {
  const toolsEl = document.getElementById("stat-tools");
  const filesEl = document.getElementById("stat-files");
  const subagentsEl = document.getElementById("stat-subagents");

  // Aggregate stats from all sessions
  let totalTools = 0;
  let totalSubagents = 0;
  const allFiles = new Set<string>();

  for (const session of state.sessions.values()) {
    totalTools += session.stats.toolsUsed;
    totalSubagents += session.stats.activeSubagents;
    for (const file of session.stats.filesTouched) {
      allFiles.add(file);
    }
  }

  if (toolsEl) {
    toolsEl.textContent = totalTools.toString();
  }

  if (filesEl) {
    filesEl.textContent = allFiles.size.toString();
  }

  if (subagentsEl) {
    subagentsEl.textContent = totalSubagents.toString();
  }
}

// ============================================================================
// Event Handling
// ============================================================================

function handleEvent(event: ClaudeEvent) {
  // Get or create session for this event
  // Returns null if the session isn't linked to a managed session
  const session = getOrCreateSession(event.sessionId, event.cwd);

  state.eventHistory.push(event);

  // Dispatch to EventBus (new decoupled handlers)
  // This runs in parallel with the old switch statement during migration
  const eventContext: EventContext = {
    scene: state.scene,
    feedManager: state.feedManager,
    timelineManager: state.timelineManager,
    soundEnabled: state.soundEnabled,
    session: session
      ? {
          id: event.sessionId,
          color: session.color,
          claude: session.claude,
          subagents: session.subagents,
          zone: session.zone,
          stats: session.stats,
        }
      : null,
  };
  eventBus.emit(event.type as EventType, event as any, eventContext);

  // Auto-correct feed filter: if this event's session maps to the selected managed session
  // but the filter doesn't match, update it immediately. This handles race conditions where
  // events arrive before the sessions update (e.g., after restart or new session linking).
  if (state.selectedManagedSession && state.feedManager) {
    const managedId = claudeToManagedLink.get(event.sessionId);
    if (
      managedId === state.selectedManagedSession &&
      state.feedManager.getFilter() !== event.sessionId
    ) {
      state.feedManager.setFilter(event.sessionId);
    }
  }

  // If no session (unlinked), still add to feed/timeline with default color but skip 3D updates
  const eventColor = session?.color ?? 0x888888;
  state.timelineManager?.add(event, eventColor);
  state.feedManager?.add(event, eventColor);

  // Skip 3D scene updates for unlinked sessions
  if (!session) {
    return;
  }

  // Pulse the zone to indicate activity
  if (
    state.scene &&
    (event.type === "pre_tool_use" || event.type === "user_prompt_submit")
  ) {
    state.scene.pulseZone(event.sessionId);
    // Set working status when tools start (except for AskUserQuestion which sets attention)
    if (event.type === "pre_tool_use") {
      const toolEvent = event as PreToolUseEvent;
      if (toolEvent.tool !== "AskUserQuestion") {
        state.scene.setZoneStatus(event.sessionId, "working");
      }
    }
  }

  switch (event.type) {
    case "pre_tool_use": {
      const e = event as PreToolUseEvent;

      // [Sound, character movement, context text handled by EventBus]
      // [Thinking indicator handled by EventBus: feedHandlers.ts]

      // Update stats after subagent spawn (EventBus handles spawn itself)
      if (e.tool === "Task") {
        updateStats();
      }

      // AskUserQuestion needs attention and shows modal
      // (zone attention and AttentionSystem queue are handled by showQuestionModal)
      if (e.tool === "AskUserQuestion") {
        const toolInput = e.toolInput as {
          questions?: QuestionData["questions"];
        };
        if (toolInput.questions && toolInput.questions.length > 0) {
          // Find the managed session for this Claude session
          const managedSession = state.managedSessions.find(
            (s) => s.claudeSessionId === event.sessionId,
          );
          showQuestionModal({
            sessionId: event.sessionId,
            managedSessionId: managedSession?.id || null,
            questions: toolInput.questions,
          });
          updateAttentionBadge();
        }
      }

      updateActivity(`Using ${e.tool}...`);
      updateStatus(true, "Working");

      // Track file access
      const filePath = (e.toolInput as { file_path?: string }).file_path;
      if (filePath) {
        session.stats.filesTouched.add(filePath);
      }
      break;
    }

    case "post_tool_use": {
      const e = event as PostToolUseEvent;
      session.stats.toolsUsed++;

      // [Sound, notifications, character state handled by EventBus]
      // [Subagent removal handled by EventBus: subagentHandlers.ts]

      // Hide question modal when AskUserQuestion completes
      if (e.tool === "AskUserQuestion") {
        hideQuestionModal();
      }

      updateStats();
      updateActivity(e.success ? `${e.tool} complete` : `${e.tool} failed`);
      break;
    }

    case "stop": {
      // [Sound, character, context, zone status handled by EventBus]
      // [Thinking indicator handled by EventBus: feedHandlers.ts]

      // Update UI badge (zone attention set by zoneHandlers)
      updateAttentionBadge();
      updateActivity("Idle");
      updateStatus(true, "Ready");
      break;
    }

    case "user_prompt_submit": {
      const e = event as import("../shared/types").UserPromptSubmitEvent;
      // Store last prompt for this session
      state.lastPrompts.set(event.sessionId, e.prompt);
      renderManagedSessions();

      // [Sound, zone status, character state handled by EventBus]

      // Show thinking indicator AFTER feedManager.add() to ensure correct order
      // (prompt appears first, then thinking indicator)
      state.feedManager?.showThinking(event.sessionId, session.color);

      // Update UI badge (zone attention cleared by zoneHandlers)
      updateAttentionBadge();
      updateActivity("Processing prompt...");
      updateStatus(true, "Thinking");
      break;
    }

    case "session_start":
      // Reset stats for this session
      session.stats.toolsUsed = 0;
      session.stats.filesTouched.clear();
      updateStats();
      updateActivity("Session started");
      break;

    case "notification":
      // [Sound handled by EventBus: soundHandlers.ts]
      // Could trigger visual notification in 3D scene
      break;
  }
}

// ============================================================================
// Prompt Submission
// ============================================================================

const PROMPT_URL = `${API_URL}/prompt`;
const CANCEL_URL = `${API_URL}/cancel`;
const CONFIG_URL = `${API_URL}/config`;

async function fetchConfig() {
  try {
    const response = await fetch(CONFIG_URL);
    const data = await response.json();
    const usernameEl = document.getElementById("username");
    if (usernameEl && data.username) {
      usernameEl.textContent = data.username;
    }
  } catch (e) {
    console.log("Could not fetch config:", e);
  }
}

/**
 * Send Ctrl+C to a session to interrupt it.
 * Uses session-specific endpoint for managed sessions, falls back to legacy /cancel.
 * Sends twice with a delay to ensure Claude Code actually stops.
 */
async function cancelSession(sessionId?: string): Promise<boolean> {
  const url = sessionId
    ? `${API_URL}/sessions/${sessionId}/cancel`
    : CANCEL_URL;

  const response = await fetch(url, { method: "POST" });
  const data = await response.json();

  return data.ok;
}

/**
 * Interrupt (Ctrl+C) the currently selected session
 * Called from keyboard shortcut handler
 */
async function interruptSession(sessionName: string): Promise<void> {
  // Show toast immediately
  toast.info(`Interrupt sent to ${sessionName}`, {
    icon: "⛔",
    duration: 2500,
    html: true,
  });

  try {
    // Find the managed session to get its ID
    const session = state.managedSessions.find((s) => s.name === sessionName);
    const ok = await cancelSession(session?.id);

    if (!ok) {
      toast.error("Interrupt failed", {
        icon: "❌",
        duration: 3000,
      });
    }
  } catch (error) {
    toast.error("Connection error", {
      icon: "❌",
      duration: 3000,
    });
  }
}

function setupPromptForm() {
  const form = document.getElementById("prompt-form") as HTMLFormElement | null;
  const input = document.getElementById(
    "prompt-input",
  ) as HTMLTextAreaElement | null;
  const button = document.getElementById(
    "prompt-submit",
  ) as HTMLButtonElement | null;
  const cancelBtn = document.getElementById(
    "prompt-cancel",
  ) as HTMLButtonElement | null;
  const status = document.getElementById("prompt-status");

  if (!form || !input || !button) return;

  // Auto-expand textarea as user types
  const autoExpand = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  };
  input.addEventListener("input", () => {
    autoExpand();
    // Reset history navigation when user types
    state.historyIndex = -1;
    state.historyDraft = "";
  });

  // Setup slash command autocomplete
  setupSlashCommands(input);

  // ===== File Attachment Support =====
  const pendingFiles: Array<{
    file: File;
    id: string;
    previewUrl?: string;
  }> = [];
  const fileAttachmentsEl = document.getElementById("file-attachments");
  const fileUploadBtn = document.getElementById("file-upload-btn");
  const fileUploadInput = document.getElementById(
    "file-upload-input",
  ) as HTMLInputElement | null;
  const promptContainer = document.getElementById("prompt-container");

  function addPendingFile(file: File) {
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: { file: File; id: string; previewUrl?: string } = {
      file,
      id,
    };
    if (file.type.startsWith("image/")) {
      entry.previewUrl = URL.createObjectURL(file);
    }
    pendingFiles.push(entry);
    renderFileAttachments();
  }

  function removePendingFile(id: string) {
    const idx = pendingFiles.findIndex((f) => f.id === id);
    if (idx >= 0) {
      const entry = pendingFiles[idx];
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      pendingFiles.splice(idx, 1);
      renderFileAttachments();
    }
  }

  function clearPendingFiles() {
    for (const entry of pendingFiles) {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    }
    pendingFiles.length = 0;
    renderFileAttachments();
  }

  function getFileIcon(mimeType: string): string {
    if (mimeType.startsWith("image/")) return "\u{1f5bc}";
    if (mimeType === "application/pdf") return "\u{1f4c4}";
    return "\u{1f4ce}";
  }

  function renderFileAttachments() {
    if (!fileAttachmentsEl) return;
    if (pendingFiles.length === 0) {
      fileAttachmentsEl.classList.add("hidden");
      fileAttachmentsEl.innerHTML = "";
      return;
    }
    fileAttachmentsEl.classList.remove("hidden");
    fileAttachmentsEl.innerHTML = pendingFiles
      .map((entry) => {
        const isImage = entry.file.type.startsWith("image/");
        const sizeKB = (entry.file.size / 1024).toFixed(1);
        return `<div class="file-chip" data-file-id="${entry.id}">${
          isImage && entry.previewUrl
            ? `<img class="file-chip-preview" src="${entry.previewUrl}" alt="${entry.file.name}">`
            : `<span class="file-chip-icon">${getFileIcon(entry.file.type)}</span>`
        }<span class="file-chip-name">${entry.file.name}</span><span class="file-chip-size">${sizeKB}KB</span><button type="button" class="file-chip-remove" data-file-id="${entry.id}">\u00d7</button></div>`;
      })
      .join("");
    fileAttachmentsEl.querySelectorAll(".file-chip-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.fileId;
        if (id) removePendingFile(id);
      });
    });
  }

  // Clipboard paste handler (for screenshots)
  input.addEventListener("paste", (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addPendingFile(file);
      }
    }
  });

  // File upload button
  fileUploadBtn?.addEventListener("click", () => {
    fileUploadInput?.click();
  });
  fileUploadInput?.addEventListener("change", () => {
    const files = fileUploadInput?.files;
    if (files) {
      for (const file of Array.from(files)) {
        addPendingFile(file);
      }
      if (fileUploadInput) fileUploadInput.value = "";
    }
  });

  // Drag and drop on prompt container
  promptContainer?.addEventListener("dragover", (e) => {
    e.preventDefault();
    promptContainer.classList.add("drag-over");
  });
  promptContainer?.addEventListener("dragleave", () => {
    promptContainer.classList.remove("drag-over");
  });
  promptContainer?.addEventListener("drop", (e) => {
    e.preventDefault();
    promptContainer.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files) {
      for (const file of Array.from(files)) {
        addPendingFile(file);
      }
    }
  });

  // Keyboard handling: Cmd/Ctrl+Enter to send, Up/Down for history
  // Note: Skip if slash commands already handled the event
  input.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
      e.preventDefault();
      form.requestSubmit();
      return;
    }

    // Up arrow: navigate to older history
    if (e.key === "ArrowUp" && !e.defaultPrevented) {
      // Only handle if cursor is at start of input (or input is single line)
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const isSingleLine = !input.value.includes("\n");
      if (!atStart && !isSingleLine) return;

      if (state.promptHistory.length === 0) return;

      e.preventDefault();

      // Save current input as draft when starting navigation
      if (state.historyIndex === -1) {
        state.historyDraft = input.value;
      }

      // Move back in history
      const newIndex = Math.min(
        state.historyIndex + 1,
        state.promptHistory.length - 1,
      );
      if (newIndex !== state.historyIndex) {
        state.historyIndex = newIndex;
        input.value =
          state.promptHistory[state.promptHistory.length - 1 - newIndex];
        autoExpand();
      }
      return;
    }

    // Down arrow: navigate to newer history
    if (e.key === "ArrowDown" && !e.defaultPrevented) {
      // Only handle if navigating history
      if (state.historyIndex === -1) return;

      // Only handle if cursor is at end of input (or input is single line)
      const atEnd = input.selectionStart === input.value.length;
      const isSingleLine = !input.value.includes("\n");
      if (!atEnd && !isSingleLine) return;

      e.preventDefault();

      // Move forward in history
      state.historyIndex--;

      if (state.historyIndex === -1) {
        // Back to draft
        input.value = state.historyDraft;
      } else {
        input.value =
          state.promptHistory[
            state.promptHistory.length - 1 - state.historyIndex
          ];
      }
      autoExpand();
    }
  });

  // Cancel/Stop button handler
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (status) {
        status.textContent = t("status.stopping");
        status.className = "";
      }
      try {
        const ok = await cancelSession(
          state.selectedManagedSession ?? undefined,
        );
        if (status) {
          if (ok) {
            status.textContent = t("status.stopped");
            status.className = "success";
          } else {
            status.textContent = t("status.stopFailed");
            status.className = "error";
          }
        }
      } catch (error) {
        if (status) {
          status.textContent = t("status.connectionError");
          status.className = "error";
        }
      }
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // If voice recording is active, stop it first and wait for transcript
    if (state.voice?.isRecording) {
      const transcript = await state.voice.stop();
      if (transcript) {
        const existing = input.value.trim();
        input.value = joinText(existing, transcript);
      }
    }

    const prompt = input.value.trim();
    if (!prompt && pendingFiles.length === 0) return;

    const send = true;

    button.disabled = true;
    if (status) {
      status.textContent = send ? t("status.sending") : t("status.sending");
      status.className = "";
    }

    try {
      // Upload pending files if any
      let augmentedPrompt = prompt;
      if (pendingFiles.length > 0) {
        if (status) {
          status.textContent = t("fileUpload.uploading");
          status.className = "";
        }
        const uploadResult = await sessionAPI.uploadFiles(
          pendingFiles.map((f) => f.file),
        );
        if (!uploadResult.ok || !uploadResult.files) {
          if (status) {
            status.textContent =
              uploadResult.error || t("fileUpload.uploadFailed");
            status.className = "error";
          }
          button.disabled = false;
          return;
        }
        const fileRefs = uploadResult.files
          .map((f) => {
            const isImage = f.mimeType.startsWith("image/");
            if (isImage) {
              return `[Attached image: ${f.originalName}] Read file: ${f.savedPath}`;
            }
            return `[Attached file: ${f.originalName}] Read file: ${f.savedPath}`;
          })
          .join("\n");
        augmentedPrompt = prompt
          ? `${prompt}\n\n---\nAttached files:\n${fileRefs}`
          : `Please review the following attached files:\n${fileRefs}`;
        clearPendingFiles();
      }

      let data: {
        ok: boolean;
        error?: string;
        sent?: boolean;
        saved?: string;
        tmuxError?: string;
      };

      // If a managed session is selected, use the session API
      if (state.selectedManagedSession && send) {
        const session = state.managedSessions.find(
          (s) => s.id === state.selectedManagedSession,
        );
        data = await sendPromptToManagedSession(augmentedPrompt);
        if (data.ok && status) {
          status.textContent = t("status.sentTo", {
            name: session?.name || "session",
          });
          status.className = "success";
          // Add to history and reset navigation
          state.promptHistory.push(prompt);
          state.historyIndex = -1;
          state.historyDraft = "";
          input.value = "";
          input.style.height = "auto";
          state.feedManager?.scrollToBottom();
        } else if (!data.ok && status) {
          status.textContent = data.error || t("status.failedToSend");
          status.className = "error";
        }
      } else {
        // Legacy: send to default tmux session
        const response = await fetch(PROMPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: augmentedPrompt, send }),
        });
        data = await response.json();

        if (data.ok) {
          // Add to history and reset navigation
          state.promptHistory.push(prompt);
          state.historyIndex = -1;
          state.historyDraft = "";
          input.value = "";
          input.style.height = "auto"; // Reset height after submit
          state.feedManager?.scrollToBottom();
          if (status) {
            if (data.sent) {
              status.textContent = t("status.sentToClaude");
            } else if (data.tmuxError) {
              status.textContent = `Saved (tmux error: ${data.tmuxError})`;
              status.className = "error";
              return;
            } else {
              status.textContent = t("status.savedTo", {
                path: data.saved || "",
              });
            }
            status.className = "success";
          }
        } else {
          if (status) {
            status.textContent = data.error || t("status.failedToSend");
            status.className = "error";
          }
        }
      }
    } catch (error) {
      if (status) {
        status.textContent = t("status.connectionError");
        status.className = "error";
      }
    } finally {
      button.disabled = false;
    }
  });

  // Auto-focus input when tab/window becomes active
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      input.focus();
    }
  });

  window.addEventListener("focus", () => {
    input.focus();
  });

  // Focus when hovering over the feed drawer
  const feedDrawer = document.getElementById("feed-drawer");
  if (feedDrawer) {
    feedDrawer.addEventListener("mouseenter", () => {
      input.focus();
    });
  }

  // Focus on initial load
  input.focus();
}

// ============================================================================
// Terminal Output Panel
// ============================================================================

const TMUX_URL = `${API_URL}/tmux-output`;

let terminalPollInterval: number | null = null;

function setupTerminalToggle() {
  const toggle = document.getElementById("terminal-toggle");
  const panel = document.getElementById("terminal-panel");
  const output = document.getElementById("terminal-output");

  if (!toggle || !panel || !output) return;

  toggle.addEventListener("click", () => {
    const isHidden = panel.classList.toggle("hidden");
    toggle.classList.toggle("active", !isHidden);

    if (!isHidden) {
      // Start polling when visible
      fetchTerminalOutput();
      terminalPollInterval = window.setInterval(fetchTerminalOutput, 2000);
    } else {
      // Stop polling when hidden
      if (terminalPollInterval) {
        clearInterval(terminalPollInterval);
        terminalPollInterval = null;
      }
    }
  });

  async function fetchTerminalOutput() {
    if (!output || !panel) return;
    try {
      const response = await fetch(TMUX_URL);
      const data = await response.json();
      if (data.ok && data.output) {
        // Strip ANSI codes and clean up
        const cleaned = data.output
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI codes
          .replace(/\r/g, ""); // Remove carriage returns
        output.textContent = cleaned;
        // Auto-scroll to bottom
        panel.scrollTop = panel.scrollHeight;
      } else if (data.error) {
        output.textContent = `Error: ${data.error}`;
      }
    } catch (e) {
      output.textContent = "Failed to connect to server";
    }
  }
}

// ============================================================================
// Audio Initialization
// ============================================================================

let audioInitialized = false;

/**
 * Initialize audio on first user interaction (required by Web Audio API)
 */
async function initAudioOnInteraction(): Promise<void> {
  if (audioInitialized) return;
  audioInitialized = true;

  try {
    await soundManager.init();
    console.log("Audio initialized on user interaction");
    // Play jazzy intro sound on first interaction
    soundManager.play("intro");
  } catch (e) {
    console.error("Failed to initialize audio:", e);
  }
}

/**
 * Setup settings modal
 */
function setupSettingsModal(): void {
  const settingsBtn = document.getElementById("settings-btn");
  const modal = document.getElementById("settings-modal");
  const closeBtn = document.getElementById("settings-close");
  const volumeSlider = document.getElementById(
    "settings-volume",
  ) as HTMLInputElement | null;
  const volumeValue = document.getElementById("settings-volume-value");
  const spatialCheckbox = document.getElementById(
    "settings-spatial-audio",
  ) as HTMLInputElement | null;
  const streamingCheckbox = document.getElementById(
    "settings-streaming-mode",
  ) as HTMLInputElement | null;
  const gridSizeSlider = document.getElementById(
    "settings-grid-size",
  ) as HTMLInputElement | null;
  const gridSizeValue = document.getElementById("settings-grid-size-value");
  const refreshBtn = document.getElementById("settings-refresh-sessions");

  if (!modal) return;

  // Setup settings tabs
  const tabBtns =
    modal.querySelectorAll<HTMLButtonElement>(".settings-tab-btn");
  const tabPanels = modal.querySelectorAll<HTMLElement>(
    ".settings-tab-content",
  );

  function switchSettingsTab(tabName: string) {
    tabBtns.forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.tab === tabName),
    );
    tabPanels.forEach((panel) =>
      panel.classList.toggle("active", panel.dataset.tab === tabName),
    );
    localStorage.setItem("vibecraft-settings-tab", tabName);
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) switchSettingsTab(tab);
    });
  });

  // Setup keybind settings UI
  setupKeybindSettings();
  updateVoiceHint();

  // Initialize draw mode UI
  drawMode.init();

  // Wire up draw mode clear callback
  drawMode.onClear(() => {
    state.scene?.clearAllPaintedHexes();
    // Clear from localStorage too
    localStorage.removeItem("vibecraft-hexart");
    localStorage.removeItem("vibecraft-zone-elevations");
    console.log("Cleared hex art and zone elevations from localStorage");
  });

  // Port input
  const portInput = document.getElementById(
    "settings-port",
  ) as HTMLInputElement | null;
  const portStatus = document.getElementById("settings-port-status");

  // Load saved volume from localStorage
  const savedVolume = localStorage.getItem("vibecraft-volume");
  if (savedVolume !== null) {
    const vol = parseInt(savedVolume, 10) / 100;
    soundManager.setVolume(vol);
    if (volumeSlider) volumeSlider.value = savedVolume;
    if (volumeValue) volumeValue.textContent = `${savedVolume}%`;
  }

  // Load saved grid size from localStorage
  const savedGridSize = localStorage.getItem("vibecraft-grid-size");
  if (savedGridSize !== null) {
    const size = parseInt(savedGridSize, 10);
    state.scene?.setGridRange(size);
    if (gridSizeSlider) gridSizeSlider.value = savedGridSize;
    if (gridSizeValue) gridSizeValue.textContent = savedGridSize;
  }

  // Load saved spatial audio setting from localStorage
  const savedSpatial = localStorage.getItem("vibecraft-spatial-audio");
  if (savedSpatial !== null) {
    const enabled = savedSpatial === "true";
    soundManager.setSpatialEnabled(enabled);
    if (spatialCheckbox) spatialCheckbox.checked = enabled;
  }

  // Load saved streaming mode setting from localStorage
  const savedStreaming = localStorage.getItem("vibecraft-streaming-mode");
  if (savedStreaming !== null) {
    const enabled = savedStreaming === "true";
    if (streamingCheckbox) streamingCheckbox.checked = enabled;
    applyStreamingMode(enabled);
  }

  // Apply streaming mode (hide/show username)
  function applyStreamingMode(enabled: boolean) {
    const usernameEl = document.getElementById("username");
    if (usernameEl) {
      if (enabled) {
        usernameEl.dataset.realName = usernameEl.textContent || "";
        usernameEl.textContent = "...";
      } else {
        usernameEl.textContent =
          usernameEl.dataset.realName || usernameEl.textContent;
      }
    }
  }

  // Open modal
  settingsBtn?.addEventListener("click", () => {
    // Sync slider/checkbox states with current settings
    if (volumeSlider) {
      const currentVol = Math.round(soundManager.getVolume() * 100);
      volumeSlider.value = String(currentVol);
      if (volumeValue) volumeValue.textContent = `${currentVol}%`;
    }
    // Sync grid size slider
    if (gridSizeSlider && state.scene) {
      const currentSize = state.scene.getGridRange();
      gridSizeSlider.value = String(currentSize);
      if (gridSizeValue) gridSizeValue.textContent = String(currentSize);
    }
    // Sync spatial audio checkbox
    if (spatialCheckbox) {
      spatialCheckbox.checked = soundManager.isSpatialEnabled();
    }
    // Sync streaming mode checkbox
    if (streamingCheckbox) {
      streamingCheckbox.checked =
        localStorage.getItem("vibecraft-streaming-mode") === "true";
    }
    // Sync port input
    if (portInput) portInput.value = String(AGENT_PORT);
    // Update port status
    if (portStatus) {
      const connected = state.client?.isConnected ?? false;
      portStatus.textContent = connected ? "● Connected" : "○ Disconnected";
      portStatus.className = `port-status ${connected ? "connected" : "disconnected"}`;
    }
    // Render LLM providers and notification channels
    renderSettingsCards();

    // Restore last active tab
    const savedTab =
      localStorage.getItem("vibecraft-settings-tab") || "general";
    switchSettingsTab(savedTab);

    modal.classList.add("visible");
    if (state.soundEnabled) soundManager.play("modal_open");
  });

  // Close modal
  const closeModal = () => {
    if (state.soundEnabled) soundManager.play("modal_cancel");
    modal.classList.remove("visible");
  };
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Volume slider - plays pitch-modulated tick on every change
  volumeSlider?.addEventListener("input", () => {
    const vol = parseInt(volumeSlider.value, 10);
    soundManager.setVolume(vol / 100);
    if (volumeValue) volumeValue.textContent = `${vol}%`;
    localStorage.setItem("vibecraft-volume", String(vol));
    // Play tick with pitch based on slider position
    if (state.soundEnabled) {
      soundManager.playSliderTick(vol / 100);
    }
  });

  // Grid size slider - rebuilds hex grid on change
  gridSizeSlider?.addEventListener("input", () => {
    const size = parseInt(gridSizeSlider.value, 10);
    if (gridSizeValue) gridSizeValue.textContent = String(size);
    state.scene?.setGridRange(size);
    localStorage.setItem("vibecraft-grid-size", String(size));
    // Play tick with pitch based on slider position (normalized 5-80 to 0-1)
    if (state.soundEnabled) {
      soundManager.playSliderTick((size - 5) / 75);
    }
  });

  // Spatial audio checkbox
  spatialCheckbox?.addEventListener("change", () => {
    const enabled = spatialCheckbox.checked;
    soundManager.setSpatialEnabled(enabled);
    localStorage.setItem("vibecraft-spatial-audio", String(enabled));
  });

  // Streaming mode checkbox
  streamingCheckbox?.addEventListener("change", () => {
    const enabled = streamingCheckbox.checked;
    localStorage.setItem("vibecraft-streaming-mode", String(enabled));
    applyStreamingMode(enabled);
  });

  // Port change - save to localStorage and prompt refresh
  portInput?.addEventListener("change", () => {
    const newPort = parseInt(portInput.value, 10);
    if (newPort && newPort > 0 && newPort <= 65535 && newPort !== AGENT_PORT) {
      localStorage.setItem("vibecraft-agent-port", String(newPort));
      if (
        confirm(
          `Port changed to ${newPort}. Reload page to connect to new port?`,
        )
      ) {
        window.location.reload();
      }
    }
  });

  // Language switcher buttons
  const langBtns = modal.querySelectorAll<HTMLButtonElement>(".lang-btn");
  function updateLangBtnState() {
    const current = getLocale();
    langBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === current);
    });
  }
  updateLangBtnState();
  langBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.lang as Locale;
      if (lang && lang !== getLocale()) {
        setLocale(lang);
        updateLangBtnState();
      }
    });
  });

  // Refresh sessions button
  refreshBtn?.addEventListener("click", async () => {
    await sessionAPI.refreshSessions();
    closeModal();
  });

  // Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("visible")) {
      closeModal();
    }
  });

  // ---- LLM Providers & Notification Channels ----

  const llmList = document.getElementById("settings-llm-list");
  const notifList = document.getElementById("settings-notification-list");
  const addProviderBtn = document.getElementById("settings-add-provider");
  const addChannelBtn = document.getElementById("settings-add-channel");

  function escHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getProviderIcon(provider: string): string {
    const icons: Record<string, string> = {
      anthropic: "🅰️",
      openai: "🤖",
      google: "🔷",
      openrouter: "🔀",
      deepseek: "🌊",
      ollama: "🦙",
    };
    return icons[provider.toLowerCase()] || "⚙️";
  }

  function getPlatformIcon(platform: string): string {
    const icons: Record<string, string> = {
      feishu: "🪶",
      dingtalk: "🔔",
      telegram: "✈️",
      slack: "💬",
    };
    return icons[platform.toLowerCase()] || "📢";
  }

  async function renderSettingsCards(): Promise<void> {
    if (!llmList || !notifList) return;
    try {
      const resp = await sessionAPI.getSettings();
      if (!resp.ok) return;
      const { settings } = resp;

      // LLM Providers
      const providers = settings.llmProviders || {};
      const providerNames = Object.keys(providers);
      if (providerNames.length === 0) {
        llmList.innerHTML = `<div class="settings-empty">${escHtml(t("settings.providerNone"))}</div>`;
      } else {
        llmList.innerHTML = providerNames
          .map((name) => {
            const p = providers[name];
            return `<div class="settings-card" data-name="${escHtml(name)}">
            <span class="settings-card-icon">${getProviderIcon(p.provider)}</span>
            <div class="settings-card-info">
              <span class="settings-card-name">${escHtml(name)}</span>
              <span class="settings-card-detail">${escHtml(p.provider)}${p.model ? " · " + escHtml(p.model) : ""}</span>
            </div>
            ${p.hasApiKey ? `<span class="settings-card-status">✓ ${escHtml(t("settings.providerConfigured"))}</span>` : ""}
            <div class="settings-card-actions">
              <button class="settings-card-btn delete-provider" data-name="${escHtml(name)}" title="${escHtml(t("common.delete"))}">✕</button>
            </div>
          </div>`;
          })
          .join("");
      }

      // Notification Channels
      const channels = settings.notificationChannels || {};
      const channelNames = Object.keys(channels);
      if (channelNames.length === 0) {
        notifList.innerHTML = `<div class="settings-empty">${escHtml(t("settings.channelNone"))}</div>`;
      } else {
        notifList.innerHTML = channelNames
          .map((name) => {
            const ch = channels[name];
            return `<div class="settings-card" data-name="${escHtml(name)}">
            <span class="settings-card-icon">${getPlatformIcon(ch.platform)}</span>
            <div class="settings-card-info">
              <span class="settings-card-name">${escHtml(name)}</span>
              <span class="settings-card-detail">${escHtml(ch.platform)}${ch.enabled ? "" : " (disabled)"}</span>
            </div>
            <div class="settings-card-actions">
              <button class="settings-card-btn test-channel" data-name="${escHtml(name)}" title="${escHtml(t("settings.channelTest"))}">🔔</button>
              <button class="settings-card-btn delete-channel" data-name="${escHtml(name)}" title="${escHtml(t("common.delete"))}">✕</button>
            </div>
          </div>`;
          })
          .join("");
      }

      // Attach delete provider handlers
      llmList
        .querySelectorAll<HTMLButtonElement>(".delete-provider")
        .forEach((btn) => {
          btn.addEventListener("click", async () => {
            const name = btn.dataset.name;
            if (!name) return;
            await sessionAPI.deleteLLMProvider(name);
            renderSettingsCards();
          });
        });

      // Attach delete channel handlers
      notifList
        .querySelectorAll<HTMLButtonElement>(".delete-channel")
        .forEach((btn) => {
          btn.addEventListener("click", async () => {
            const name = btn.dataset.name;
            if (!name) return;
            await sessionAPI.deleteNotificationChannel(name);
            renderSettingsCards();
          });
        });

      // Attach test channel handlers
      notifList
        .querySelectorAll<HTMLButtonElement>(".test-channel")
        .forEach((btn) => {
          btn.addEventListener("click", async () => {
            const name = btn.dataset.name;
            if (!name) return;
            btn.disabled = true;
            btn.textContent = "…";
            try {
              const result = await sessionAPI.testNotification(name);
              btn.textContent = result.ok ? "✓" : "✗";
            } catch {
              btn.textContent = "✗";
            }
            setTimeout(() => {
              btn.textContent = "🔔";
              btn.disabled = false;
            }, 2000);
          });
        });
    } catch (err) {
      console.warn("Failed to load settings:", err);
    }
  }

  // "Add Provider" inline form
  addProviderBtn?.addEventListener("click", () => {
    if (!llmList) return;
    // Remove existing form if any
    llmList.querySelector(".settings-inline-form")?.remove();
    const form = document.createElement("div");
    form.className = "settings-inline-form";
    form.innerHTML = `
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.providerName"))}" class="llm-name" />
        <select class="llm-type">
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="google">Google</option>
          <option value="deepseek">DeepSeek</option>
          <option value="ollama">Ollama</option>
        </select>
      </div>
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.providerModel"))}" class="llm-model" />
        <input type="password" placeholder="${escHtml(t("settings.providerApiKey"))}" class="llm-apikey" />
      </div>
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.providerBaseUrl"))}" class="llm-baseurl" />
      </div>
      <div class="form-actions">
        <button class="btn-save">${escHtml(t("common.save"))}</button>
        <button class="btn-cancel">${escHtml(t("common.cancel"))}</button>
      </div>`;
    llmList.appendChild(form);
    (form.querySelector(".llm-name") as HTMLInputElement)?.focus();

    form
      .querySelector(".btn-cancel")
      ?.addEventListener("click", () => form.remove());
    form.querySelector(".btn-save")?.addEventListener("click", async () => {
      const name = (
        form.querySelector(".llm-name") as HTMLInputElement
      ).value.trim();
      const provider = (form.querySelector(".llm-type") as HTMLSelectElement)
        .value;
      const model = (
        form.querySelector(".llm-model") as HTMLInputElement
      ).value.trim();
      const apiKey = (
        form.querySelector(".llm-apikey") as HTMLInputElement
      ).value.trim();
      const baseUrl = (
        form.querySelector(".llm-baseurl") as HTMLInputElement
      ).value.trim();
      if (!name) return;
      await sessionAPI.updateSettings({
        llmProviders: {
          [name]: {
            provider,
            model: model || undefined,
            apiKey: apiKey || undefined,
            baseUrl: baseUrl || undefined,
          },
        },
      });
      form.remove();
      renderSettingsCards();
    });
  });

  // "Add Channel" inline form
  addChannelBtn?.addEventListener("click", () => {
    if (!notifList) return;
    notifList.querySelector(".settings-inline-form")?.remove();
    const form = document.createElement("div");
    form.className = "settings-inline-form";
    form.innerHTML = `
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.providerName"))}" class="ch-name" />
        <select class="ch-platform">
          <option value="feishu">Feishu</option>
          <option value="dingtalk">DingTalk</option>
          <option value="telegram">Telegram</option>
          <option value="slack">Slack</option>
        </select>
      </div>
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.channelWebhookUrl"))}" class="ch-webhook" />
      </div>
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.channelBotToken"))}" class="ch-token" />
        <input type="text" placeholder="${escHtml(t("settings.channelChatId"))}" class="ch-chatid" />
      </div>
      <div class="form-row">
        <input type="text" placeholder="${escHtml(t("settings.channelSecret"))}" class="ch-secret" />
      </div>
      <div class="form-actions">
        <button class="btn-save">${escHtml(t("common.save"))}</button>
        <button class="btn-cancel">${escHtml(t("common.cancel"))}</button>
      </div>`;
    notifList.appendChild(form);
    (form.querySelector(".ch-name") as HTMLInputElement)?.focus();

    form
      .querySelector(".btn-cancel")
      ?.addEventListener("click", () => form.remove());
    form.querySelector(".btn-save")?.addEventListener("click", async () => {
      const name = (
        form.querySelector(".ch-name") as HTMLInputElement
      ).value.trim();
      const platform = (form.querySelector(".ch-platform") as HTMLSelectElement)
        .value as "feishu" | "dingtalk" | "telegram" | "slack";
      const webhookUrl = (
        form.querySelector(".ch-webhook") as HTMLInputElement
      ).value.trim();
      const botToken = (
        form.querySelector(".ch-token") as HTMLInputElement
      ).value.trim();
      const chatId = (
        form.querySelector(".ch-chatid") as HTMLInputElement
      ).value.trim();
      const secret = (
        form.querySelector(".ch-secret") as HTMLInputElement
      ).value.trim();
      if (!name) return;
      const config: Record<string, string> = {};
      if (webhookUrl) config.webhookUrl = webhookUrl;
      if (botToken) config.botToken = botToken;
      if (chatId) config.chatId = chatId;
      if (secret) config.secret = secret;
      await sessionAPI.updateSettings({
        notificationChannels: {
          [name]: { platform, enabled: true, config },
        },
      });
      form.remove();
      renderSettingsCards();
    });
  });
}

// Question Modal and Permission Modal moved to src/ui/QuestionModal.ts and src/ui/PermissionModal.ts

// ============================================================================
// About Modal
// ============================================================================

function setupAboutModal(): void {
  const aboutBtn = document.getElementById("about-btn");
  const modal = document.getElementById("about-modal");
  const closeBtn = document.getElementById("about-close");

  if (!modal) return;

  // Open modal
  aboutBtn?.addEventListener("click", () => {
    // Fetch and display version
    const versionEl = document.getElementById("about-version");
    if (versionEl) {
      fetch("/health")
        .then((res) => res.json())
        .then((health) => {
          versionEl.textContent = `v${health.version || "unknown"}`;
        })
        .catch(() => {
          versionEl.textContent = "v?";
        });
    }
    modal.classList.add("visible");
    if (state.soundEnabled) soundManager.play("modal_open");
  });

  // Close modal
  const closeModal = () => {
    if (state.soundEnabled) soundManager.play("modal_cancel");
    modal.classList.remove("visible");
  };
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
}

// ============================================================================
// Connection Overlay
// ============================================================================

function setupNotConnectedOverlay(): void {
  const overlay = document.getElementById("not-connected-overlay");
  const retryBtn = document.getElementById("retry-connection");
  const exploreBtn = document.getElementById("explore-offline");
  const offlineBanner = document.getElementById("offline-banner");
  const bannerDismiss = document.getElementById("offline-banner-dismiss");

  if (!overlay) return;

  retryBtn?.addEventListener("click", () => {
    window.location.reload();
  });

  // Explore button: dismiss overlay, show offline banner
  exploreBtn?.addEventListener("click", () => {
    overlay.classList.remove("visible");
    offlineBanner?.classList.remove("hidden");
  });

  // Dismiss offline banner
  bannerDismiss?.addEventListener("click", () => {
    offlineBanner?.classList.add("hidden");
  });
}

function showOfflineBanner(): void {
  const banner = document.getElementById("offline-banner");
  banner?.classList.remove("hidden");
}

function setupZoneTimeoutModal(): void {
  const modal = document.getElementById("zone-timeout-modal");
  const closeBtn = document.getElementById("zone-timeout-close");

  if (!modal) return;

  closeBtn?.addEventListener("click", () => {
    modal.classList.remove("visible");
  });

  // Close on clicking backdrop
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("visible");
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("visible")) {
      modal.classList.remove("visible");
    }
  });
}

function showZoneTimeoutModal(): void {
  const modal = document.getElementById("zone-timeout-modal");
  modal?.classList.add("visible");
}

function showNotConnectedOverlay(): void {
  const overlay = document.getElementById("not-connected-overlay");
  overlay?.classList.add("visible");
}

function hideNotConnectedOverlay(): void {
  const overlay = document.getElementById("not-connected-overlay");
  overlay?.classList.remove("visible");
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
  // Initialize i18n before any UI rendering
  initI18n();

  const container = document.getElementById("canvas-container");
  if (!container) {
    console.error("Canvas container not found");
    return;
  }

  // Create scene (zones and Claudes created dynamically per session)
  state.scene = new WorkshopScene(container);

  // Set up spatial audio resolvers
  soundManager.setZonePositionResolver((zoneId: string) => {
    return state.scene?.getZoneWorldPosition(zoneId) ?? null;
  });
  soundManager.setFocusedZoneResolver(() => {
    return state.scene?.focusedZoneId ?? null;
  });

  // Update spatial audio listener position periodically (every 100ms)
  setInterval(() => {
    if (state.scene) {
      const camera = state.scene.camera;
      soundManager.updateListener(
        camera.position.x,
        camera.position.z,
        camera.rotation.y,
      );
    }
  }, 100);

  // Load saved hex art from localStorage
  const savedHexArt = localStorage.getItem("vibecraft-hexart");
  if (savedHexArt) {
    try {
      const hexes = JSON.parse(savedHexArt);
      state.scene.loadPaintedHexes(hexes);
      console.log(`Loaded ${hexes.length} painted hexes from localStorage`);
    } catch (e) {
      console.warn("Failed to load hex art from localStorage:", e);
    }
  }

  // Load saved zone elevations from localStorage
  const savedZoneElevations = localStorage.getItem("vibecraft-zone-elevations");
  if (savedZoneElevations) {
    try {
      const elevations = JSON.parse(savedZoneElevations);
      state.scene.loadZoneElevations(elevations);
      console.log(
        `Loaded ${Object.keys(elevations).length} zone elevations from localStorage`,
      );
    } catch (e) {
      console.warn("Failed to load zone elevations from localStorage:", e);
    }
  }

  // Make canvas focusable for Tab switching
  state.scene.renderer.domElement.tabIndex = 0;
  state.scene.renderer.domElement.style.outline = "none";

  // Start rendering
  state.scene.start();

  // Initialize attention system
  state.attentionSystem = new AttentionSystem({
    onQueueChange: () => renderManagedSessions(),
  });

  // Initialize timeline manager
  state.timelineManager = new TimelineManager();

  // Initialize feed manager
  state.feedManager = new FeedManager();
  state.feedManager.setupScrollButton();

  // Register EventBus handlers (decoupled event handling)
  registerAllHandlers();

  // Connect to event server
  state.client = new EventClient({
    url: WS_URL,
    debug: true,
  });

  // Track if we've ever connected
  let hasConnected = false;

  state.client.onConnection((connected) => {
    updateStatus(connected, connected ? "Connected" : "Disconnected");
    console.log("Connection status:", connected);

    if (connected) {
      hasConnected = true;
      hideNotConnectedOverlay();
    }
  });

  // Show not-connected overlay after timeout if never connected (production only)
  if (!import.meta.env.DEV) {
    setTimeout(() => {
      if (!hasConnected) {
        console.log("Connection timeout - showing overlay");
        showNotConnectedOverlay();
      }
    }, 3000); // 3 seconds to connect before showing overlay
  }

  state.client.onEvent(handleEvent);

  // Handle history batch - pre-scan for completions before rendering
  state.client.onHistory((events) => {
    // First pass: collect all completed tool use IDs (across all sessions)
    for (const event of events) {
      if (event.type === "post_tool_use") {
        const e = event as PostToolUseEvent;
        state.timelineManager?.markCompleted(e.toolUseId);
      }
    }
    // Second pass: process all events (sessions created dynamically)
    for (const event of events) {
      handleEvent(event);
    }
  });

  // Handle token updates
  state.client.onTokens((data) => {
    // Update feed panel stat
    const tokensEl = document.getElementById("stat-tokens");
    if (tokensEl) {
      tokensEl.textContent = data.cumulative.toLocaleString();
    }
    // Update top-left HUD with formatted display
    const tokenCounter = document.getElementById("token-counter");
    if (tokenCounter) {
      tokenCounter.textContent = `⚡ ${formatTokens(data.cumulative)}`;
      tokenCounter.title = `${data.cumulative.toLocaleString()} tokens used`;
    }
  });

  // Handle managed sessions updates
  state.client.onSessions((sessions) => {
    // Dedup: skip processing if nothing meaningful changed
    const snapshot = sessions
      .map(
        (s) =>
          `${s.id}:${s.claudeSessionId ?? ""}:${s.status}:${s.name}:${s.currentTool ?? ""}:${s.mode ?? ""}:${s.groupId ?? ""}`,
      )
      .join("|");
    const isIdentical = snapshot === _lastSessionsSnapshot;
    _lastSessionsSnapshot = snapshot;

    // Reconcile local link map with server's authoritative data
    // Server is the source of truth for session linking
    claudeToManagedLink.clear();
    for (const session of sessions) {
      // Determine the zone ID for this session
      const zoneId = session.claudeSessionId || `managed:${session.id}`;

      if (session.claudeSessionId) {
        claudeToManagedLink.set(session.claudeSessionId, session.id);

        // Re-key synthetic zone → real zone when claudeSessionId arrives
        const syntheticId = managedToSyntheticZone.get(session.id);
        if (syntheticId && state.scene) {
          const existingZone = state.scene.zones.get(syntheticId);
          const existingSession = state.sessions.get(syntheticId);
          if (existingZone) {
            // Move zone to real ID
            state.scene.zones.delete(syntheticId);
            state.scene.zones.set(session.claudeSessionId, existingZone);
          }
          if (existingSession) {
            state.sessions.delete(syntheticId);
            state.sessions.set(session.claudeSessionId, existingSession);
          }
          managedToSyntheticZone.delete(session.id);
          console.log(
            `Re-keyed zone "${session.name}" from synthetic to ${session.claudeSessionId.slice(0, 8)}`,
          );
        }
      }

      // Proactively create zone if it doesn't exist yet
      if (state.scene && !state.scene.zones.has(zoneId)) {
        // For sessions without claudeSessionId, track the synthetic zone
        if (!session.claudeSessionId) {
          managedToSyntheticZone.set(session.id, zoneId);
        }

        // Use saved position if available, then check pending hints from click-to-create
        let hintPosition: { x: number; z: number } | undefined;
        if (session.zonePosition) {
          const cartesian = state.scene.hexGrid.axialToCartesian(
            session.zonePosition,
          );
          hintPosition = { x: cartesian.x, z: cartesian.z };
          console.log(
            `Restoring zone for "${session.name}" at saved position`,
            session.zonePosition,
          );
        } else if (pendingZoneHints.has(session.name)) {
          hintPosition = pendingZoneHints.get(session.name);
          pendingZoneHints.delete(session.name);
          console.log(
            `Creating zone for "${session.name}" at clicked position`,
            hintPosition,
          );
        } else {
          console.log(`Creating zone for session "${session.name}"`);
        }
        const zone = state.scene.createZone(zoneId, {
          hintPosition,
        });

        // Clean up pending zone if this session had one
        const pendingZoneId = pendingZonesToCleanup.get(session.name);
        if (pendingZoneId) {
          state.scene.removePendingZone(pendingZoneId);
          pendingZonesToCleanup.delete(session.name);
          const timeoutId = pendingZoneTimeouts.get(pendingZoneId);
          if (timeoutId) {
            clearTimeout(timeoutId);
            pendingZoneTimeouts.delete(pendingZoneId);
          }
        }

        // Play zone creation sound
        if (state.soundEnabled) {
          soundManager.play("zone_create", { zoneId });
        }

        // Create Claude entity for this zone
        const claude = new Claude(state.scene, {
          color: zone.color,
          startStation: "center",
        });
        const centerStation = zone.stations.get("center");
        if (centerStation) {
          claude.mesh.position.copy(centerStation.position);
        }

        const subagents = new SubagentManager(state.scene);

        const sessionState: SessionState = {
          claude,
          subagents,
          zone,
          color: zone.color,
          stats: {
            toolsUsed: 0,
            filesTouched: new Set(),
            activeSubagents: 0,
          },
        };
        state.sessions.set(zoneId, sessionState);

        // Update zone label with session name
        const keybindIndex = sessions.indexOf(session);
        const keybind =
          keybindIndex >= 0 ? getSessionKeybind(keybindIndex) : undefined;
        state.scene.updateZoneLabel(zoneId, session.name, keybind);
      }

      // Update zone floor status based on session status
      if (state.scene) {
        const effectiveZoneId =
          session.claudeSessionId || managedToSyntheticZone.get(session.id);
        if (effectiveZoneId) {
          const zoneStatus =
            session.status === "working"
              ? "working"
              : session.status === "waiting"
                ? "waiting"
                : session.status === "offline"
                  ? "offline"
                  : "idle";
          state.scene.setZoneStatus(effectiveZoneId, zoneStatus);
        }
      }
    }

    // Clean up orphaned zones (zones whose managed session has been deleted).
    // Only delete zones when no managed session references that claudeSessionId or synthetic ID.
    if (state.scene && !isIdentical) {
      const activeClaudeIds = new Set(
        sessions.map((s) => s.claudeSessionId).filter(Boolean),
      );
      const activeSyntheticIds = new Set(managedToSyntheticZone.values());
      const managedSessionIds = new Set(sessions.map((s) => s.id));
      const zonesToDelete: string[] = [];
      for (const [zoneId] of state.scene.zones) {
        if (activeClaudeIds.has(zoneId)) continue; // Zone is actively linked
        if (activeSyntheticIds.has(zoneId)) continue; // Synthetic zone still active

        // Check if a managed session still owns this zone via the link map
        const managedId = claudeToManagedLink.get(zoneId);
        if (managedId && managedSessionIds.has(managedId)) continue; // Session still exists

        // This zone is truly orphaned (no managed session references it)
        zonesToDelete.push(zoneId);
      }
      for (const zoneId of zonesToDelete) {
        // Clean up session state (Claude entity, subagents)
        const sessionState = state.sessions.get(zoneId);
        if (sessionState) {
          sessionState.claude.dispose();
          state.sessions.delete(zoneId);
        }
        // Play zone deletion sound BEFORE deleting (so position is still available)
        if (state.soundEnabled) {
          soundManager.play("zone_delete", { zoneId });
        }

        // Delete the 3D zone
        state.scene.deleteZone(zoneId);

        console.log(`Cleaned up orphaned zone: ${zoneId.slice(0, 8)}`);
      }
    }

    // Detect status changes (working → idle) and notify
    if (state.attentionSystem) {
      const newlyIdle = state.attentionSystem.processStatusChanges(sessions);

      // Auto-focus first newly idle session if user hasn't overridden camera
      if (newlyIdle.length > 0 && !state.userChangedCamera) {
        const workingSessions = sessions.filter((s) => s.status === "working");
        if (workingSessions.length === 0) {
          const session = newlyIdle[0];
          if (session.claudeSessionId && state.scene) {
            state.scene.focusZone(session.claudeSessionId);
            selectManagedSession(session.id);
          }
        }
      }
    }

    state.managedSessions = sessions;
    if (!isIdentical) {
      renderManagedSessions();
    }

    // Re-apply feed filter if the selected session's claudeSessionId changed
    // This handles the case where linking happens after the user selected a session,
    // AND the case where claudeSessionId becomes undefined after a restart
    if (state.selectedManagedSession) {
      const selected = sessions.find(
        (s) => s.id === state.selectedManagedSession,
      );
      if (selected) {
        const targetFilter = selected.claudeSessionId ?? "__none__";
        const currentFilter = state.feedManager?.getFilter();
        if (currentFilter !== targetFilter) {
          state.feedManager?.setFilter(targetFilter);
        }
      }
    }

    // Update mode selector if currently focused session changed mode
    if (state.focusedSessionId) {
      updateModeSelector(state.focusedSessionId);
    }

    // Sync zone labels with managed session names
    syncZoneLabels();

    // Update git status displays on zones
    if (state.scene) {
      for (const session of sessions) {
        if (session.claudeSessionId && session.gitStatus) {
          state.scene.updateZoneGitStatus(
            session.claudeSessionId,
            session.gitStatus,
          );
        }
      }
    }

    // Restore or auto-select session
    if (!state.selectedManagedSession && sessions.length > 0) {
      // Try to restore from localStorage
      const savedSessionId = localStorage.getItem("vibecraft-selected-session");
      const savedSession = savedSessionId
        ? sessions.find((s) => s.id === savedSessionId)
        : null;

      if (savedSession) {
        selectManagedSession(savedSession.id);
      } else {
        // Fall back to first session
        selectManagedSession(sessions[0].id);
      }
    }

    // Auto-overview once when first reaching 2+ sessions (but respect user's manual changes)
    if (
      sessions.length >= 2 &&
      state.scene &&
      !state.hasAutoOverviewed &&
      !state.userChangedCamera
    ) {
      state.hasAutoOverviewed = true;
      state.scene.setOverviewMode();
    }
  });

  // Handle permission prompts and text tiles
  state.client.onRawMessage((message) => {
    if (message.type === "permission_prompt") {
      const { sessionId, tool, context, options } = message.payload as {
        sessionId: string;
        tool: string;
        context: string;
        options: Array<{ number: string; label: string }>;
      };
      showPermissionModal(sessionId, tool, context, options);
    } else if (message.type === "permission_resolved") {
      hidePermissionModal();
    } else if (message.type === "text_tiles") {
      // Update text tiles in scene
      const tiles = message.payload as import("../shared/types").TextTile[];
      if (state.scene) {
        state.scene.setTextTiles(tiles);
      }
    } else if (message.type === "zone_groups") {
      // Update group connection lines in scene
      const groups = message.payload as import("../shared/types").ZoneGroup[];
      state.zoneGroups = groups;
      if (state.scene) {
        state.scene.updateGroupLinks(groups, state.managedSessions);
      }
    }
  });

  state.client.connect();

  // Setup prompt form and mode selector
  setupPromptForm();
  setupModeSelector();

  // Setup terminal toggle
  setupTerminalToggle();

  // Setup managed sessions (orchestration)
  setupManagedSessions();

  // Fetch server info (cwd, etc.)
  fetchServerInfo();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts({
    getScene: () => state.scene,
    getManagedSessions: () => state.managedSessions,
    getFocusedSessionId: () => state.focusedSessionId,
    getSelectedManagedSession: () =>
      state.selectedManagedSession
        ? (state.managedSessions.find(
            (s) => s.id === state.selectedManagedSession,
          ) ?? null)
        : null,
    onSelectManagedSession: selectManagedSession,
    onFocusSession: focusSession,
    onGoToNextAttention: goToNextAttention,
    onUpdateAttentionBadge: updateAttentionBadge,
    onSetUserChangedCamera: (value) => {
      state.userChangedCamera = value;
    },
    onInterruptSession: interruptSession,
  });

  // Setup click-to-prompt and context menu
  setupContextMenu();
  setupClickToPrompt();

  // Register camera mode change callback
  state.scene.onCameraMode(updateKeybindHelper);

  // Register zone elevation change callback (to move Claude with zone)
  state.scene.onZoneElevation((sessionId, elevation) => {
    const session = state.sessions.get(sessionId);
    if (session) {
      // Update Claude's Y position to match zone elevation
      // The base station Y is 0.3 (from createZoneStations), so add that offset
      const stationYOffset = 0.3;
      session.claude.mesh.position.y = elevation + stationYOffset;
    }
  });

  // Register zone move callback (to move Claude + subagents with zone)
  state.scene.onZoneMove((sessionId, delta) => {
    const session = state.sessions.get(sessionId);
    if (session) {
      session.claude.mesh.position.add(delta);
      session.claude.shiftTargetPosition(delta);
      for (const subagent of session.subagents.getAll()) {
        subagent.claude.mesh.position.add(delta);
        subagent.claude.shiftTargetPosition(delta);
      }
    }
  });

  // Fetch config (username, etc.)
  fetchConfig();

  // Setup settings modal
  setupSettingsModal();

  // Setup about modal
  setupAboutModal();

  // Setup dev panel (animation testing, Alt+D to toggle)
  setupDevPanel();

  // Setup question modal (for AskUserQuestion)
  setupQuestionModal({
    scene: state.scene,
    soundEnabled: state.soundEnabled,
    apiUrl: API_URL,
    attentionSystem: state.attentionSystem,
  });

  // Setup permission modal (for tool permissions)
  setupPermissionModal({
    scene: state.scene,
    soundEnabled: state.soundEnabled,
    apiUrl: API_URL,
    attentionSystem: state.attentionSystem,
    getManagedSessions: () => state.managedSessions,
  });

  // Setup zone info modal (for session details)
  setupZoneInfoModal({
    soundEnabled: state.soundEnabled,
  });

  // Setup text label modal (for hex text labels)
  setupTextLabelModal();

  // Setup zone command modal (quick command input near zone)
  setupZoneCommandModal();

  // Setup zone timeout modal (shown when zone creation takes too long)
  setupZoneTimeoutModal();

  // Setup not-connected overlay
  setupNotConnectedOverlay();

  // Setup voice input (uses browser SpeechRecognition — no server needed)
  const voiceMicBtn = document.getElementById("voice-mode-btn");
  const hasSpeechRecognition = !!(
    window.SpeechRecognition || window.webkitSpeechRecognition
  );

  if (hasSpeechRecognition) {
    state.voice = setupVoiceControl({
      soundEnabled: () => state.soundEnabled,
    });
  } else if (voiceMicBtn) {
    voiceMicBtn.classList.add("not-supported");
    voiceMicBtn.title = t("voice.notSupported");
  }

  // Initialize audio on first user interaction
  const initAudioOnce = () => {
    initAudioOnInteraction();
    document.removeEventListener("click", initAudioOnce);
    document.removeEventListener("keydown", initAudioOnce);
  };
  document.addEventListener("click", initAudioOnce);
  document.addEventListener("keydown", initAudioOnce);

  // Initial UI state
  updateStatus(false, "Connecting...");
  updateActivity("Waiting for connection...");
  updateStats();

  // Check for updates (non-blocking)
  checkForUpdates();

  // Expose demo orchestrator for console access (demo video)
  const demo = new DemoOrchestrator({
    scene: state.scene,
  });
  (window as any).demo = demo;

  console.log("Vibecraft initialized (multi-session enabled)");
  console.log(
    "Demo: window.demo.setupOffice() → window.demo.runDemoSequence()",
  );
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  state.client?.disconnect();
  // Dispose all sessions
  for (const session of state.sessions.values()) {
    session.claude.dispose();
  }
  state.sessions.clear();
  state.scene?.dispose();
}

// ============================================================================
// Start
// ============================================================================

window.addEventListener("load", init);
window.addEventListener("beforeunload", cleanup);

// Export for debugging
(window as unknown as { vibecraft: AppState }).vibecraft = state;
