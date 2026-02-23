/**
 * KeyboardShortcuts - Global keyboard shortcut handling
 *
 * Handles:
 * - Focus switching (Tab/Escape by default, editable)
 * - 1-6: Sessions 1-6 (shown in UI)
 * - QWERTY: Sessions 7-12 (extended keybinds, not shown)
 * - ASDFGH: Sessions 13-18 (extended keybinds, not shown)
 * - ZXCVBN: Sessions 19-24 (extended keybinds, not shown)
 * - Alt+key works in inputs, plain keys work outside inputs
 * - 0/`: Overview mode
 * - Alt+N: New session
 * - Alt+E: Expand feed item
 * - F: Follow mode toggle
 * - Alt+D: Dev panel toggle
 */

import type { WorkshopScene } from "../scene/WorkshopScene";
import type { ManagedSession } from "../../shared/types";
import { keybindManager } from "./KeybindConfig";
import { drawMode } from "./DrawMode";

// ============================================================================
// Session Keybinds
// ============================================================================

/**
 * Keybind sequence for sessions:
 * 1-6, then left-hand keyboard rows: QWERTY, ASDFGH, ZXCVBN
 */
export const SESSION_KEYBINDS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "Q",
  "W",
  "E",
  "R",
  "T",
  "Y",
  "A",
  "S",
  "D",
  "F",
  "G",
  "H",
  "Z",
  "X",
  "C",
  "V",
  "B",
  "N",
];

/**
 * Get keybind character for a session index, or undefined if beyond range
 */
export function getSessionKeybind(index: number): string | undefined {
  return SESSION_KEYBINDS[index];
}

/**
 * Get session index from a key press, or -1 if not a session keybind
 */
export function getSessionIndexFromKey(key: string): number {
  const upper = key.toUpperCase();
  const index = SESSION_KEYBINDS.indexOf(upper);
  // Also check lowercase numbers (they're the same)
  if (index === -1 && key >= "1" && key <= "6") {
    return parseInt(key) - 1;
  }
  return index;
}

// ============================================================================
// Types
// ============================================================================

export interface KeyboardShortcutContext {
  /** Get the workshop scene (may be null during init) */
  getScene: () => WorkshopScene | null;

  /** Get current managed sessions list */
  getManagedSessions: () => ManagedSession[];

  /** Get currently focused session ID */
  getFocusedSessionId: () => string | null;

  /** Get currently selected managed session */
  getSelectedManagedSession: () => ManagedSession | null;

  /** Callbacks */
  onSelectManagedSession: (id: string | null) => void;
  onFocusSession: (sessionId: string) => void;
  onGoToNextAttention: () => void;
  onUpdateAttentionBadge: () => void;
  onSetUserChangedCamera: (value: boolean) => void;
  onInterruptSession: (sessionName: string) => void;
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Setup global keyboard shortcuts
 */
export function setupKeyboardShortcuts(ctx: KeyboardShortcutContext): void {
  document.addEventListener("keydown", (e) => {
    const inInput =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement;
    const isModal = document
      .getElementById("new-session-modal")
      ?.classList.contains("visible");
    const isContextMenu =
      document.querySelector(".context-menu.visible") !== null;
    const scene = ctx.getScene();

    // ========================================================================
    // CTRL+C - Context-aware interrupt
    // ========================================================================
    // If text is selected → let browser handle copy
    // If no selection AND we have an active session → send interrupt
    if (e.ctrlKey && e.key === "c" && !e.shiftKey && !e.altKey && !e.metaKey) {
      const selection = window.getSelection()?.toString() || "";

      // If text is selected, let browser handle copy
      if (selection.length > 0) {
        return; // Don't prevent default - allow copy
      }

      // No selection - check for active session to interrupt
      const selectedSession = ctx.getSelectedManagedSession();
      if (selectedSession && selectedSession.status === "working") {
        e.preventDefault();
        ctx.onInterruptSession(selectedSession.name);
        return;
      }

      // No active working session - let it pass through (browser may still use it)
      return;
    }

    // Focus toggle (Tab/Escape by default, user-configurable)
    // Handle before other checks so it works from inputs
    if (!isModal && keybindManager.matches("focus-toggle", e)) {
      e.preventDefault();
      const promptInput = document.getElementById(
        "prompt-input",
      ) as HTMLTextAreaElement;
      const feedDrawer = document.getElementById("feed-drawer");
      const canvas = scene?.renderer?.domElement;

      const feedToggleBtn = document.getElementById("feed-toggle-btn");
      if (inInput) {
        // Currently in feed/prompt area - close drawer, focus canvas
        (e.target as HTMLElement).blur();
        feedDrawer?.classList.remove("open");
        feedToggleBtn?.classList.remove("active");
        canvas?.focus();
      } else {
        // Currently in workshop area - open drawer, focus prompt
        feedDrawer?.classList.add("open");
        feedToggleBtn?.classList.add("active");
        promptInput?.focus();
      }
      return;
    }

    if (!scene) return;

    // ========================================================================
    // DRAW MODE HANDLING
    // ========================================================================

    // D key toggles draw mode (outside inputs, not in modals or context menus)
    if (
      !inInput &&
      !isModal &&
      !isContextMenu &&
      (e.key === "d" || e.key === "D") &&
      !e.altKey &&
      !e.ctrlKey
    ) {
      e.preventDefault();
      drawMode.toggle();
      return;
    }

    // Escape exits draw mode (in addition to focus toggle)
    if (e.key === "Escape" && drawMode.isEnabled()) {
      e.preventDefault();
      drawMode.exit();
      return;
    }

    // In draw mode, 1-6 and 0 select colors instead of sessions
    if (drawMode.isEnabled() && !inInput) {
      if (drawMode.handleKey(e.key)) {
        e.preventDefault();
        return;
      }

      // X or Backspace to clear all painted hexes
      if (e.key === "x" || e.key === "X" || e.key === "Backspace") {
        e.preventDefault();
        scene.clearAllPaintedHexes();
        return;
      }
    }

    // ========================================================================
    // NORMAL MODE HANDLING
    // ========================================================================

    // Alt+key works everywhere, plain key only outside inputs
    // Session keys: 1-6, Q-Y, A-H, Z-N
    const sessionIndex = getSessionIndexFromKey(e.key);
    const isSessionKey = sessionIndex >= 0;
    const useShortcut = isSessionKey && (e.altKey || !inInput);

    if (!useShortcut && inInput) return;

    // Session keybinds (1-6, QWERTY, ASDFGH, ZXCVBN)
    if (sessionIndex >= 0) {
      e.preventDefault(); // Prevent Alt+key from triggering browser menus
      const index = sessionIndex;
      const managedSessions = ctx.getManagedSessions();

      // Select managed session if exists
      if (index < managedSessions.length) {
        const session = managedSessions[index];
        ctx.onSelectManagedSession(session.id);

        // Also focus the linked zone if available
        if (session.claudeSessionId) {
          ctx.onSetUserChangedCamera(true);
          scene.focusZone(session.claudeSessionId);
          ctx.onFocusSession(session.claudeSessionId);
          // Clear attention - user is viewing this zone
          scene.clearZoneAttention(session.claudeSessionId);
          scene.setZoneStatus(session.claudeSessionId, "idle");
          ctx.onUpdateAttentionBadge();
        }
      } else {
        // Fall back to zone index for legacy sessions
        const zone = scene.getZoneByIndex(index);
        if (zone) {
          ctx.onSetUserChangedCamera(true);
          scene.focusZone(zone.id);
          ctx.onFocusSession(zone.id);
          // Clear attention - user is viewing this zone
          scene.clearZoneAttention(zone.id);
          scene.setZoneStatus(zone.id, "idle");
          ctx.onUpdateAttentionBadge();
        }
      }
      return;
    }

    // 0 or backtick for all sessions / overview (backtick is left-hand friendly)
    // Plain backtick works outside inputs, Alt+` works everywhere
    if (e.key === "0" || e.key === "`" || (e.altKey && e.key === "`")) {
      if (e.key === "`" && inInput && !e.altKey) return; // Don't capture plain ` in inputs
      e.preventDefault();
      ctx.onSetUserChangedCamera(true);
      ctx.onSelectManagedSession(null);
      scene.setOverviewMode();
      return;
    }

    // Alt+N for new session
    if (e.altKey && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      // Open the modal
      const modal = document.getElementById("new-session-modal");
      const nameInput = document.getElementById(
        "session-name-input",
      ) as HTMLInputElement;
      if (modal) {
        modal.classList.add("visible");
        setTimeout(() => nameInput?.focus(), 100);
      }
      return;
    }

    // Alt+E to expand most recent "show more" in feed
    if (e.altKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      const showMoreElements = document.querySelectorAll(".show-more");
      if (showMoreElements.length > 0) {
        // Click the last (most recent) show-more element
        const lastShowMore = showMoreElements[
          showMoreElements.length - 1
        ] as HTMLElement;
        lastShowMore.click();
      }
      return;
    }

    // F for follow-active mode (only outside inputs)
    if (!inInput && (e.key === "f" || e.key === "F")) {
      ctx.onSetUserChangedCamera(true);
      if (scene.cameraMode === "follow-active") {
        // Toggle back to focused mode
        const focusedId = ctx.getFocusedSessionId();
        if (focusedId) {
          scene.focusZone(focusedId);
        }
      } else {
        scene.setFollowActiveMode();
      }
      return;
    }

    // P for station panels toggle (only outside inputs)
    if (!inInput && (e.key === "p" || e.key === "P")) {
      const visible = !scene.stationPanels.isVisible();
      scene.stationPanels.setVisible(visible);
      return;
    }

    // Alt+D for dev panel toggle (animation testing)
    if (e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      const devPanel = document.getElementById("dev-panel");
      if (devPanel) {
        devPanel.classList.toggle("hidden");
      }
      return;
    }
  });
}
