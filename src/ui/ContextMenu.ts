/**
 * ContextMenu - Generic context menu that appears at click location
 *
 * Features:
 * - Shows at cursor position with smart viewport clamping
 * - Dismisses when clicking outside or moving mouse away
 * - Keyboard shortcuts for items
 * - Reusable for different contexts (create zone, delete zone, etc.)
 */

export interface ContextMenuItem {
  key: string; // Keyboard shortcut (e.g., 'C', 'D')
  label: string; // Display label (e.g., 'Create zone')
  action: string; // Action identifier
  danger?: boolean; // If true, show in red/warning style
}

export interface ContextMenuOptions {
  dismissDistance?: number; // Pixels to move before auto-dismiss (default: 150)
  onAction?: (action: string, context: ContextMenuContext) => void;
}

export interface ContextMenuContext {
  worldPosition?: { x: number; z: number };
  zoneId?: string;
  screenPosition: { x: number; y: number };
  [key: string]: unknown; // Allow extra context data
}

export class ContextMenu {
  private element: HTMLElement;
  private visible = false;
  private context: ContextMenuContext | null = null;
  private items: ContextMenuItem[] = [];
  private dismissDistance: number;
  private onAction:
    | ((action: string, context: ContextMenuContext) => void)
    | null;

  constructor(options: ContextMenuOptions = {}) {
    this.dismissDistance = options.dismissDistance ?? 150;
    this.onAction = options.onAction ?? null;

    // Create menu element
    this.element = document.createElement("div");
    this.element.className = "context-menu";
    this.element.innerHTML = `
      <div class="context-menu-items"></div>
      <div class="context-menu-hint">Move elsewhere to dismiss</div>
    `;
    document.body.appendChild(this.element);

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Click on menu item
    this.element.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".context-menu-item");
      if (item) {
        const action = item.getAttribute("data-action");
        if (action) {
          this.executeAction(action);
        }
      }
    });

    // Click outside dismisses
    document.addEventListener("mousedown", (e) => {
      if (this.visible && !this.element.contains(e.target as Node)) {
        this.hide();
      }
    });

    // Mouse moving far from menu dismisses (measured from menu rect, not click point)
    document.addEventListener("mousemove", (e) => {
      if (!this.visible) return;

      const rect = this.element.getBoundingClientRect();
      const margin = this.dismissDistance;

      // Distance from mouse to nearest edge of menu rect
      const dx = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right);
      const dy = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom);
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > margin) {
        this.hide();
      }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (!this.visible) return;

      const inInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      if (inInput) return;

      // Check if pressed key matches any item
      const key = e.key.toUpperCase();
      const matchingItem = this.items.find(
        (item) => item.key.toUpperCase() === key,
      );

      if (matchingItem) {
        e.preventDefault();
        this.executeAction(matchingItem.action);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
    });
  }

  /**
   * Show the menu at a screen position with given items and context
   */
  show(
    screenX: number,
    screenY: number,
    items: ContextMenuItem[],
    context: Omit<ContextMenuContext, "screenPosition">,
  ): void {
    this.items = items;
    this.context = {
      ...context,
      screenPosition: { x: screenX, y: screenY },
    };
    this.visible = true;

    // Render items
    const itemsContainer = this.element.querySelector(".context-menu-items")!;
    itemsContainer.innerHTML = items
      .map(
        (item) => `
      <div class="context-menu-item ${item.danger ? "danger" : ""}" data-action="${item.action}">
        <span class="context-menu-key">${item.key}</span>
        <span class="context-menu-label">${item.label}</span>
      </div>
    `,
      )
      .join("");

    // Position menu near click
    this.element.style.left = `${screenX + 10}px`;
    this.element.style.top = `${screenY - 10}px`;

    // Show menu (needed for getBoundingClientRect)
    this.element.classList.add("visible");

    // Keep menu in viewport
    const rect = this.element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth - 10) {
      this.element.style.left = `${screenX - rect.width - 10}px`;
    }
    if (rect.bottom > viewportHeight - 10) {
      this.element.style.top = `${screenY - rect.height + 10}px`;
    }
  }

  /**
   * Hide the menu
   */
  hide(): void {
    this.element.classList.remove("visible");
    this.visible = false;
    this.context = null;
    this.items = [];
  }

  /**
   * Check if menu is currently visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Get current context
   */
  getContext(): ContextMenuContext | null {
    return this.context;
  }

  private executeAction(action: string): void {
    if (this.context && this.onAction) {
      this.onAction(action, this.context);
    }
    this.hide();
  }

  /**
   * Clean up event listeners and remove element
   */
  dispose(): void {
    this.element.remove();
  }
}
