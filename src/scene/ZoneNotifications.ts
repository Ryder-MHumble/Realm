/**
 * ZoneNotifications - Floating notification system for zones
 *
 * Shows contextual notifications that float up and fade out above zones.
 * Useful for showing file changes, command results, search results, etc.
 *
 * Features:
 * - Multiple notification styles (success, info, warning, error)
 * - Stacking: multiple notifications don't overlap
 * - Configurable duration and animation
 * - Icon support for quick visual scanning
 */

import * as THREE from "three";

// ============================================================================
// Types
// ============================================================================

export type NotificationStyle =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "muted";

export interface NotificationOptions {
  /** Text to display */
  text: string;
  /** Optional icon/emoji prefix */
  icon?: string;
  /** Style determines color */
  style?: NotificationStyle;
  /** Duration in seconds (default: 3) */
  duration?: number;
  /** Custom color override (hex string like '#ff0000') */
  color?: string;
}

interface ActiveNotification {
  sprite: THREE.Sprite;
  zoneId: string;
  startY: number;
  targetY: number; // For stacking
  age: number;
  maxAge: number;
  slot: number; // Vertical slot for stacking
}

// ============================================================================
// Style Configuration
// ============================================================================

const STYLE_COLORS: Record<NotificationStyle, string> = {
  success: "#4ade80", // Green
  info: "#60a5fa", // Blue
  warning: "#fbbf24", // Amber
  error: "#f87171", // Red
  muted: "#9ca3af", // Gray
};

// Tool to style mapping
const TOOL_STYLES: Record<string, { style: NotificationStyle; icon: string }> =
  {
    // File operations
    Read: { style: "info", icon: "📖" },
    Edit: { style: "warning", icon: "✏️" },
    Write: { style: "success", icon: "📝" },

    // Search operations
    Grep: { style: "info", icon: "🔍" },
    Glob: { style: "info", icon: "📁" },

    // Terminal
    Bash: { style: "muted", icon: "⚡" },

    // Web
    WebFetch: { style: "info", icon: "🌐" },
    WebSearch: { style: "info", icon: "🔎" },

    // Tasks
    Task: { style: "success", icon: "🚀" },
    TodoWrite: { style: "info", icon: "☑️" },

    // Other
    AskUserQuestion: { style: "warning", icon: "❓" },
    NotebookEdit: { style: "warning", icon: "📓" },
  };

// ============================================================================
// ZoneNotifications Class
// ============================================================================

export class ZoneNotifications {
  private scene: THREE.Scene;
  private notifications: ActiveNotification[] = [];
  private zonePositions: Map<string, THREE.Vector3> = new Map();
  private zoneElevations: Map<string, number> = new Map();

  // Configuration
  private readonly BASE_Y = 2.5; // Starting height above zone
  private readonly STACK_SPACING = 0.6; // Vertical space between stacked notifications
  private readonly MAX_STACK = 5; // Max notifications per zone
  private readonly FLOAT_DISTANCE = 1.5; // How far to float up
  private readonly DEFAULT_DURATION = 3; // Default seconds

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Register a zone's position for notifications
   */
  registerZone(zoneId: string, position: THREE.Vector3): void {
    this.zonePositions.set(zoneId, position.clone());
  }

  /**
   * Unregister a zone
   */
  unregisterZone(zoneId: string): void {
    this.zonePositions.delete(zoneId);
    this.zoneElevations.delete(zoneId);
    // Remove any active notifications for this zone
    this.clearZone(zoneId);
  }

  /**
   * Update a zone's position (e.g., after drag-and-drop move)
   */
  updateZonePosition(zoneId: string, position: THREE.Vector3): void {
    this.zonePositions.set(zoneId, position.clone());
  }

  /**
   * Update a zone's elevation (for raised zones)
   */
  updateZoneElevation(zoneId: string, elevation: number): void {
    this.zoneElevations.set(zoneId, elevation);
  }

  /**
   * Show a notification above a zone
   */
  show(zoneId: string, options: NotificationOptions): void {
    const zonePos = this.zonePositions.get(zoneId);
    if (!zonePos) return;

    const style = options.style ?? "info";
    const color = options.color ?? STYLE_COLORS[style];
    const duration = options.duration ?? this.DEFAULT_DURATION;
    const displayText = options.icon
      ? `${options.icon} ${options.text}`
      : options.text;

    // Find next available slot for this zone
    const slot = this.findNextSlot(zoneId);
    if (slot >= this.MAX_STACK) {
      // Too many notifications, skip or remove oldest
      this.removeOldestForZone(zoneId);
    }

    // Create sprite
    const sprite = this.createSprite(displayText, color);

    // Position with stacking offset, accounting for zone elevation
    const zoneElevation = this.zoneElevations.get(zoneId) ?? 0;
    const startY = zoneElevation + this.BASE_Y + slot * this.STACK_SPACING;
    sprite.position.set(zonePos.x, startY, zonePos.z);
    this.scene.add(sprite);

    this.notifications.push({
      sprite,
      zoneId,
      startY,
      targetY: startY + this.FLOAT_DISTANCE,
      age: 0,
      maxAge: duration,
      slot,
    });
  }

  /**
   * Show a tool-specific notification with automatic styling
   */
  showForTool(
    zoneId: string,
    tool: string,
    text: string,
    options?: Partial<NotificationOptions>,
  ): void {
    const toolConfig = TOOL_STYLES[tool] ?? {
      style: "info" as NotificationStyle,
      icon: "🔧",
    };

    this.show(zoneId, {
      text,
      icon: options?.icon ?? toolConfig.icon,
      style: options?.style ?? toolConfig.style,
      duration: options?.duration,
      color: options?.color,
    });
  }

  /**
   * Clear all notifications for a zone
   */
  clearZone(zoneId: string): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (this.notifications[i].zoneId === zoneId) {
        this.removeNotification(i);
      }
    }
  }

  /**
   * Update all notifications (call from render loop)
   */
  update(delta: number): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const notif = this.notifications[i];
      notif.age += delta;

      const progress = notif.age / notif.maxAge;

      if (progress >= 1) {
        this.removeNotification(i);
      } else {
        // Animate position: ease out float
        const floatProgress = 1 - Math.pow(1 - progress, 2);
        const y = notif.startY + (notif.targetY - notif.startY) * floatProgress;
        notif.sprite.position.y = y;

        // Animate opacity: stay visible, then fade
        const fadeStart = 0.6;
        const opacity =
          progress < fadeStart
            ? 1
            : 1 - Math.pow((progress - fadeStart) / (1 - fadeStart), 2);
        notif.sprite.material.opacity = opacity;
      }
    }
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      this.removeNotification(i);
    }
    this.zonePositions.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private createSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    canvas.width = 512;
    canvas.height = 96;

    // Font setup
    const fontSize = 32;
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, "SF Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // Measure text for pill background
    const textWidth = ctx.measureText(text).width;
    const padding = 24;
    const pillWidth = Math.min(canvas.width - 20, textWidth + padding * 2);
    const pillHeight = 56;
    const pillX = centerX - pillWidth / 2;
    const pillY = centerY - pillHeight / 2;

    // Draw pill background
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 10);
    ctx.fill();

    // Draw border
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Draw text
    ctx.fillStyle = color;

    // Truncate if needed
    let displayText = text;
    while (
      ctx.measureText(displayText).width > pillWidth - padding * 2 &&
      displayText.length > 10
    ) {
      displayText = displayText.slice(0, -4) + "...";
    }
    ctx.fillText(displayText, centerX, centerY);

    // Create texture and sprite
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(7, 1.3, 1);

    return sprite;
  }

  private findNextSlot(zoneId: string): number {
    const usedSlots = new Set<number>();
    for (const notif of this.notifications) {
      if (notif.zoneId === zoneId) {
        usedSlots.add(notif.slot);
      }
    }

    // Find first available slot
    for (let i = 0; i < this.MAX_STACK; i++) {
      if (!usedSlots.has(i)) return i;
    }
    return this.MAX_STACK;
  }

  private removeOldestForZone(zoneId: string): void {
    for (let i = 0; i < this.notifications.length; i++) {
      if (this.notifications[i].zoneId === zoneId) {
        this.removeNotification(i);
        return;
      }
    }
  }

  private removeNotification(index: number): void {
    const notif = this.notifications[index];
    this.scene.remove(notif.sprite);
    notif.sprite.material.map?.dispose();
    notif.sprite.material.dispose();
    this.notifications.splice(index, 1);
  }
}

// ============================================================================
// Helper Functions for Common Notifications
// ============================================================================

/**
 * Format a file change notification
 */
export function formatFileChange(
  fileName: string,
  options?: { added?: number; removed?: number; lines?: number },
): string {
  if (!options) return fileName;

  const parts: string[] = [];
  if (options.added && options.added > 0) parts.push(`+${options.added}`);
  if (options.removed && options.removed > 0) parts.push(`-${options.removed}`);
  if (options.lines) parts.push(`${options.lines} lines`);

  return parts.length > 0 ? `${fileName} ${parts.join(", ")}` : fileName;
}

/**
 * Format a command result notification
 */
export function formatCommandResult(command: string, maxLength = 30): string {
  // Extract just the command name, not args
  const cmdName = command.split(" ")[0].split("/").pop() || command;
  if (cmdName.length <= maxLength) return cmdName;
  return cmdName.slice(0, maxLength - 3) + "...";
}

/**
 * Format a search result notification
 */
export function formatSearchResult(
  pattern: string,
  matchCount?: number,
): string {
  const truncatedPattern =
    pattern.length > 20 ? pattern.slice(0, 17) + "..." : pattern;
  if (matchCount !== undefined) {
    return `"${truncatedPattern}" → ${matchCount} matches`;
  }
  return `"${truncatedPattern}"`;
}
