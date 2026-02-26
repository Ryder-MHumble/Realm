/**
 * FeedManager - Manages the activity feed panel (AI-native conversation layout)
 *
 * Handles:
 * - Grouping events into conversation turns (user prompt → tool chain → response)
 * - Compact tool chain rendering (click to expand)
 * - Chat-bubble style for prompts and responses
 * - Filtering by session
 * - Auto-scroll behavior
 * - Scroll-to-bottom button
 */

import { getToolIcon } from "../utils/ToolUtils";
import { t } from "../i18n";
import type {
  ClaudeEvent,
  PreToolUseEvent,
  PostToolUseEvent,
  SessionStartEvent,
  SessionEndEvent,
  PreCompactEvent,
  NotificationEvent,
} from "../../shared/types";

/** Max visible tool chain items before auto-collapse */
const TOOL_CHAIN_COLLAPSE_THRESHOLD = 5;

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

  // Track cumulative assistant text per turn for delta computation
  private currentTurnCumulativeText = "";

  // Scrollbar auto-hide
  private scrollHideTimer: ReturnType<typeof setTimeout> | null = null;

  // Animation stagger for rapid-fire additions
  private lastAddTime = 0;
  private batchIndex = 0;

  // Turn grouping state
  private currentTurnGroup: HTMLElement | null = null;
  private currentTurnSessionId: string | null = null;
  private currentToolChain: HTMLElement | null = null;
  private toolChainItemCount = 0;
  private toolChainCollapsed = false;

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
    const cwdNorm = this.cwd.endsWith("/") ? this.cwd.slice(0, -1) : this.cwd;
    if (path.startsWith(cwdNorm + "/")) {
      return path.slice(cwdNorm.length + 1);
    }
    return path;
  }

  /**
   * Setup scroll button behavior (call once during init)
   */
  setupScrollButton(): void {
    if (!this.feedEl || !this.scrollBtn) return;

    this.feedEl.addEventListener("scroll", () => {
      this.updateScrollButton();
      this.feedEl!.classList.add("scrolling");
      if (this.scrollHideTimer) clearTimeout(this.scrollHideTimer);
      this.scrollHideTimer = setTimeout(() => {
        this.feedEl!.classList.remove("scrolling");
      }, 1500);
    });

    this.scrollBtn.addEventListener("click", () => this.scrollToBottom());
  }

  /**
   * Get current filter session ID
   */
  getFilter(): string | null {
    return this.activeFilter;
  }

  /**
   * Filter feed items by session ID — operates on turn-groups and standalone items
   */
  setFilter(sessionId: string | null): void {
    if (!this.feedEl) return;

    this.activeFilter = sessionId;

    // Filter turn-groups
    this.feedEl.querySelectorAll(".turn-group").forEach((group) => {
      const groupEl = group as HTMLElement;
      const groupSession = groupEl.dataset.sessionId;
      const shouldShow = sessionId === null || groupSession === sessionId;

      if (!shouldShow) {
        groupEl.style.display = "none";
      } else if (groupEl.style.display === "none") {
        groupEl.style.display = "";
        groupEl.style.animation = "none";
        void groupEl.offsetHeight;
        groupEl.style.animation = "";
      }
    });

    // Also filter standalone items (backward compat)
    this.feedEl
      .querySelectorAll(".feed-item:not(.turn-group .feed-item)")
      .forEach((item) => {
        const itemEl = item as HTMLElement;
        const itemSession = itemEl.dataset.sessionId;
        const shouldShow = sessionId === null || itemSession === sessionId;

        if (!shouldShow) {
          itemEl.style.display = "none";
          itemEl.classList.remove("exiting");
        } else if (itemEl.style.display === "none") {
          itemEl.style.display = "";
          itemEl.style.animation = "none";
          void itemEl.offsetHeight;
          itemEl.style.animation = "";
        }
      });

    this.scrollToBottom();
  }

  /**
   * Scroll feed to bottom
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
   * Ensure a turn group container exists for the given session
   */
  private ensureTurnGroup(sessionId: string): HTMLElement {
    if (this.currentTurnGroup && this.currentTurnSessionId === sessionId) {
      return this.currentTurnGroup;
    }

    // Create a new turn group
    const group = document.createElement("div");
    group.className = "turn-group active";
    group.dataset.sessionId = sessionId;

    this.currentTurnGroup = group;
    this.currentTurnSessionId = sessionId;
    this.currentToolChain = null;
    this.toolChainItemCount = 0;
    this.toolChainCollapsed = false;
    this.currentTurnCumulativeText = "";

    this.feedEl!.appendChild(group);

    // Apply filter
    if (this.activeFilter !== null && sessionId !== this.activeFilter) {
      group.style.display = "none";
    }

    return group;
  }

  /**
   * Ensure a tool chain container exists in the current turn group
   */
  private ensureToolChain(sessionId: string): HTMLElement {
    const group = this.ensureTurnGroup(sessionId);

    if (this.currentToolChain) {
      return this.currentToolChain;
    }

    const chain = document.createElement("div");
    chain.className = "tool-chain";
    group.appendChild(chain);

    this.currentToolChain = chain;
    this.toolChainItemCount = 0;
    this.toolChainCollapsed = false;

    return chain;
  }

  /**
   * Clear all feed content (used when /clear is executed)
   */
  clearFeed(): void {
    if (!this.feedEl) return;
    this.feedEl.innerHTML = "";
    this.eventIds.clear();
    this.pendingItems.clear();
    this.completedData.clear();
    this.closeTurnGroup();
    this.thinkingIndicators.clear();
    this.currentTurnCumulativeText = "";
  }

  /**
   * Close the current turn group (marks it as inactive)
   */
  private closeTurnGroup(): void {
    if (this.currentTurnGroup) {
      this.currentTurnGroup.classList.remove("active");
    }
    this.currentTurnGroup = null;
    this.currentTurnSessionId = null;
    this.currentToolChain = null;
    this.toolChainItemCount = 0;
    this.toolChainCollapsed = false;
    this.currentTurnCumulativeText = "";
  }

  /**
   * Compute delta text when fullText is not a simple prefix extension.
   * Finds longest common prefix and returns the remainder.
   */
  private computeFuzzyDelta(previousText: string, fullText: string): string {
    let commonLen = 0;
    const minLen = Math.min(previousText.length, fullText.length);
    for (let i = 0; i < minLen; i++) {
      if (previousText[i] === fullText[i]) {
        commonLen = i + 1;
      } else {
        break;
      }
    }

    if (commonLen > previousText.length * 0.5) {
      return fullText.slice(commonLen).trim();
    }

    // Texts diverged significantly — show full new text
    return fullText;
  }

  /**
   * Show a "thinking" indicator for a session
   */
  showThinking(sessionId: string, _sessionColor?: number): void {
    if (!this.feedEl) return;
    if (this.thinkingIndicators.has(sessionId)) return;

    this.removeEmptyState();

    const group = this.ensureTurnGroup(sessionId);

    const item = document.createElement("div");
    item.className = "feed-item thinking-indicator";
    item.dataset.sessionId = sessionId;

    item.innerHTML = `
      <div class="feed-item-header">
        <div class="feed-item-icon thinking-icon">🤔</div>
        <div class="feed-item-title">${t("feed.thinking")}</div>
        <div class="thinking-dots"><span>.</span><span>.</span><span>.</span></div>
      </div>
    `;

    this.thinkingIndicators.set(sessionId, item);
    group.appendChild(item);

    if (this.activeFilter !== null && sessionId !== this.activeFilter) {
      // Already handled by turn group visibility
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
   * Create a compact tool chain item element
   */
  private createCompactToolItem(
    e: PreToolUseEvent,
    event: ClaudeEvent,
  ): HTMLElement {
    const item = document.createElement("div");
    item.className = "tool-chain-item pending";
    item.dataset.toolUseId = e.toolUseId;
    item.dataset.sessionId = event.sessionId;
    item.dataset.eventId = event.id;

    const input = e.toolInput as Record<string, unknown>;
    const filePath =
      (input.file_path as string) ?? (input.path as string) ?? "";
    const command = (input.command as string) ?? "";
    const pattern = (input.pattern as string) ?? "";
    const query = (input.query as string) ?? "";
    const shortFile = this.shortenPath(filePath);

    // Pick the best preview text
    let previewText = "";
    if (shortFile) {
      previewText = shortFile;
    } else if (command) {
      previewText = command.split("\n")[0].slice(0, 60);
    } else if (pattern) {
      previewText = pattern;
    } else if (query) {
      previewText = query.slice(0, 50);
    }

    item.innerHTML = `
      <span class="tool-icon">${getToolIcon(e.tool)}</span>
      <span class="tool-name">${escapeHtml(e.tool)}</span>
      <span class="tool-file">${escapeHtml(previewText)}</span>
      <span class="tool-duration"></span>
    `;

    // Click to toggle detail panel
    item.addEventListener("click", () => {
      const existing = item.nextElementSibling;
      if (existing?.classList.contains("tool-chain-detail")) {
        existing.remove();
      } else {
        const detail = document.createElement("div");
        detail.className = "tool-chain-detail";
        detail.innerHTML = this.createToolDetailHTML(e);
        item.after(detail);
      }
    });

    return item;
  }

  /**
   * Create HTML for tool detail panel (shown when clicking a compact tool item)
   */
  private createToolDetailHTML(e: PreToolUseEvent): string {
    const input = e.toolInput as Record<string, unknown>;
    const filePath =
      (input.file_path as string) ?? (input.path as string) ?? "";
    const command = (input.command as string) ?? "";
    const content =
      (input.content as string) ?? (input.new_string as string) ?? "";
    const pattern = (input.pattern as string) ?? "";
    const query = (input.query as string) ?? "";

    const parts: string[] = [];

    if (filePath) {
      parts.push(
        `<div class="feed-item-file">${escapeHtml(this.shortenPath(filePath))}</div>`,
      );
    }
    if (command) {
      parts.push(
        `<div class="feed-item-code">${escapeHtml(command.slice(0, 300))}</div>`,
      );
    }
    if (content) {
      parts.push(
        `<div class="feed-item-code">${escapeHtml(content.slice(0, 300))}</div>`,
      );
    }
    if (pattern) {
      parts.push(
        `<div class="feed-item-file">${t("feed.pattern", { pattern: escapeHtml(pattern) })}</div>`,
      );
    }
    if (query) {
      parts.push(
        `<div class="feed-item-file">${t("feed.query", { query: escapeHtml(query.slice(0, 200)) })}</div>`,
      );
    }

    return (
      parts.join("") ||
      `<div class="feed-item-file">${t("feed.noDetails")}</div>`
    );
  }

  /**
   * Add an event to the feed
   */
  add(event: ClaudeEvent, _sessionColor?: number): void {
    if (!this.feedEl) return;

    // Skip duplicates
    if (this.eventIds.has(event.id)) {
      return;
    }
    this.eventIds.add(event.id);

    this.removeEmptyState();

    // Check scroll position BEFORE adding
    const shouldScroll =
      event.type === "user_prompt_submit" || this.isNearBottom();

    switch (event.type) {
      case "user_prompt_submit": {
        const e = event as { prompt?: string; timestamp: number };
        const promptText = e.prompt ?? "";

        // Skip duplicate prompts
        const allPrompts = this.feedEl.querySelectorAll(
          ".feed-item.user-prompt",
        );
        const lastPrompt =
          allPrompts.length > 0
            ? (allPrompts[allPrompts.length - 1] as HTMLElement)
            : null;
        if (lastPrompt) {
          const lastText =
            lastPrompt.querySelector(".prompt-text")?.textContent ?? "";
          const lastSession = lastPrompt.dataset.sessionId;
          if (promptText === lastText && lastSession === event.sessionId)
            return;
        }

        // Start a new turn group for each user prompt
        this.closeTurnGroup();
        const group = this.ensureTurnGroup(event.sessionId);

        const item = document.createElement("div");
        item.className = "feed-item user-prompt";
        item.dataset.eventId = event.id;
        item.dataset.sessionId = event.sessionId;
        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">💬</div>
            <div class="feed-item-title">${t("feed.you")}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
          <div class="feed-item-content prompt-text">${escapeHtml(promptText)}</div>
        `;
        group.appendChild(item);
        break;
      }

      case "pre_tool_use": {
        const e = event as PreToolUseEvent;

        // Skip if we already have an item for this toolUseId
        if (this.feedEl.querySelector(`[data-tool-use-id="${e.toolUseId}"]`)) {
          return;
        }

        // Show assistant text delta inline in tool chain
        if (e.assistantText && e.assistantText.trim()) {
          const fullText = e.assistantText.trim();
          const previousText = this.currentTurnCumulativeText;

          let deltaText = "";
          if (!previousText) {
            deltaText = fullText;
          } else if (fullText === previousText) {
            deltaText = "";
          } else if (fullText.startsWith(previousText)) {
            deltaText = fullText.slice(previousText.length).trim();
          } else {
            deltaText = this.computeFuzzyDelta(previousText, fullText);
          }

          if (deltaText) {
            this.currentTurnCumulativeText = fullText;

            const chain = this.ensureToolChain(event.sessionId);
            const textEl = document.createElement("div");
            textEl.className = "tool-chain-text";
            const isLong = deltaText.length > 300;
            if (isLong) {
              textEl.classList.add("collapsed");
            }
            textEl.innerHTML = renderMarkdown(deltaText);

            if (isLong) {
              const toggle = document.createElement("span");
              toggle.className = "tool-chain-text-toggle";
              toggle.textContent = `... ${t("feed.showDetails")}`;
              toggle.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const wasCollapsed = textEl.classList.toggle("collapsed");
                toggle.textContent = wasCollapsed
                  ? `... ${t("feed.showDetails")}`
                  : t("feed.hideDetails");
              });
              textEl.appendChild(toggle);
            }

            if (this.toolChainCollapsed) {
              textEl.style.display = "none";
              chain.insertBefore(
                textEl,
                chain.querySelector(".tool-chain-summary"),
              );
            } else {
              chain.appendChild(textEl);
            }
          }
        }

        // Add compact tool chain item
        const chain = this.ensureToolChain(event.sessionId);
        this.toolChainItemCount++;

        const compactItem = this.createCompactToolItem(e, event);

        // Auto-collapse after threshold
        if (
          this.toolChainItemCount > TOOL_CHAIN_COLLAPSE_THRESHOLD &&
          !this.toolChainCollapsed
        ) {
          this.toolChainCollapsed = true;
          const summary = document.createElement("div");
          summary.className = "tool-chain-summary";
          summary.innerHTML = `<span>▶</span> ${t("feed.moreTools", { n: this.toolChainItemCount - TOOL_CHAIN_COLLAPSE_THRESHOLD })}`;

          // Hide items and inline text beyond threshold
          const children = chain.querySelectorAll(
            ".tool-chain-item, .tool-chain-text",
          );
          let toolCount = 0;
          for (const child of children) {
            if (child.classList.contains("tool-chain-item")) {
              toolCount++;
            }
            if (toolCount > TOOL_CHAIN_COLLAPSE_THRESHOLD) {
              (child as HTMLElement).style.display = "none";
            }
          }

          chain.appendChild(summary);

          summary.addEventListener("click", () => {
            chain
              .querySelectorAll(".tool-chain-item, .tool-chain-text")
              .forEach((el) => {
                (el as HTMLElement).style.display = "";
              });
            summary.remove();
          });
        }

        if (this.toolChainCollapsed) {
          compactItem.style.display = "none";
          chain.insertBefore(
            compactItem,
            chain.querySelector(".tool-chain-summary"),
          );
          const summary = chain.querySelector(".tool-chain-summary");
          if (summary) {
            summary.innerHTML = `<span>▶</span> ${t("feed.moreTools", { n: this.toolChainItemCount - TOOL_CHAIN_COLLAPSE_THRESHOLD })}`;
            summary.addEventListener("click", () => {
              chain
                .querySelectorAll(".tool-chain-item, .tool-chain-text")
                .forEach((el) => {
                  (el as HTMLElement).style.display = "";
                });
              summary.remove();
            });
          }
        } else {
          chain.appendChild(compactItem);
        }

        // Check if completion data already arrived
        const completionData = this.completedData.get(e.toolUseId);
        if (completionData) {
          compactItem.classList.remove("pending");
          compactItem.classList.add(
            completionData.success ? "success" : "fail",
          );
          if (completionData.duration) {
            const durationEl = compactItem.querySelector(".tool-duration");
            if (durationEl) {
              durationEl.textContent = `${completionData.duration}ms`;
            }
          }
          this.completedData.delete(e.toolUseId);
        } else {
          this.pendingItems.set(e.toolUseId, compactItem);
        }
        break;
      }

      case "post_tool_use": {
        const e = event as PostToolUseEvent;
        const existing = this.pendingItems.get(e.toolUseId);

        if (existing) {
          existing.classList.remove("pending");
          existing.classList.add(e.success ? "success" : "fail");

          // Update duration
          if (e.duration) {
            const durationEl = existing.querySelector(".tool-duration");
            if (durationEl) {
              durationEl.textContent = `${e.duration}ms`;
            }
          }

          this.pendingItems.delete(e.toolUseId);
        } else {
          // Store for when pre_tool_use arrives
          this.completedData.set(e.toolUseId, {
            success: e.success,
            duration: e.duration,
            response: e.toolResponse,
          });
        }
        return; // Don't create standalone items
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

        if (response) {
          const group = this.ensureTurnGroup(event.sessionId);

          const item = document.createElement("div");
          item.className = "feed-item assistant-response";
          item.dataset.eventId = event.id;
          item.dataset.sessionId = event.sessionId;

          const isLong = response.length > 2000;
          const displayResponse = isLong ? response.slice(0, 2000) : response;
          item.innerHTML = `
            <div class="feed-item-header">
              <div class="feed-item-icon">🤖</div>
              <div class="feed-item-title">${t("feed.claude")}</div>
              <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
            </div>
            <div class="feed-item-content assistant-text">${renderMarkdown(displayResponse)}${isLong ? `<span class="show-more">${t("feed.showMore")}</span>` : ""}</div>
          `;

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

          group.appendChild(item);
        } else {
          // No response — compact stop indicator
          const group = this.ensureTurnGroup(event.sessionId);
          const item = document.createElement("div");
          item.className = "feed-item lifecycle compact";
          item.dataset.eventId = event.id;
          item.dataset.sessionId = event.sessionId;
          item.innerHTML = `
            <div class="feed-item-header">
              <div class="feed-item-icon">🏁</div>
              <div class="feed-item-title">${t("feed.stopped")}</div>
              <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
            </div>
          `;
          group.appendChild(item);
        }

        // Close the turn group
        this.closeTurnGroup();
        break;
      }

      case "session_end": {
        const e = event as SessionEndEvent;

        this.closeTurnGroup();

        if (e.reason === "clear") {
          this.clearFeed();
        }

        const item = document.createElement("div");
        item.className = "feed-item lifecycle compact";
        item.dataset.eventId = event.id;
        item.dataset.sessionId = event.sessionId;

        const reasonLabels: Record<string, string> = {
          clear: t("feed.sessionCleared"),
          logout: t("feed.sessionLogout"),
          prompt_input_exit: t("feed.sessionExited"),
          other: t("feed.sessionEnded"),
        };
        const label = reasonLabels[e.reason] || reasonLabels.other;
        const icon = e.reason === "clear" ? "🧹" : "👋";

        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">${icon}</div>
            <div class="feed-item-title">${label}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
        `;
        this.feedEl!.appendChild(item);
        break;
      }

      case "session_start": {
        const e = event as SessionStartEvent;

        this.closeTurnGroup();

        const item = document.createElement("div");
        item.className = "feed-item lifecycle compact";
        item.dataset.eventId = event.id;
        item.dataset.sessionId = event.sessionId;

        const sourceLabels: Record<string, string> = {
          startup: t("feed.sessionStarted"),
          resume: t("feed.sessionResumed"),
          clear: t("feed.sessionRestarted"),
          compact: t("feed.sessionCompacted"),
        };
        const label = sourceLabels[e.source] || sourceLabels.startup;
        const icon = e.source === "compact" ? "📦" : "🚀";

        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">${icon}</div>
            <div class="feed-item-title">${label}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
        `;
        this.feedEl!.appendChild(item);
        break;
      }

      case "pre_compact": {
        const e = event as PreCompactEvent;

        const item = document.createElement("div");
        item.className = "feed-item lifecycle compact";
        item.dataset.eventId = event.id;
        item.dataset.sessionId = event.sessionId;

        const label =
          e.trigger === "auto"
            ? t("feed.compactAuto")
            : t("feed.compactManual");

        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">📦</div>
            <div class="feed-item-title">${label}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
        `;

        if (
          this.currentTurnGroup &&
          this.currentTurnSessionId === event.sessionId
        ) {
          this.currentTurnGroup.appendChild(item);
        } else {
          this.feedEl!.appendChild(item);
        }
        break;
      }

      case "notification": {
        const e = event as NotificationEvent;

        if (
          !["auto_continue", "auto_continue_limit", "auto_compact"].includes(
            e.notificationType,
          )
        ) {
          return;
        }

        const item = document.createElement("div");
        item.className = "feed-item lifecycle compact";
        item.dataset.eventId = event.id;
        item.dataset.sessionId = event.sessionId;

        let icon = "⚙️";
        let label = e.message;
        if (e.notificationType === "auto_continue") {
          icon = "🔄";
          label = t("feed.autoContinue");
        } else if (e.notificationType === "auto_continue_limit") {
          icon = "⚠️";
          label = t("feed.autoContinueMax");
        } else if (e.notificationType === "auto_compact") {
          icon = "📦";
          label = t("feed.compactAuto");
        }

        item.innerHTML = `
          <div class="feed-item-header">
            <div class="feed-item-icon">${icon}</div>
            <div class="feed-item-title">${label}</div>
            <div class="feed-item-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
          </div>
        `;

        if (
          this.currentTurnGroup &&
          this.currentTurnSessionId === event.sessionId
        ) {
          this.currentTurnGroup.appendChild(item);
        } else {
          this.feedEl!.appendChild(item);
        }
        break;
      }

      default:
        return;
    }

    // Stagger animation
    const now = Date.now();
    if (now - this.lastAddTime < 200) {
      this.batchIndex++;
    } else {
      this.batchIndex = 0;
    }
    this.lastAddTime = now;

    // Auto-scroll
    if (this.activeFilter === null || event.sessionId === this.activeFilter) {
      if (shouldScroll) {
        requestAnimationFrame(() => {
          if (this.feedEl) {
            this.feedEl.scrollTop = this.feedEl.scrollHeight;
          }
        });
      }
    }

    this.updateScrollButton();
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
    return t("time.tokM", { n: (tokens / 1_000_000).toFixed(1) });
  }
  if (tokens >= 1_000) {
    return t("time.tokK", { n: (tokens / 1_000).toFixed(1) });
  }
  return t("time.tok", { n: tokens });
}

/**
 * Format timestamp as relative time
 */
export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 30) return t("time.justNow");
  if (seconds < 60) return t("time.secondsAgo", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("time.daysAgo", { n: days });
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
