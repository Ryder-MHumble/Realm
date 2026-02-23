/**
 * Question Modal - AskUserQuestion tool UI
 *
 * Displays questions from Claude's AskUserQuestion tool
 * and sends responses back via the API.
 */

import { soundManager } from "../audio";
import { escapeHtml } from "./FeedManager";
import type { WorkshopScene } from "../scene/WorkshopScene";
import type { AttentionSystem } from "../systems/AttentionSystem";

// ============================================================================
// Types
// ============================================================================

export interface QuestionData {
  sessionId: string;
  managedSessionId: string | null;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  }>;
}

export interface QuestionModalContext {
  scene: WorkshopScene | null;
  soundEnabled: boolean;
  apiUrl: string;
  attentionSystem: AttentionSystem | null;
}

// ============================================================================
// State
// ============================================================================

let currentQuestion: QuestionData | null = null;
let context: QuestionModalContext | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the question modal with dependencies
 */
export function setupQuestionModal(ctx: QuestionModalContext): void {
  context = ctx;

  const skipBtn = document.getElementById("question-skip");
  const sendOtherBtn = document.getElementById("question-send-other");
  const otherInput = document.getElementById(
    "question-other-input",
  ) as HTMLTextAreaElement;
  const modal = document.getElementById("question-modal");

  // Skip button
  skipBtn?.addEventListener("click", () => {
    hideQuestionModal();
  });

  // Send custom response
  sendOtherBtn?.addEventListener("click", () => {
    const text = otherInput?.value.trim();
    if (text) {
      if (context?.soundEnabled) soundManager.play("modal_confirm");
      sendQuestionResponse(text);
    }
  });

  // Enter to send custom response
  otherInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = otherInput.value.trim();
      if (text) {
        if (context?.soundEnabled) soundManager.play("modal_confirm");
        sendQuestionResponse(text);
      }
    }
  });

  // Click outside to close
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) {
      hideQuestionModal();
    }
  });

  // Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentQuestion) {
      hideQuestionModal();
    }
  });
}

/**
 * Show the question modal with data from AskUserQuestion
 */
export function showQuestionModal(data: QuestionData): void {
  const modal = document.getElementById("question-modal");
  const badge = document.getElementById("question-badge");
  const header = document.getElementById("question-header");
  const text = document.getElementById("question-text");
  const optionsContainer = document.getElementById("question-options");
  const otherInput = document.getElementById(
    "question-other-input",
  ) as HTMLTextAreaElement;

  if (!modal || !optionsContainer) return;

  currentQuestion = data;

  // Use first question (most common case)
  const q = data.questions[0];
  if (!q) return;

  if (badge) badge.textContent = q.header || "Question";
  if (header) header.textContent = "Claude needs input";
  if (text) text.textContent = q.question;

  // Clear previous options
  optionsContainer.innerHTML = "";

  // Add option buttons
  q.options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "question-option";
    btn.innerHTML = `
      <span class="question-option-label">${escapeHtml(opt.label)}</span>
      ${opt.description ? `<span class="question-option-desc">${escapeHtml(opt.description)}</span>` : ""}
    `;
    btn.addEventListener("click", () => {
      if (context?.soundEnabled) soundManager.play("modal_confirm");
      sendQuestionResponse(opt.label);
    });
    optionsContainer.appendChild(btn);
  });

  // Clear other input
  if (otherInput) otherInput.value = "";

  // Show modal
  modal.classList.add("visible");

  // Set attention on the session's zone
  if (context?.scene) {
    context.scene.setZoneAttention(data.sessionId, "question");
    context.scene.setZoneStatus(data.sessionId, "attention");
  }

  // Add to attention queue (using managed session ID if available)
  if (data.managedSessionId) {
    context?.attentionSystem?.add(data.managedSessionId);
  }

  // Play modal open sound (AttentionSystem already plays 'notification')
  if (context?.soundEnabled) {
    soundManager.play("modal_open");
  }
}

/**
 * Hide the question modal
 */
export function hideQuestionModal(): void {
  const modal = document.getElementById("question-modal");
  if (!currentQuestion) return; // Already hidden

  if (context?.soundEnabled) soundManager.play("modal_cancel");
  modal?.classList.remove("visible");

  // Reset zone status and clear attention when question is answered
  if (currentQuestion && context) {
    if (context.scene) {
      context.scene.setZoneStatus(currentQuestion.sessionId, "working");
      context.scene.clearZoneAttention(currentQuestion.sessionId);
    }

    // Remove from attention queue
    if (currentQuestion.managedSessionId) {
      context.attentionSystem?.remove(currentQuestion.managedSessionId);
    }
  }

  currentQuestion = null;
}

/**
 * Check if question modal is currently shown
 */
export function isQuestionModalVisible(): boolean {
  return currentQuestion !== null;
}

// ============================================================================
// Internal
// ============================================================================

async function sendQuestionResponse(response: string): Promise<void> {
  if (!currentQuestion || !context) return;

  const sessionId = currentQuestion.managedSessionId;

  try {
    if (sessionId) {
      // Send to managed session
      await fetch(`${context.apiUrl}/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: response }),
      });
    } else {
      // Send to default tmux session
      await fetch(`${context.apiUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: response, send: true }),
      });
    }
  } catch (e) {
    console.error("Failed to send question response:", e);
  }

  hideQuestionModal();
}
