/**
 * TextLabelModal - Custom modal for text tile input
 *
 * Replaces browser's prompt() with a themed textarea modal
 * that supports multi-line input for longer text.
 */

import { soundManager } from "../audio/SoundManager";

// ============================================================================
// Types
// ============================================================================

export interface TextLabelModalOptions {
  title?: string;
  placeholder?: string;
  initialText?: string;
  maxLength?: number;
}

type ResolveFunction = (text: string | null) => void;

// ============================================================================
// State
// ============================================================================

let resolvePromise: ResolveFunction | null = null;
let isVisible = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the text label modal
 */
export function setupTextLabelModal(): void {
  const modal = document.getElementById("text-label-modal");
  const cancelBtn = document.getElementById("text-label-cancel");
  const saveBtn = document.getElementById("text-label-save");
  const textarea = document.getElementById(
    "text-label-input",
  ) as HTMLTextAreaElement;
  const charCount = document.getElementById("text-label-char-count");

  // Cancel button
  cancelBtn?.addEventListener("click", () => {
    closeModal(null);
  });

  // Save button
  saveBtn?.addEventListener("click", () => {
    const text = textarea?.value.trim();
    closeModal(text || null);
  });

  // Enter to save (Ctrl+Enter for newline)
  textarea?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      const text = textarea.value.trim();
      closeModal(text || null);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal(null);
    }
  });

  // Update character count
  textarea?.addEventListener("input", () => {
    updateCharCount(textarea, charCount);
  });

  // Click outside to cancel
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal(null);
    }
  });

  // Global escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isVisible) {
      closeModal(null);
    }
  });
}

/**
 * Show the text label modal and return the entered text
 */
export function showTextLabelModal(
  options: TextLabelModalOptions = {},
): Promise<string | null> {
  const modal = document.getElementById("text-label-modal");
  const title = document.getElementById("text-label-title");
  const textarea = document.getElementById(
    "text-label-input",
  ) as HTMLTextAreaElement;
  const charCount = document.getElementById("text-label-char-count");

  if (!modal || !textarea) {
    // Fallback to browser prompt if modal doesn't exist
    return Promise.resolve(
      prompt(options.title || "Enter text:", options.initialText || ""),
    );
  }

  // Configure modal
  if (title) {
    title.textContent = options.title || "Add Label";
  }

  textarea.placeholder = options.placeholder || "Enter your text here...";
  textarea.value = options.initialText || "";
  textarea.maxLength = options.maxLength || 500;

  // Update char count
  updateCharCount(textarea, charCount);

  // Show modal
  modal.classList.add("visible");
  isVisible = true;
  soundManager.play("modal_open");

  // Focus textarea
  setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 50);

  // Return promise
  return new Promise((resolve) => {
    resolvePromise = resolve;
  });
}

/**
 * Hide the modal
 */
export function hideTextLabelModal(): void {
  closeModal(null);
}

// ============================================================================
// Private Functions
// ============================================================================

function closeModal(text: string | null): void {
  if (!isVisible) return; // Already closed, don't double-play sounds

  const modal = document.getElementById("text-label-modal");
  soundManager.play(text !== null ? "modal_confirm" : "modal_cancel");
  modal?.classList.remove("visible");
  isVisible = false;

  if (resolvePromise) {
    resolvePromise(text);
    resolvePromise = null;
  }
}

function updateCharCount(
  textarea: HTMLTextAreaElement | null,
  charCount: HTMLElement | null,
): void {
  if (!textarea || !charCount) return;
  const current = textarea.value.length;
  const max = textarea.maxLength || 500;
  charCount.textContent = `${current}/${max}`;

  // Color feedback
  if (current > max * 0.9) {
    charCount.style.color = "#f87171";
  } else if (current > max * 0.7) {
    charCount.style.color = "#fbbf24";
  } else {
    charCount.style.color = "rgba(255, 255, 255, 0.5)";
  }
}
