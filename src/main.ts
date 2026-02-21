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
  type ClaudeEvent,
  type ClaudeMode,
  type PreToolUseEvent,
  type PostToolUseEvent,
  type ManagedSession,
} from "../shared/types";
import { soundManager } from "./audio";

// Expose for console testing (can remove in production)
(window as any).soundManager = soundManager;
import { setupVoiceControl, type VoiceState } from "./ui/VoiceControl";
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
import { IMChannel } from "./ui/IMChannel";
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
import { setupSlashCommands, isSlashCommand } from "./ui/SlashCommands";
import { setupDirectoryAutocomplete } from "./ui/DirectoryAutocomplete";
import { checkForUpdates } from "./ui/VersionChecker";
import { drawMode } from "./ui/DrawMode";
import { setupTextLabelModal, showTextLabelModal } from "./ui/TextLabelModal";
import { createSessionAPI, type SessionAPI } from "./api";

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
  imChannel: IMChannel | null; // IM channel for team chat
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
  imChannel: null, // Initialized in init()
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
const ZONE_CREATION_TIMEOUT = 10000;

// ============================================================================
// Managed Sessions (Orchestration)
// ============================================================================

/**
 * Render the managed sessions list
 */
function renderManagedSessions(): void {
  const container = document.getElementById("managed-sessions");
  if (!container) return;

  container.innerHTML = "";

  // Update "All Sessions" count
  const allCount = document.getElementById("all-sessions-count");
  if (allCount) {
    const count = state.managedSessions.length;
    const working = state.managedSessions.filter(
      (s) => s.status === "working",
    ).length;
    if (count === 0) {
      allCount.textContent = 'Click "+ New" to start';
    } else if (working > 0) {
      allCount.textContent = `${count} session${count > 1 ? "s" : ""}, ${working} working`;
      allCount.className = "session-detail working";
    } else {
      allCount.textContent = `${count} session${count > 1 ? "s" : ""}`;
      allCount.className = "session-detail";
    }
  }

  // Update "All Sessions" active state
  const allItem = document.querySelector(".session-item.all-sessions");
  if (allItem) {
    allItem.classList.toggle("active", state.selectedManagedSession === null);
  }

  state.managedSessions.forEach((session, index) => {
    const el = document.createElement("div");
    el.className = "session-item";
    if (session.id === state.selectedManagedSession) {
      el.classList.add("active");
    }

    // Check if session needs attention
    const needsAttention =
      state.attentionSystem?.needsAttention(session.id) ?? false;
    if (needsAttention) {
      el.classList.add("needs-attention");
    }

    const statusClass = session.status;
    const hotkey = index < 6 ? getSessionKeybind(index) : ""; // 1-6 shown in UI

    // Time since last activity (needed for detail line)
    const lastActive = session.lastActivity
      ? formatTimeAgo(session.lastActivity)
      : "";

    // Build detail line with status and project
    const projectName = session.cwd ? session.cwd.split("/").pop() : "";
    let detail = "";
    if (needsAttention) {
      detail = "⚡ Needs attention";
    } else if (session.status === "waiting") {
      detail = `⏳ Waiting for permission: ${session.currentTool || "Unknown"}`;
    } else if (session.currentTool) {
      detail = `Using ${session.currentTool}`;
    } else if (session.status === "offline") {
      detail = lastActive
        ? `Offline · was ${lastActive}`
        : "Offline - click 🔄 to restart";
    } else {
      detail = projectName ? `📁 ${projectName}` : "Ready";
    }
    const detailClass =
      session.status === "working"
        ? "session-detail working"
        : session.status === "waiting"
          ? "session-detail attention"
          : needsAttention
            ? "session-detail attention"
            : "session-detail";

    // Get last prompt for this session (via claudeSessionId)
    const lastPrompt = session.claudeSessionId
      ? state.lastPrompts.get(session.claudeSessionId)
      : null;
    const truncatedPrompt = lastPrompt
      ? lastPrompt.length > 35
        ? lastPrompt.slice(0, 32) + "..."
        : lastPrompt
      : null;

    // Build detailed tooltip
    const tooltipParts = [
      `Name: ${session.name}`,
      `Status: ${session.status}`,
      `tmux: ${session.tmuxSession}`,
      session.claudeSessionId
        ? `Claude ID: ${session.claudeSessionId.slice(0, 12)}...`
        : "Not linked yet",
      session.cwd ? `Dir: ${session.cwd}` : "",
      session.lastActivity
        ? `Last active: ${new Date(session.lastActivity).toLocaleString()}`
        : "",
      lastPrompt ? `Last prompt: ${lastPrompt}` : "",
    ].filter(Boolean);
    el.title = tooltipParts.join("\n");

    // Mode badge (only show if not default auto-edit)
    const modeBadge =
      session.mode && session.mode !== "auto-edit"
        ? `<span class="session-mode-badge mode-${session.mode}">${session.mode === "plan" ? "Plan" : "Ask"}</span>`
        : "";

    // Group badge
    const groupBadge = session.groupId
      ? '<span class="session-mode-badge mode-group">Grp</span>'
      : "";

    el.innerHTML = `
      ${hotkey ? `<div class="session-hotkey">${hotkey}</div>` : ""}
      <div class="session-status ${statusClass}"></div>
      <div class="session-info">
        <div class="session-name">${escapeHtml(session.name)} ${modeBadge}${groupBadge}</div>
        <div class="${detailClass}">${detail}${!needsAttention && session.status !== "offline" && lastActive ? ` · ${lastActive}` : ""}</div>
        ${truncatedPrompt ? `<div class="session-prompt">💬 ${escapeHtml(truncatedPrompt)}</div>` : ""}
      </div>
      <div class="session-actions">
        ${session.status === "offline" ? `<button class="restart-btn" title="Restart session">🔄</button>` : ""}
        <button class="rename-btn" title="Rename">✏️</button>
        <button class="delete-btn" title="Delete">🗑️</button>
      </div>
    `;

    // Click to select and filter
    el.addEventListener("click", (e) => {
      // Ignore if clicking action buttons
      if ((e.target as HTMLElement).closest(".session-actions")) return;
      selectManagedSession(session.id);
    });

    // Rename button
    el.querySelector(".rename-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const newName = prompt("Enter new name:", session.name);
      if (newName && newName !== session.name) {
        renameManagedSession(session.id, newName);
      }
    });

    // Delete button
    el.querySelector(".delete-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Delete session "${session.name}"?`)) {
        deleteManagedSession(session.id);
      }
    });

    // Restart button (only shown for offline sessions)
    el.querySelector(".restart-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      restartManagedSession(session.id, session.name);
    });

    container.appendChild(el);
  });
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
      targetEl.title = "Select a session to send prompts";
    }
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
): Promise<void> {
  const data = await sessionAPI.createSession(name, cwd, flags, mode);

  if (!data.ok) {
    console.error("Failed to create session:", data.error);
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

  // Store hint position using the ACTUAL name from server response
  // Server auto-generates "Claude N" if no name provided, so we must use its name
  // Also store pending zone ID so we can remove it when real zone appears
  const actualName = data.session?.name;
  if (actualName) {
    if (hintPosition) {
      pendingZoneHints.set(actualName, hintPosition);
    }
    if (pendingZoneId) {
      pendingZonesToCleanup.set(actualName, pendingZoneId);
    }
  }

  // DON'T remove pending zone here - keep it spinning until real zone appears
  // Session will be broadcast via WebSocket
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

  // Mode radio controls skip-permissions checkbox
  const modeRadios = document.querySelectorAll('input[name="session-mode"]');
  const skipPermsRow = document.getElementById("session-opt-skip-perms-row");
  const skipPermsCheckbox = document.getElementById(
    "session-opt-skip-perms",
  ) as HTMLInputElement;
  modeRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const mode = (e.target as HTMLInputElement).value as ClaudeMode;
      if (mode === "ask-before-edit") {
        // ask-before-edit disables skip-perms
        if (skipPermsCheckbox) skipPermsCheckbox.checked = false;
        if (skipPermsRow) skipPermsRow.style.opacity = "0.4";
      } else {
        // auto-edit and plan enable skip-perms
        if (skipPermsCheckbox) skipPermsCheckbox.checked = true;
        if (skipPermsRow) skipPermsRow.style.opacity = "1";
      }
    });
  });

  const closeModal = (): void => {
    modal?.classList.remove("visible");
    currentModalHint = null; // Clear hint when modal closes
  };

  const handleCreate = (): void => {
    const name = nameInput?.value.trim() || undefined;
    const cwd = cwdInput?.value.trim() || undefined;

    // Read selected mode
    const modeRadio = document.querySelector(
      'input[name="session-mode"]:checked',
    ) as HTMLInputElement;
    const mode = (modeRadio?.value as ClaudeMode) || "auto-edit";

    // Read flag checkboxes
    const continueCheck = document.getElementById(
      "session-opt-continue",
    ) as HTMLInputElement;
    const skipPermsCheck = document.getElementById(
      "session-opt-skip-perms",
    ) as HTMLInputElement;
    const chromeCheck = document.getElementById(
      "session-opt-chrome",
    ) as HTMLInputElement;

    // Mode determines skipPermissions: auto-edit and plan use skip-perms,
    // ask-before-edit does not (unless explicitly checked)
    const flags: SessionFlags = {
      continue: continueCheck?.checked ?? true,
      skipPermissions:
        mode === "ask-before-edit" ? false : (skipPermsCheck?.checked ?? true),
      chrome: chromeCheck?.checked ?? false,
    };

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
      mode,
    );
  };

  const handleCancel = (): void => {
    soundManager.play("modal_cancel");
    closeModal();
  };

  // New session button opens modal (no hint position from button click)
  const newBtn = document.getElementById("new-session-btn");
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

  // "All Sessions" click handler
  const allItem = document.querySelector(".session-item.all-sessions");
  if (allItem) {
    allItem.addEventListener("click", () => {
      selectManagedSession(null);
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
  } else if (action === "ungroup" && context.zoneId) {
    ungroupZone(context.zoneId);
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

/**
 * Group two zones together (or add to existing group).
 * Takes claude session IDs and resolves to managed IDs for API call.
 */
async function groupZonesWith(
  draggedClaudeId: string,
  targetClaudeId: string,
): Promise<void> {
  // Resolve to managed session IDs
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

  // If target is already in a group, add the dragged zone to that group
  // If dragged is already in a group, merge or just add target
  // For v1 simplicity: always create a fresh group with both members
  const memberIds = [draggedManaged.id, targetManaged.id];

  const result = await sessionAPI.createGroup(memberIds);
  if (result.ok) {
    toast.info(`Grouped "${draggedManaged.name}" with "${targetManaged.name}"`);
    if (state.soundEnabled) {
      soundManager.play("spawn");
    }
  } else {
    toast.error(`Failed to group: ${result.error}`);
  }
}

/**
 * Ungroup a zone (dissolve its group)
 */
async function ungroupZone(sessionId: string): Promise<void> {
  const managed = state.managedSessions.find(
    (s) => s.claudeSessionId === sessionId,
  );
  if (!managed?.groupId) return;

  const result = await sessionAPI.deleteGroup(managed.groupId);
  if (result.ok) {
    toast.info(`Ungrouped "${managed.name}"`);
  } else {
    toast.error(`Failed to ungroup: ${result.error}`);
  }
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
            // Free hex - move zone there
            state.scene.moveZone(draggedZoneId, targetHex);

            // Persist position via server API
            const managed = state.managedSessions.find(
              (s) => s.claudeSessionId === draggedZoneId,
            );
            if (managed) {
              sessionAPI.saveZonePosition(managed.id, targetHex);
            }

            // Refresh group link positions after zone move
            if (state.zoneGroups.length > 0) {
              state.scene.updateGroupLinks(
                state.zoneGroups,
                state.managedSessions,
              );
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
                label: `Edit "${existingTile.text}"`,
                action: "edit_text_tile",
              },
              {
                key: "D",
                label: "Delete label",
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
              { key: "C", label: "Create zone", action: "create" },
              { key: "T", label: "Add text label", action: "create_text_tile" },
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
        { key: "C", label: `Command`, action: "command" },
        { key: "M", label: `Mode: ${modeLabel}`, action: "mode" },
        { key: "I", label: `Info`, action: "info" },
      ];

      // Add ungroup option if zone is in a group
      if (managed?.groupId) {
        menuItems.push({
          key: "U",
          label: "Ungroup",
          action: "ungroup",
        });
      }

      menuItems.push({
        key: "D",
        label: `Dismiss "${zoneName}"`,
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
        modeDesc.textContent = "all sessions";
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

function getOrCreateSession(sessionId: string): SessionState | null {
  let session = state.sessions.get(sessionId);
  if (session) return session;

  if (!state.scene) {
    throw new Error("Scene not initialized");
  }

  // Check if this session can be linked to a managed session
  // Only create zones for sessions that are linked or can be linked
  const canLink = canLinkToManagedSession(sessionId);
  if (!canLink) {
    // Unlinked session - don't create a zone for it
    console.log(
      `Ignoring unlinked session ${sessionId.slice(0, 8)} (no matching managed session)`,
    );
    return null;
  }

  // Try to link to a recently-created managed session FIRST
  // (so we can get the hint position from it)
  const linkedManagedSession = tryLinkToManagedSession(sessionId);

  // Look up hint position: first check saved zone position, then pending hints
  let hintPosition: { x: number; z: number } | undefined;
  if (linkedManagedSession) {
    // Check for saved zone position from server
    if (linkedManagedSession.zonePosition) {
      // Convert hex coords back to cartesian for hint
      const cartesian = state.scene.hexGrid.axialToCartesian(
        linkedManagedSession.zonePosition,
      );
      hintPosition = { x: cartesian.x, z: cartesian.z };
      console.log(
        `Restoring zone position for "${linkedManagedSession.name}" at hex`,
        linkedManagedSession.zonePosition,
      );
    } else {
      // Fall back to pending hints (from modal click)
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
      // Clear the timeout since zone was created successfully
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

  // Create Claude with matching color, positioned at zone center
  const claude = new Claude(state.scene, {
    color: zone.color,
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
 * Returns true if already linked or if there's a recently-created unlinked managed session
 */
function canLinkToManagedSession(claudeSessionId: string): boolean {
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

  // Is there a recently-created unlinked managed session we can link to?
  const now = Date.now();
  const LINK_WINDOW_MS = 30_000; // 30 seconds
  for (const managed of state.managedSessions) {
    if (!managed.claudeSessionId) {
      const age = now - managed.createdAt;
      if (age < LINK_WINDOW_MS) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Try to link a Claude session to a managed session
 * Uses timing: looks for unlinked managed sessions created in the last 30 seconds
 */
function tryLinkToManagedSession(
  claudeSessionId: string,
): ManagedSession | null {
  const now = Date.now();
  const LINK_WINDOW_MS = 30_000; // 30 seconds

  // Check if already linked
  if (claudeToManagedLink.has(claudeSessionId)) {
    const managedId = claudeToManagedLink.get(claudeSessionId)!;
    return state.managedSessions.find((s) => s.id === managedId) || null;
  }

  // Find unlinked managed sessions created recently
  for (const managed of state.managedSessions) {
    // Skip if already linked
    if (managed.claudeSessionId) continue;

    // Check if created recently
    const age = now - managed.createdAt;
    if (age < LINK_WINDOW_MS) {
      // Link them!
      claudeToManagedLink.set(claudeSessionId, managed.id);
      managed.claudeSessionId = claudeSessionId;

      // Notify server about the link
      linkSessionOnServer(managed.id, claudeSessionId);

      return managed;
    }
  }

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

    // Also create the link for future use
    claudeToManagedLink.set(zoneId, managed.id);
    managed.claudeSessionId = zoneId;

    // Notify server about the link
    linkSessionOnServer(managed.id, zoneId);

    console.log(
      `Auto-linked zone ${zoneId.slice(0, 8)} to managed session "${managed.name}"`,
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
  const session = getOrCreateSession(event.sessionId);

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
    const response = await fetch(CANCEL_URL, { method: "POST" });
    const data = await response.json();

    if (!data.ok) {
      toast.error(data.error || "Interrupt failed", {
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

  // Keyboard handling: Enter to send, Up/Down for history
  // Note: Skip if slash commands already handled the event
  input.addEventListener("keydown", (e) => {
    // Enter to send (Ctrl+Enter for newline)
    if (
      e.key === "Enter" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.defaultPrevented
    ) {
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

  // Cancel button handler
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (status) {
        status.textContent = "Cancelling...";
        status.className = "";
      }
      try {
        const response = await fetch(CANCEL_URL, { method: "POST" });
        const data = await response.json();
        if (status) {
          if (data.ok) {
            status.textContent = "Cancelled!";
            status.className = "success";
          } else {
            status.textContent = data.error || "Cancel failed";
            status.className = "error";
          }
        }
      } catch (error) {
        if (status) {
          status.textContent = "Connection error";
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
        input.value = existing ? existing + " " + transcript : transcript;
      }
    }

    const prompt = input.value.trim();
    if (!prompt) return;

    // Always send prompts to Claude Code
    const isCommand = isSlashCommand(prompt);
    const send = true;

    button.disabled = true;
    if (status) {
      status.textContent = send ? "Sending to Claude..." : "Saving...";
      status.className = "";
    }

    try {
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
        data = await sendPromptToManagedSession(prompt);
        if (data.ok && status) {
          status.textContent = `Sent to ${session?.name || "session"}!`;
          status.className = "success";
          // Add to history and reset navigation
          state.promptHistory.push(prompt);
          state.historyIndex = -1;
          state.historyDraft = "";
          input.value = "";
          input.style.height = "auto";
          state.feedManager?.scrollToBottom();
        } else if (!data.ok && status) {
          status.textContent = data.error || "Failed to send";
          status.className = "error";
        }
      } else {
        // Legacy: send to default tmux session
        const response = await fetch(PROMPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, send }),
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
              status.textContent = "Sent to Claude!";
            } else if (data.tmuxError) {
              status.textContent = `Saved (tmux error: ${data.tmuxError})`;
              status.className = "error";
              return;
            } else {
              status.textContent = `Saved to ${data.saved}`;
            }
            status.className = "success";
          }
        } else {
          if (status) {
            status.textContent = data.error || "Failed to send";
            status.className = "error";
          }
        }
      }
    } catch (error) {
      if (status) {
        status.textContent = "Connection error";
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

  // Focus when hovering over the right panel (activity feed area)
  const feedPanel = document.getElementById("feed-panel");
  if (feedPanel) {
    feedPanel.addEventListener("mouseenter", () => {
      input.focus();
    });
  }

  // Focus on initial load
  input.focus();
}

// ============================================================================
// Panel Tab Switching (Activity / Team Chat)
// ============================================================================

function setupPanelTabs() {
  const tabs = document.querySelectorAll("#panel-tabs .panel-tab");
  const sessionsPanel = document.getElementById("sessions-panel");
  const terminalPanel = document.getElementById("terminal-panel");
  const feedWrapper = document.getElementById("activity-feed-wrapper");
  const imWrapper = document.getElementById("im-channel-wrapper");

  if (!tabs.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = (tab as HTMLElement).dataset.tab;

      // Update active tab
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      if (target === "feed") {
        // Show activity feed panels
        if (sessionsPanel) sessionsPanel.style.display = "";
        if (terminalPanel) terminalPanel.style.display = "";
        if (feedWrapper) feedWrapper.style.display = "";
        if (imWrapper) imWrapper.classList.add("hidden");
      } else if (target === "im") {
        // Show IM channel
        if (sessionsPanel) sessionsPanel.style.display = "none";
        if (terminalPanel) terminalPanel.style.display = "none";
        if (feedWrapper) feedWrapper.style.display = "none";
        if (imWrapper) imWrapper.classList.remove("hidden");
      }
    });
  });
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
    modal.classList.add("visible");
  });

  // Close modal
  const closeModal = () => modal.classList.remove("visible");
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
  });

  // Close modal
  const closeModal = () => modal.classList.remove("visible");
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

  // Initialize IM channel
  state.imChannel = new IMChannel();

  // Setup panel tab switching (Activity / Team Chat)
  setupPanelTabs();

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
    // Reconcile local link map with server's authoritative data
    // Server is the source of truth for session linking
    claudeToManagedLink.clear();
    for (const session of sessions) {
      if (session.claudeSessionId) {
        claudeToManagedLink.set(session.claudeSessionId, session.id);

        // Proactively create zone if it doesn't exist yet
        // This handles sessions that have no recent events in history
        if (state.scene && !state.scene.zones.has(session.claudeSessionId)) {
          // Use saved position if available
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
          } else {
            console.log(
              `Creating zone for session "${session.name}" (no recent events in history)`,
            );
          }
          const zone = state.scene.createZone(session.claudeSessionId, {
            hintPosition,
          });

          // Play zone creation sound
          if (state.soundEnabled) {
            soundManager.play("zone_create", {
              zoneId: session.claudeSessionId,
            });
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
          state.sessions.set(session.claudeSessionId, sessionState);

          // Update zone label with session name
          const keybindIndex = sessions.indexOf(session);
          const keybind =
            keybindIndex >= 0 ? getSessionKeybind(keybindIndex) : undefined;
          state.scene.updateZoneLabel(
            session.claudeSessionId,
            session.name,
            keybind,
          );
        }

        // Update zone floor status based on session status
        if (state.scene) {
          // Map managed session status to zone status
          const zoneStatus =
            session.status === "working"
              ? "working"
              : session.status === "waiting"
                ? "waiting"
                : session.status === "offline"
                  ? "offline"
                  : "idle";
          state.scene.setZoneStatus(session.claudeSessionId, zoneStatus);
        }
      }
    }

    // Clean up orphaned zones (zones not linked to any managed session)
    if (state.scene) {
      const activeClaudeIds = new Set(
        sessions.map((s) => s.claudeSessionId).filter(Boolean),
      );
      const zonesToDelete: string[] = [];
      for (const [zoneId] of state.scene.zones) {
        if (!activeClaudeIds.has(zoneId)) {
          zonesToDelete.push(zoneId);
        }
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
    renderManagedSessions();

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

  // Setup prompt form
  setupPromptForm();

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

  // Setup voice input
  // On vibecraft.sh: voice is always available via cloud proxy, set up immediately
  // On localhost: needs client connected and voice enabled on server
  const isHostedSite = window.location.hostname === "vibecraft.sh";
  const voiceControl = document.getElementById("voice-control");

  if (isHostedSite) {
    // Hosted mode - voice always available via cloud proxy
    if (voiceControl) voiceControl.classList.remove("disabled");
    state.voice = setupVoiceControl({
      client: state.client,
      soundEnabled: () => state.soundEnabled,
    });
  } else {
    // Local mode - check server health for voice availability
    state.client.onConnection(async (connected) => {
      if (connected && state.client) {
        try {
          const res = await fetch("/health");
          const health = await res.json();
          if (!health.voiceEnabled) {
            if (voiceControl) {
              voiceControl.classList.add("disabled");
              voiceControl.title =
                "Voice disabled - set DEEPGRAM_API_KEY in .env";
            }
            return;
          }
        } catch {
          if (voiceControl) {
            voiceControl.classList.add("disabled");
            voiceControl.title = "Voice unavailable - server connection failed";
          }
          return;
        }
        // Voice is enabled, set it up
        if (voiceControl) voiceControl.classList.remove("disabled");
        state.voice = setupVoiceControl({
          client: state.client,
          soundEnabled: () => state.soundEnabled,
        });
      }
    });
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
    imChannel: state.imChannel,
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
