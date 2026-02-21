/**
 * IMChannel - Slack-like IM channel for AI agent communication
 *
 * Provides a team chat interface where AI agents post updates,
 * deliverables, and questions. Used for the Realm demo video
 * and eventually for real agent communication.
 */

import type { RealmRole } from "../../shared/types";
import { REALM_ROLES } from "../../shared/types";
import { escapeHtml, renderMarkdown } from "./FeedManager";

// ============================================================================
// Types
// ============================================================================

export type IMChannelId =
  | "general"
  | "engineering"
  | "marketing"
  | "design"
  | "analytics";

export type MessageType = "update" | "deliverable" | "question" | "system";

export interface IMAttachment {
  name: string;
  type: "file" | "image" | "link";
}

export interface IMMessage {
  id: string;
  channel: IMChannelId;
  role: RealmRole | "system";
  agentName: string;
  text: string;
  timestamp: number;
  type: MessageType;
  attachments?: IMAttachment[];
}

interface ChannelConfig {
  id: IMChannelId;
  label: string;
  icon: string;
  role?: RealmRole;
}

// ============================================================================
// Constants
// ============================================================================

const CHANNELS: ChannelConfig[] = [
  { id: "general", label: "general", icon: "#" },
  { id: "engineering", label: "engineering", icon: "#", role: "engineer" },
  { id: "marketing", label: "marketing", icon: "#", role: "marketer" },
  { id: "design", label: "design", icon: "#", role: "designer" },
  { id: "analytics", label: "analytics", icon: "#", role: "analyst" },
];

const ROLE_DISPLAY: Record<
  RealmRole | "system",
  { name: string; emoji: string; color: string }
> = {
  engineer: {
    name: "AI Engineer",
    emoji: "⚙️",
    color: `#${REALM_ROLES.engineer.accentColor.toString(16).padStart(6, "0")}`,
  },
  marketer: {
    name: "AI Marketer",
    emoji: "📢",
    color: `#${REALM_ROLES.marketer.accentColor.toString(16).padStart(6, "0")}`,
  },
  designer: {
    name: "AI Designer",
    emoji: "🎨",
    color: `#${REALM_ROLES.designer.accentColor.toString(16).padStart(6, "0")}`,
  },
  analyst: {
    name: "AI Analyst",
    emoji: "📊",
    color: `#${REALM_ROLES.analyst.accentColor.toString(16).padStart(6, "0")}`,
  },
  system: { name: "Realm", emoji: "🏰", color: "#a78bfa" },
};

// ============================================================================
// IMChannel Class
// ============================================================================

export class IMChannel {
  private wrapper: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private channelTabsEl: HTMLElement | null = null;
  private scrollBtn: HTMLElement | null = null;
  private activeChannel: IMChannelId = "general";
  private messages: IMMessage[] = [];
  private messageCounter = 0;
  private scrollHideTimer: ReturnType<typeof setTimeout> | null = null;

  // Animation stagger
  private lastAddTime = 0;
  private batchIndex = 0;

  constructor() {
    this.wrapper = document.getElementById("im-channel-wrapper");
    if (!this.wrapper) return;

    this.createUI();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Add a message to the IM channel
   */
  addMessage(msg: Omit<IMMessage, "id">): void {
    const fullMsg: IMMessage = {
      ...msg,
      id: `im-${++this.messageCounter}`,
    };
    this.messages.push(fullMsg);

    // Only render if message belongs to active channel or general
    if (
      fullMsg.channel === this.activeChannel ||
      this.activeChannel === "general"
    ) {
      this.renderMessage(fullMsg);
    }

    // Update unread indicators
    if (fullMsg.channel !== this.activeChannel) {
      this.updateUnreadIndicator(fullMsg.channel, true);
    }
  }

  /**
   * Switch to a specific channel
   */
  setChannel(channel: IMChannelId): void {
    this.activeChannel = channel;

    // Update tab styling
    this.channelTabsEl?.querySelectorAll(".im-channel-tab").forEach((tab) => {
      const tabEl = tab as HTMLElement;
      tabEl.classList.toggle("active", tabEl.dataset.channel === channel);
    });

    // Clear unread for this channel
    this.updateUnreadIndicator(channel, false);

    // Re-render messages for this channel
    this.renderAllMessages();
  }

  /**
   * Run the demo sequence for the video
   */
  async runDemoSequence(): Promise<void> {
    const messages = getDemoMessages();
    for (const msg of messages) {
      await delay(msg.delay);
      this.addMessage(msg.message);
    }
  }

  // --------------------------------------------------------------------------
  // UI Construction
  // --------------------------------------------------------------------------

  private createUI(): void {
    if (!this.wrapper) return;

    // Channel tabs
    this.channelTabsEl = document.createElement("div");
    this.channelTabsEl.className = "im-channel-tabs";

    CHANNELS.forEach((ch) => {
      const tab = document.createElement("button");
      tab.className = `im-channel-tab ${ch.id === this.activeChannel ? "active" : ""}`;
      tab.dataset.channel = ch.id;

      // Color accent for role-specific channels
      if (ch.role) {
        const roleConfig = REALM_ROLES[ch.role];
        tab.style.setProperty(
          "--channel-color",
          `#${roleConfig.accentColor.toString(16).padStart(6, "0")}`,
        );
      }

      tab.innerHTML = `
        <span class="im-tab-icon">${ch.icon}</span>
        <span class="im-tab-label">${ch.label}</span>
        <span class="im-tab-unread hidden"></span>
      `;

      tab.addEventListener("click", () => this.setChannel(ch.id));
      this.channelTabsEl!.appendChild(tab);
    });

    // Messages area
    this.messagesEl = document.createElement("div");
    this.messagesEl.className = "im-channel-messages";
    this.messagesEl.addEventListener("scroll", () => {
      this.updateScrollButton();
      this.messagesEl!.classList.add("scrolling");
      if (this.scrollHideTimer) clearTimeout(this.scrollHideTimer);
      this.scrollHideTimer = setTimeout(() => {
        this.messagesEl!.classList.remove("scrolling");
      }, 1500);
    });

    // Empty state
    const empty = document.createElement("div");
    empty.className = "im-empty-state";
    empty.innerHTML = `
      <div class="im-empty-icon">💬</div>
      <div class="im-empty-title">Team Chat</div>
      <div class="im-empty-text">AI agents will post updates here</div>
    `;
    this.messagesEl.appendChild(empty);

    // Scroll to bottom button
    this.scrollBtn = document.createElement("button");
    this.scrollBtn.className = "im-scroll-bottom";
    this.scrollBtn.textContent = "↓ New messages";
    this.scrollBtn.addEventListener("click", () => this.scrollToBottom());

    // Assemble
    this.wrapper.appendChild(this.channelTabsEl);

    const messagesWrapper = document.createElement("div");
    messagesWrapper.className = "im-messages-wrapper";
    messagesWrapper.appendChild(this.messagesEl);
    messagesWrapper.appendChild(this.scrollBtn);
    this.wrapper.appendChild(messagesWrapper);
  }

  // --------------------------------------------------------------------------
  // Message Rendering
  // --------------------------------------------------------------------------

  private renderMessage(msg: IMMessage): void {
    if (!this.messagesEl) return;

    // Remove empty state if present
    const empty = this.messagesEl.querySelector(".im-empty-state");
    if (empty) empty.remove();

    const shouldScroll = this.isNearBottom();

    const el = document.createElement("div");
    el.className = `im-message im-message-${msg.type}`;
    el.dataset.messageId = msg.id;
    el.dataset.channel = msg.channel;

    const roleInfo = ROLE_DISPLAY[msg.role];

    // Stagger animation
    const now = Date.now();
    if (now - this.lastAddTime < 200) {
      this.batchIndex++;
    } else {
      this.batchIndex = 0;
    }
    this.lastAddTime = now;
    if (this.batchIndex > 0) {
      el.style.animationDelay = `${this.batchIndex * 30}ms`;
    }

    if (msg.type === "system") {
      el.innerHTML = `
        <div class="im-system-message">
          <span class="im-system-icon">${roleInfo.emoji}</span>
          <span class="im-system-text">${escapeHtml(msg.text)}</span>
          <span class="im-message-time">${formatTime(msg.timestamp)}</span>
        </div>
      `;
    } else {
      // Attachment chips
      let attachmentsHtml = "";
      if (msg.attachments && msg.attachments.length > 0) {
        const chips = msg.attachments
          .map((a) => {
            const icon =
              a.type === "image" ? "🖼️" : a.type === "link" ? "🔗" : "📎";
            return `<span class="im-attachment-chip">${icon} ${escapeHtml(a.name)}</span>`;
          })
          .join("");
        attachmentsHtml = `<div class="im-attachments">${chips}</div>`;
      }

      // Question/approval badge
      let badgeHtml = "";
      if (msg.type === "question") {
        badgeHtml = `<span class="im-question-badge">Needs Response</span>`;
      } else if (msg.type === "deliverable") {
        badgeHtml = `<span class="im-deliverable-badge">Deliverable</span>`;
      }

      el.innerHTML = `
        <div class="im-message-avatar" style="background: ${roleInfo.color}20; border-color: ${roleInfo.color}40">
          <span>${roleInfo.emoji}</span>
        </div>
        <div class="im-message-body">
          <div class="im-message-header">
            <span class="im-message-name" style="color: ${roleInfo.color}">${escapeHtml(msg.agentName)}</span>
            ${badgeHtml}
            <span class="im-message-time">${formatTime(msg.timestamp)}</span>
          </div>
          <div class="im-message-text">${renderMarkdown(msg.text)}</div>
          ${attachmentsHtml}
        </div>
      `;
    }

    this.messagesEl.appendChild(el);

    if (shouldScroll) {
      requestAnimationFrame(() => {
        if (this.messagesEl) {
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      });
    }

    this.updateScrollButton();
  }

  private renderAllMessages(): void {
    if (!this.messagesEl) return;

    // Clear existing messages
    this.messagesEl.innerHTML = "";

    // Filter messages for active channel
    const filtered =
      this.activeChannel === "general"
        ? this.messages
        : this.messages.filter((m) => m.channel === this.activeChannel);

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "im-empty-state";
      const ch = CHANNELS.find((c) => c.id === this.activeChannel);
      empty.innerHTML = `
        <div class="im-empty-icon">💬</div>
        <div class="im-empty-title">#${ch?.label ?? this.activeChannel}</div>
        <div class="im-empty-text">No messages yet in this channel</div>
      `;
      this.messagesEl.appendChild(empty);
      return;
    }

    // Render without animation (batch)
    filtered.forEach((msg) => {
      this.renderMessage(msg);
    });

    // Scroll to bottom
    this.scrollToBottom();
  }

  // --------------------------------------------------------------------------
  // Scroll Management
  // --------------------------------------------------------------------------

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    });
  }

  private isNearBottom(): boolean {
    if (!this.messagesEl) return true;
    const threshold = 100;
    return (
      this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight <
      threshold
    );
  }

  private updateScrollButton(): void {
    if (!this.scrollBtn) return;
    this.scrollBtn.classList.toggle("visible", !this.isNearBottom());
  }

  private updateUnreadIndicator(
    channel: IMChannelId,
    hasUnread: boolean,
  ): void {
    const tab = this.channelTabsEl?.querySelector(
      `[data-channel="${channel}"]`,
    );
    if (!tab) return;
    const badge = tab.querySelector(".im-tab-unread");
    if (badge) {
      badge.classList.toggle("hidden", !hasUnread);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Demo Data
// ============================================================================

interface DemoMessage {
  delay: number;
  message: Omit<IMMessage, "id">;
}

function getDemoMessages(): DemoMessage[] {
  const now = Date.now();
  let t = now - 8 * 60 * 60 * 1000; // Start "8 hours ago"
  const step = () => {
    t += Math.random() * 10 * 60 * 1000 + 2 * 60 * 1000; // 2-12 min gaps
    return t;
  };

  return [
    {
      delay: 300,
      message: {
        channel: "general",
        role: "system",
        agentName: "Realm",
        text: 'New objective: "Prepare everything for our v2.0 launch next Tuesday" — decomposed into 12 subtasks and assigned to team.',
        timestamp: step(),
        type: "system",
      },
    },
    {
      delay: 800,
      message: {
        channel: "engineering",
        role: "engineer",
        agentName: "AI Engineer",
        text: "Starting work on database migration script for v2.0 schema changes. Analyzing current schema...",
        timestamp: step(),
        type: "update",
      },
    },
    {
      delay: 600,
      message: {
        channel: "marketing",
        role: "marketer",
        agentName: "AI Marketer",
        text: "Researching competitor launch strategies from Q4. Found 3 relevant case studies from similar SaaS products.",
        timestamp: step(),
        type: "update",
      },
    },
    {
      delay: 500,
      message: {
        channel: "design",
        role: "designer",
        agentName: "AI Designer",
        text: "Starting launch page mockups. Creating 3 variants: minimal, bold, and gradient styles.",
        timestamp: step(),
        type: "update",
      },
    },
    {
      delay: 700,
      message: {
        channel: "analytics",
        role: "analyst",
        agentName: "AI Analyst",
        text: "Pulling user metrics for feature adoption rates. Querying last 90 days of usage data...",
        timestamp: step(),
        type: "update",
      },
    },
    {
      delay: 1200,
      message: {
        channel: "engineering",
        role: "engineer",
        agentName: "AI Engineer",
        text: "Migration script complete. 3 new tables added, 2 columns altered, 0 breaking changes. All existing tests passing.",
        timestamp: step(),
        type: "deliverable",
        attachments: [{ name: "migration-v2.0.sql", type: "file" }],
      },
    },
    {
      delay: 900,
      message: {
        channel: "marketing",
        role: "marketer",
        agentName: "AI Marketer",
        text: "Draft press release ready for review. Focused on the 3 key features users requested most.",
        timestamp: step(),
        type: "deliverable",
        attachments: [{ name: "press-release-v2.md", type: "file" }],
      },
    },
    {
      delay: 800,
      message: {
        channel: "design",
        role: "designer",
        agentName: "AI Designer",
        text: "Two mockup options ready. Option A is minimal/clean, Option B uses the new brand gradient.",
        timestamp: step(),
        type: "deliverable",
        attachments: [
          { name: "launch-page-A.png", type: "image" },
          { name: "launch-page-B.png", type: "image" },
        ],
      },
    },
    {
      delay: 1000,
      message: {
        channel: "engineering",
        role: "engineer",
        agentName: "AI Engineer",
        text: "v2.0 deployed to staging environment. All 47 tests passing. Performance benchmark: 23% faster cold start.",
        timestamp: step(),
        type: "update",
      },
    },
    {
      delay: 700,
      message: {
        channel: "analytics",
        role: "analyst",
        agentName: "AI Analyst",
        text: "Launch readiness report complete. Key finding: 78% of power users already use the features being promoted. Recommend targeting the remaining 22% in messaging.",
        timestamp: step(),
        type: "deliverable",
        attachments: [{ name: "launch-readiness-report.pdf", type: "file" }],
      },
    },
    {
      delay: 1100,
      message: {
        channel: "marketing",
        role: "marketer",
        agentName: "AI Marketer",
        text: 'Need approval: Should we target **Product Hunt** or **Hacker News** first for the launch? PH has better conversion for SaaS, but HN reaches more developers.',
        timestamp: step(),
        type: "question",
      },
    },
    {
      delay: 600,
      message: {
        channel: "general",
        role: "system",
        agentName: "Realm",
        text: "Progress update: 10/12 subtasks complete. 2 pending approval. Team is ahead of schedule.",
        timestamp: step(),
        type: "system",
      },
    },
  ];
}
