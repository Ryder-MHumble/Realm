/**
 * ZoneCommandModal - Quick command input for a specific zone
 *
 * A minimal, elegant prompt that appears near the 3D zone
 * and sends commands directly to that zone's session.
 */

import * as THREE from "three";
import { soundManager } from "../audio/SoundManager";

// ============================================================================
// Types
// ============================================================================

export interface ZoneCommandOptions {
  sessionId: string;
  sessionName: string;
  sessionColor: number;
  zonePosition: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  onSend: (
    sessionId: string,
    prompt: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

type ResolveFunction = (sent: boolean) => void;

// ============================================================================
// State
// ============================================================================

let currentOptions: ZoneCommandOptions | null = null;
let resolvePromise: ResolveFunction | null = null;
let isVisible = false;
let element: HTMLElement | null = null;

// ============================================================================
// Setup
// ============================================================================

/**
 * Initialize the zone command modal (creates DOM element)
 */
export function setupZoneCommandModal(): void {
  // Create the modal element
  element = document.createElement("div");
  element.id = "zone-command-modal";
  element.className = "zone-command-modal";
  element.innerHTML = `
    <div class="zone-command-content">
      <div class="zone-command-header">
        <span class="zone-command-target">
          <span class="zone-command-dot"></span>
          <span class="zone-command-name"></span>
        </span>
        <span class="zone-command-hint">⌘/Ctrl+Enter to send</span>
      </div>
      <div class="zone-command-body">
        <textarea
          class="zone-command-input"
          placeholder="Command..."
          rows="1"
        ></textarea>
        <button class="zone-command-send" type="button">
          <span class="send-icon">↗</span>
        </button>
      </div>
      <div class="zone-command-connector"></div>
    </div>
  `;
  document.body.appendChild(element);

  // Setup event listeners
  const input = element.querySelector(
    ".zone-command-input",
  ) as HTMLTextAreaElement;
  const sendBtn = element.querySelector(
    ".zone-command-send",
  ) as HTMLButtonElement;

  // Auto-expand textarea
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  });

  // Cmd/Ctrl+Enter to send
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendCommand();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideZoneCommandModal();
    }
  });

  // Send button click
  sendBtn?.addEventListener("click", () => {
    sendCommand();
  });

  // Click outside to dismiss
  element.addEventListener("mousedown", (e) => {
    if (e.target === element) {
      hideZoneCommandModal();
    }
  });

  // Global escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isVisible) {
      hideZoneCommandModal();
    }
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Show the zone command modal near a zone
 */
export function showZoneCommandModal(
  options: ZoneCommandOptions,
): Promise<boolean> {
  if (!element) {
    console.warn("ZoneCommandModal not initialized");
    return Promise.resolve(false);
  }

  currentOptions = options;
  isVisible = true;

  // Update target display
  const dot = element.querySelector(".zone-command-dot") as HTMLElement;
  const name = element.querySelector(".zone-command-name") as HTMLElement;
  const input = element.querySelector(
    ".zone-command-input",
  ) as HTMLTextAreaElement;

  const colorHex = `#${options.sessionColor.toString(16).padStart(6, "0")}`;
  dot.style.background = colorHex;
  dot.style.boxShadow = `0 0 10px ${colorHex}`;
  name.textContent = options.sessionName;
  name.style.color = colorHex;

  // Clear and reset input
  input.value = "";
  input.style.height = "auto";

  // Position modal near the zone
  positionNearZone(options);

  // Show with animation
  element.classList.add("visible");
  soundManager.play("modal_open");

  // Focus input
  setTimeout(() => {
    input.focus();
  }, 50);

  return new Promise((resolve) => {
    resolvePromise = resolve;
  });
}

/**
 * Hide the modal
 */
export function hideZoneCommandModal(): void {
  if (!element || !isVisible) return;

  soundManager.play("modal_cancel");
  element.classList.remove("visible");
  isVisible = false;

  if (resolvePromise) {
    resolvePromise(false);
    resolvePromise = null;
  }
  currentOptions = null;
}

/**
 * Check if modal is visible
 */
export function isZoneCommandModalVisible(): boolean {
  return isVisible;
}

// ============================================================================
// Private Functions
// ============================================================================

/**
 * Position the modal near the 3D zone
 */
function positionNearZone(options: ZoneCommandOptions): void {
  if (!element) return;

  const content = element.querySelector(".zone-command-content") as HTMLElement;
  const connector = element.querySelector(
    ".zone-command-connector",
  ) as HTMLElement;

  // Project 3D position to screen
  const pos = options.zonePosition.clone();
  pos.y += 2; // Slightly above the zone
  pos.project(options.camera);

  // Convert to screen coordinates
  const canvas = options.renderer.domElement;
  const screenX = (pos.x * 0.5 + 0.5) * canvas.clientWidth;
  const screenY = (-pos.y * 0.5 + 0.5) * canvas.clientHeight;

  // Position content with smart viewport clamping
  const contentWidth = 320;
  const contentHeight = 100;
  const margin = 20;

  let x = screenX - contentWidth / 2;
  let y = screenY - contentHeight - 30; // Above the zone

  // Clamp to viewport
  x = Math.max(margin, Math.min(window.innerWidth - contentWidth - margin, x));
  y = Math.max(
    margin,
    Math.min(window.innerHeight - contentHeight - margin, y),
  );

  content.style.left = `${x}px`;
  content.style.top = `${y}px`;

  // Position connector line from modal to zone
  const contentCenterX = x + contentWidth / 2;
  const contentBottomY = y + contentHeight;

  // Calculate connector angle and length
  const dx = screenX - contentCenterX;
  const dy = screenY - contentBottomY;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  connector.style.width = `${length}px`;
  connector.style.left = `${contentCenterX}px`;
  connector.style.top = `${contentBottomY}px`;
  connector.style.transform = `rotate(${angle}deg)`;
  connector.style.transformOrigin = "0 0";

  // Color the connector
  const colorHex = `#${options.sessionColor.toString(16).padStart(6, "0")}`;
  connector.style.background = `linear-gradient(90deg, ${colorHex}40, ${colorHex}00)`;
}

/**
 * Send the command to the zone's session
 */
async function sendCommand(): Promise<void> {
  if (!element || !currentOptions) return;

  const input = element.querySelector(
    ".zone-command-input",
  ) as HTMLTextAreaElement;
  const sendBtn = element.querySelector(
    ".zone-command-send",
  ) as HTMLButtonElement;
  const prompt = input.value.trim();

  if (!prompt) return;

  // Disable while sending
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="send-icon spinning">↻</span>';

  try {
    const result = await currentOptions.onSend(
      currentOptions.sessionId,
      prompt,
    );

    if (result.ok) {
      // Success - close modal
      soundManager.play("prompt");
      element.classList.remove("visible");
      isVisible = false;

      if (resolvePromise) {
        resolvePromise(true);
        resolvePromise = null;
      }
      currentOptions = null;
    } else {
      // Error - show feedback with message, keep open
      input.classList.add("error");
      const savedPlaceholder = input.placeholder;
      if (result.error) {
        input.value = "";
        input.placeholder = result.error;
      }
      setTimeout(() => {
        input.classList.remove("error");
        input.placeholder = savedPlaceholder;
      }, 2000);
    }
  } catch (err) {
    console.error("Failed to send command:", err);
    input.classList.add("error");
    const savedPlaceholder = input.placeholder;
    input.value = "";
    input.placeholder = err instanceof Error ? err.message : "Send failed";
    setTimeout(() => {
      input.classList.remove("error");
      input.placeholder = savedPlaceholder;
    }, 2000);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<span class="send-icon">↗</span>';
  }
}
