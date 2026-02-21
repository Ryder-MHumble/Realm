/**
 * FeedManager - Manages the activity feed panel
 *
 * Handles:
 * - Adding events to the feed (prompts, tool uses, responses)
 * - Filtering by session
 * - Auto-scroll behavior
 * - Scroll-to-bottom button
 */

import { getToolIcon } from "../utils/ToolUtils";
import type {
  ClaudeEvent,
  PreToolUseEvent,
  PostToolUseEvent,
} from "../../shared/types";

export class FeedManager {
  private feedEl: HTMLElement | null = null;
  private scrollBtn: HTMLElement | null = null;

  // State tracking
  private eventIds = new Set<string>();
  private pendingItems = new Map<string, HTMLElement>();
  private completedData = new Map<
    string,
    { success: boolean; duration?: number; response?: Record<string, unknown> }
  >();
  private activeFilter: string | null = null;

  // Working directory for shortening paths
  private cwd: string = "";

  // Thinking indicator per session
  private thinkingIndicators = new Map<string, HTMLElement>();

  // Track assistant text to avoid duplicates in parallel tool calls
  private lastAssistantText: string | null = null;
  private lastAssistantTextTime = 0;
  private readonly ASSISTANT_TEXT_DEDUP_WINDOW = 2000; // ms

  // Scrollbar auto-hide
  private scrollHideTimer: ReturnType<typeof setTimeout> | null = null;

  // Animation stagger for rapid-fire additions
  private lastAddTime = 0;
  private batchIndex = 0;

  constructor() {
    this.feedEl = document.getElementById("activity-feed");
    this.scrollBtn = document.getElementById("feed-scroll-bottom");
  }

  /**
   * Set the working directory for path shortening
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Shorten a file path by removing the working directory prefix
   */
  private shortenPath(path: string): string {
    if (!this.cwd || !path) return path;
    // Normalize: remove trailing slash from cwd
    const cwdNorm = this.cwd.endsWith("/") ? this.cwd.slice(0, -1) : this.cwd;
    if (path.startsWith(cwdNorm + "/")) {
      return path.slice(cwdNorm.length + 1); // +1 for the slash
    }
    return path;
  }

  /**
   * Setup scroll button behavior (call once during init)
   */
  setupScrollButton(): void {
    if (!this.feedEl || !this.scrollBtn) return;

    // Update button visibility on scroll + auto-hide scrollbar
    this.feedEl.addEventListener("scroll", () => {
      this.updateScrollButton();
      // Show scrollbar on scroll, hide after 1.5s of inactivity
      this.feedEl!.classList.add("scrolling");
      if (this.scrollHideTimer) clearTimeout(this.scrollHideTimer);
      this.scrollHideTimer = setTimeout(() => {
        this.feedEl!.classList.remove("scrolling");
      }, 1500);
    });

    // Click to scroll to bottom
    this.scrollBtn.addEventListener("click", () => this.scrollToBottom());
  }

  /**
   * Filter feed items by session ID
   */
  setFilter(sessionId: string | null): void {
    if (!this.feedEl) return;

    this.activeFilter = sessionId;

    this.feedEl.querySelectorAll(".feed-item").forEach((item) => {
      const itemEl = item as HTMLElement;
      const itemSession = itemEl.dataset.sessionId;

      // Show all if no filter, or show matching session
      const shouldShow = sessionId === null || itemSession === sessionId;

      if (!shouldShow && itemEl.style.display !== "none") {
        // Animate out then hide
        itemEl.classList.add("exiting");
        itemEl.addEventListener(
          "animationend",
          () => {
            itemEl.style.display = "none";
            itemEl.classList.remove("exiting");
          },
          { once: true },
        );
      } else if (shouldShow && itemEl.style.display === "none") {
        // Show with entrance animation
        itemEl.style.display = "";
        itemEl.style.animation = "none";
        // Force reflow to restart animation
        void itemEl.offsetHeight;
        itemEl.style.animation = "";
      } else if (!shouldShow) {
        itemEl.style.display = "none";
      }
    });

    // Auto-scroll to bottom when switching sessions
    this.scrollToBottom();
  }

  /**
   * Scroll feed to bottom (deferred to next frame for accurate scrollHeight)
   */
  scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this.feedEl) {
        this.feedEl.scrollTop = this.feedEl.scrollHeight;
      }
    });
  }

  /**
   * Check if feed is scrolled near the bottom
   */
  isNearBottom(): boolean {
    if (!this.feedEl) return true;
    const threshold = 100;
    return (
      this.feedEl.scrollHeight -
        this.feedEl.scrollTop -
        this.feedEl.clientHeight <
      threshold
    );
  }

  /**
   * Update scroll button visibility
   */
  private updateScrollButton(): void {
    if (!this.scrollBtn) return;
    this.scrollBtn.classList.toggle("visible", !this.isNearBottom());
  }

  /**
   * Show a "thinking" indicator for a session
   */
  showThinking(sessionId: string, sessionColor?: number): void {
    if (!this.feedEl) return;

    // Don't show duplicate thinking indicators
    if (this.thinkingIndicators.has(sessionId)) return;

    this.removeEmptyState();

    const item = document.createElement("div");
    item.className = "feed-item thinking-indicator";
    item.dataset.sessionId = sessionId;

    // Apply session color as left border
    if (sessionColor !== undefined) {
      item.style.borderLeftColor = `#${sessionColor.toString(16).padStart(6, "0")}`;
      item.style.borderLeftWidth = "3px";
      item.style.borderLeftStyle = "solid";
    }

    item.innerHTML = `
      <div class="feed-item-header">
        <div class="feed-item-icon thinking-icon">🤔</div>
        <div class="feed-item-title">Claude is thinking</div>
        <div class="thinking-dots"><span>.</span><span>.</span><span>.</span></div>
      </div>
    `;

    this.thinkingIndicators.set(sessionId, item);
    this.feedEl.appendChild(item);

    // Apply filter
    if (this.activeFilter !== null && sessionId !== this.activeFilter) {
      item.style.display = "none";
    } else {
      this.scrollToBottom();
    }
  }

  /**
   * Hide the thinking indicator for a session (or all sessions)
   */
  hideThinking(sessionId?: string): void {
    if (sessionId) {
      const indicator = this.thinkingIndicators.get(sessionId);
      if (indicator) {
        indicator.remove();
        this.thinkingIndicators.delete(sessionId);
      }
    } else {
      // Remove all thinking indicators
      for (const indicator of this.thinkingIndicators.values()) {
        indicator.remove();
      }
      this.thinkingIndicators.clear();
    }
  }

  /**
   * Remove the empty state placeholder
   */
  private removeEmptyState(): void {
    const empty = document.getElementById("feed-empty");
    if (empty) {
      empty.remove();
    }
  }

  /**
   * Add an event to the feed
   */
  add(event: ClaudeEvent, sessionColor?: number): void {
    if (!this.feedEl) return;

    // Skip duplicates
    if (this.eventIds.has(event.id)) {
      return;
    }
    this.eventIds.add(event.id);

    this.removeEmptyState();

    const item = document.createElement("div");
    item.className = "feed-item";
    item.dataset.eventId = event.id;
    item.dataset.sessionId = event.sessionId;

    // Apply session color as left border
    if (sessionColor !== undefined) {
      item.style.borderLeftColor = `#${sessionColor.toString(16).padStart(6, "0")}`;
      item.style.borderLeftWidth = "3px";
      item.style.borderLeftStyle = "solid";
    }

    switch (event.type) {
      case "user_prompt_submit": {
        const e = event as { prompt?: string; timestamp: number };
        const promptText = e.prompt ?? "";

        // Skip duplicate prompts
        const lastPrompt = this.feedEl.querySelector(
          ".feed-item.user-prompt:last-of-type",
        ) as HTMLElement | null;
        if (lastPrompt) {
          const lastText =
            lastPrompt.querySelector(".prompt-text")?.textContent ?? "";
          if (promptText === lastText) return;
        }

        item.classList.add("user-prompt");
        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">💬</div>
            <div class="feed-item-title">You</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
          <div class="feed-item-content prompt-text">${escapeHtml(promptText)}</div>
        `;
        break;
      }

      case "pre_tool_use": {
        const e = event as PreToolUseEvent;

        // Skip if we already have an item for this toolUseId
        if (this.feedEl.querySelector(`[data-tool-use-id="${e.toolUseId}"]`)) {
          return;
        }

        item.classList.add("tool-use", "tool-pending");
        item.dataset.toolUseId = e.toolUseId;

        const input = e.toolInput as Record<string, unknown>;
        const filePath =
          (input.file_path as string) ?? (input.path as string) ?? "";
        const command = (input.command as string) ?? "";
        const content =
          (input.content as string) ?? (input.new_string as string) ?? "";
        const pattern = (input.pattern as string) ?? "";
        const query = (input.query as string) ?? "";

        // Check if this is an MCP tool with no useful preview - make it compact
        const hasPreview = filePath || command || content || pattern || query;
        if (!hasPreview) {
          item.classList.add("compact");
        }

        let preview = "";
        if (filePath) {
          preview = `<div class="feed-item-file">${escapeHtml(this.shortenPath(filePath))}</div>`;
        } else if (command) {
          preview = `<div class="feed-item-code">${escapeHtml(command)}</div>`;
        } else if (pattern) {
          preview = `<div class="feed-item-file">Pattern: ${escapeHtml(pattern)}</div>`;
        } else if (query) {
          preview = `<div class="feed-item-file">Query: ${escapeHtml(query.slice(0, 100))}</div>`;
        }

        let details = "";
        if (content) {
          const truncated =
            content.length > 500 ? content.slice(0, 500) + "..." : content;
          details = `
            <div class="feed-item-details collapsed" id="details-${e.toolUseId}">
              <div class="feed-item-code">${escapeHtml(truncated)}</div>
            </div>
            <div class="expand-toggle" data-target="details-${e.toolUseId}">▶ Show content</div>
          `;
        }

        // Show assistant text if present (text Claude wrote before tool call)
        // Deduplicate: parallel tool calls share the same text, only show once
        let assistantTextHtml = "";
        if (e.assistantText && e.assistantText.trim()) {
          const now = Date.now();
          const isDuplicate =
            this.lastAssistantText === e.assistantText &&
            now - this.lastAssistantTextTime < this.ASSISTANT_TEXT_DEDUP_WINDOW;

          if (!isDuplicate) {
            this.lastAssistantText = e.assistantText;
            this.lastAssistantTextTime = now;

            const isLong = e.assistantText.length > 400;
            const textContent = renderMarkdown(e.assistantText);
            assistantTextHtml = `
              <div class="feed-item-assistant-text ${isLong ? "collapsed" : ""}" id="assistant-text-${e.toolUseId}">
                ${textContent}
              </div>
              ${isLong ? `<div class="expand-toggle" data-target="assistant-text-${e.toolUseId}">▶ Show more</div>` : ""}
            `;
          }
        }

        item.innerHTML = `
          ${assistantTextHtml}
          <div class="feed-item-header">
            <div class="feed-item-icon">${getToolIcon(e.tool)}</div>
            <div class="feed-item-title">${e.tool}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
          ${preview}
          ${details}
        `;

        // Check if completion data already arrived
        const completionData = this.completedData.get(e.toolUseId);
        if (completionData) {
          // Immediately mark as complete
          item.classList.remove("tool-pending");
          item.classList.add(
            completionData.success ? "tool-success" : "tool-fail",
          );
          if (completionData.duration) {
            const header = item.querySelector(".feed-item-header");
            if (header) {
              const durationBadge = document.createElement("div");
              durationBadge.className = "feed-item-duration";
              durationBadge.textContent = `${completionData.duration}ms`;
              header.appendChild(durationBadge);
            }
          }
          // Add response preview if available
          if (completionData.response) {
            const responsePreview = this.createResponsePreview(
              e.tool,
              completionData.success,
              completionData.response,
            );
            if (responsePreview) {
              item.insertAdjacentHTML("beforeend", responsePreview);
            }
          }
          this.completedData.delete(e.toolUseId);
        } else {
          this.pendingItems.set(e.toolUseId, item);
        }
        break;
      }

      case "post_tool_use": {
        const e = event as PostToolUseEvent;
        const existing = this.pendingItems.get(e.toolUseId);

        if (existing) {
          // Update existing item
          existing.classList.remove("tool-pending");
          existing.classList.add(e.success ? "tool-success" : "tool-fail");

          // Add duration badge
          const header = existing.querySelector(".feed-item-header");
          if (header && e.duration) {
            const durationBadge = document.createElement("div");
            durationBadge.className = "feed-item-duration";
            durationBadge.textContent = `${e.duration}ms`;
            header.appendChild(durationBadge);
          }

          // Add tool response preview
          const response = e.toolResponse as Record<string, unknown>;
          const responsePreview = this.createResponsePreview(
            e.tool,
            e.success,
            response,
          );
          if (responsePreview) {
            existing.insertAdjacentHTML("beforeend", responsePreview);
          }

          this.pendingItems.delete(e.toolUseId);
        } else {
          // No pending item yet - store completion data for when pre_tool_use arrives
          this.completedData.set(e.toolUseId, {
            success: e.success,
            duration: e.duration,
            response: e.toolResponse,
          });
        }
        return; // Never create standalone "Completed" items
      }

      case "stop": {
        const e = event as { response?: string; timestamp: number };
        const response = e.response?.trim() || "";

        // Skip duplicate responses
        if (response) {
          const lastResponse = this.feedEl.querySelector(
            ".feed-item.assistant-response:last-of-type .assistant-text",
          );
          if (
            lastResponse &&
            response.slice(0, 100) ===
              (lastResponse.textContent || "").slice(0, 100)
          ) {
            return;
          }
        }

        // If we have a response, show it as Claude's message
        if (response) {
          item.classList.add("assistant-response");
          const isLong = response.length > 2000;
          const displayResponse = isLong ? response.slice(0, 2000) : response;
          item.innerHTML = `
            <div class="feed-item-header">
              <div class="feed-item-icon">🤖</div>
              <div class="feed-item-title">Claude</div>
              <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
            </div>
            <div class="feed-item-content assistant-text">${renderMarkdown(displayResponse)}${isLong ? '<span class="show-more">... [show more - Alt+E]</span>' : ""}</div>
          `;
          // Add click handler for "show more"
          if (isLong) {
            const showMore = item.querySelector(".show-more");
            if (showMore) {
              showMore.addEventListener("click", () => {
                const textEl = item.querySelector(".assistant-text");
                if (textEl) {
                  textEl.innerHTML = renderMarkdown(response);
                }
              });
            }
          }
        } else {
          // No response - compact stop indicator
          item.classList.add("lifecycle", "compact");
          item.innerHTML = `
            <div class="feed-item-header">
              <div class="feed-item-icon">🏁</div>
              <div class="feed-item-title">Stopped</div>
              <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
            </div>
          `;
        }
        break;
      }

      default:
        return; // Don't add unknown events to feed
    }

    // Check scroll position BEFORE adding item (so isNearBottom is accurate)
    const shouldScroll =
      event.type === "user_prompt_submit" || this.isNearBottom();

    // Stagger animation for rapid-fire additions
    const now = Date.now();
    if (now - this.lastAddTime < 200) {
      this.batchIndex++;
    } else {
      this.batchIndex = 0;
    }
    this.lastAddTime = now;
    if (this.batchIndex > 0) {
      item.style.animationDelay = `${this.batchIndex * 30}ms`;
    }

    this.feedEl.appendChild(item);

    // Apply active filter - hide item if it doesn't match
    if (this.activeFilter !== null && event.sessionId !== this.activeFilter) {
      item.style.display = "none";
    } else if (shouldScroll) {
      // Defer scroll to next frame so browser can calculate new scrollHeight
      requestAnimationFrame(() => {
        if (this.feedEl) {
          this.feedEl.scrollTop = this.feedEl.scrollHeight;
        }
      });
    }

    // Update scroll button visibility
    this.updateScrollButton();

    // Add click handler for expand toggles
    item.querySelectorAll(".expand-toggle").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const targetId = (toggle as HTMLElement).dataset.target;
        if (!targetId) return;
        const details = document.getElementById(targetId);
        if (details) {
          const isCollapsed = details.classList.toggle("collapsed");
          toggle.textContent = isCollapsed
            ? "▶ Show content"
            : "▼ Hide content";
        }
      });
    });
  }

  /**
   * Create HTML for tool response preview
   */
  private createResponsePreview(
    tool: string,
    success: boolean,
    response: Record<string, unknown>,
  ): string {
    if (tool === "Bash" && response.output) {
      const output = String(response.output).slice(0, 300);
      if (output.trim()) {
        return `<div class="feed-item-response"><div class="feed-item-code">${escapeHtml(output)}</div></div>`;
      }
    } else if ((tool === "Grep" || tool === "Glob") && response.result) {
      const lines = String(response.result).split("\n").slice(0, 5).join("\n");
      if (lines.trim()) {
        return `<div class="feed-item-response"><div class="feed-item-code">${escapeHtml(lines)}</div></div>`;
      }
    } else if (!success && response.error) {
      return `<div class="feed-item-response error"><div class="feed-item-error">${escapeHtml(String(response.error).slice(0, 200))}</div></div>`;
    }
    return "";
  }
}

// ============================================================================
// Helper Functions (pure, stateless)
// ============================================================================

/**
 * Format token count with human-readable suffixes
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k tok`;
  }
  return `${tokens} tok`;
}

/**
 * Format timestamp as relative time
 */
export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Simple markdown to HTML for responses
 */
export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>");

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold (**...** or __...__)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic (*... or _...)
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Headers (## ...)
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Bullet lists (- ... or * ...)
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  // Clean up extra breaks in code blocks
  html = html.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (match, code) => {
      return "<pre><code>" + code.replace(/<br>/g, "\n") + "</code></pre>";
    },
  );

  return html;
}
