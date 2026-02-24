/**
 * DrawMode - Hex painting mode for decorative coloring
 *
 * In draw mode:
 * - Clicking hexes paints them instead of creating zones
 * - 1-6 select colors, 0 erases
 * - D or Esc exits draw mode
 */

import { soundManager } from "../audio/SoundManager";

export interface DrawColor {
  id: string;
  name: string;
  color: number;
  key: string; // Keyboard shortcut
}

export const DRAW_COLORS: DrawColor[] = [
  { id: "cyan", name: "Cyan", color: 0x22d3ee, key: "1" },
  { id: "sky", name: "Sky", color: 0x38bdf8, key: "2" },
  { id: "blue", name: "Blue", color: 0x60a5fa, key: "3" },
  { id: "indigo", name: "Indigo", color: 0x818cf8, key: "4" },
  { id: "purple", name: "Purple", color: 0xa78bfa, key: "5" },
  { id: "teal", name: "Teal", color: 0x2dd4bf, key: "6" },
];

export const ERASER_KEY = "0";

export type DrawModeState = {
  enabled: boolean;
  selectedColorIndex: number;
  isEraser: boolean;
  brushSize: number; // 1-4 (1=single hex, 2=7 hexes, 3=19 hexes, 4=37 hexes)
  is3DMode: boolean; // Whether hexes stack in 3D when same color painted
};

type DrawModeChangeCallback = (state: DrawModeState) => void;
type ClearCallback = () => void;

class DrawModeManager {
  private state: DrawModeState = {
    enabled: false,
    selectedColorIndex: 0,
    isEraser: false,
    brushSize: 1,
    is3DMode: true, // 3D stacking enabled by default
  };

  private callbacks: DrawModeChangeCallback[] = [];
  private clearCallbacks: ClearCallback[] = [];
  private paletteEl: HTMLElement | null = null;
  private indicatorEl: HTMLElement | null = null;

  /**
   * Initialize the draw mode UI
   * Call after DOM is ready
   */
  init(): void {
    this.paletteEl = document.getElementById("draw-palette");
    this.indicatorEl = document.getElementById("draw-indicator");

    if (this.paletteEl) {
      this.renderPalette();
    }

    this.updateUI();
  }

  /**
   * Toggle draw mode on/off
   */
  toggle(): void {
    this.state.enabled = !this.state.enabled;
    if (this.state.enabled) {
      // Reset to first color when entering
      this.state.selectedColorIndex = 0;
      this.state.isEraser = false;
    }
    this.updateUI();
    this.notifyChange();
  }

  /**
   * Exit draw mode
   */
  exit(): void {
    if (this.state.enabled) {
      this.state.enabled = false;
      this.updateUI();
      this.notifyChange();
    }
  }

  /**
   * Check if draw mode is active
   */
  isEnabled(): boolean {
    return this.state.enabled;
  }

  /**
   * Get current selected color (or null if eraser)
   */
  getSelectedColor(): number | null {
    if (this.state.isEraser) return null;
    return DRAW_COLORS[this.state.selectedColorIndex]?.color ?? null;
  }

  /**
   * Get current color info
   */
  getSelectedColorInfo(): DrawColor | null {
    if (this.state.isEraser) return null;
    return DRAW_COLORS[this.state.selectedColorIndex] ?? null;
  }

  /**
   * Select a color by index (0-5)
   */
  selectColor(index: number): void {
    if (index >= 0 && index < DRAW_COLORS.length) {
      this.state.selectedColorIndex = index;
      this.state.isEraser = false;
      this.updateUI();
      this.notifyChange();
      soundManager.playColorSelect(index);
    }
  }

  /**
   * Select eraser mode
   */
  selectEraser(): void {
    this.state.isEraser = true;
    this.updateUI();
    this.notifyChange();
    soundManager.playColorSelect(-1); // Eraser sound
  }

  /**
   * Get current brush size
   */
  getBrushSize(): number {
    return this.state.brushSize;
  }

  /**
   * Increase brush size (max 4)
   */
  increaseBrushSize(): void {
    if (this.state.brushSize < 4) {
      this.state.brushSize++;
      this.updateUI();
      this.notifyChange();
      soundManager.playSliderTick(this.state.brushSize / 4);
    }
  }

  /**
   * Decrease brush size
   */
  decreaseBrushSize(): void {
    if (this.state.brushSize > 1) {
      this.state.brushSize--;
      this.updateUI();
      this.notifyChange();
      soundManager.playSliderTick(this.state.brushSize / 4);
    }
  }

  /**
   * Check if 3D mode is enabled
   */
  is3DMode(): boolean {
    return this.state.is3DMode;
  }

  /**
   * Toggle 3D stacking mode
   */
  toggle3DMode(): void {
    this.state.is3DMode = !this.state.is3DMode;
    this.updateUI();
    this.notifyChange();
    soundManager.playSliderTick(this.state.is3DMode ? 1 : 0);
  }

  /**
   * Handle key press in draw mode
   * Returns true if key was handled
   */
  handleKey(key: string): boolean {
    if (!this.state.enabled) return false;

    // Check for color keys (1-6)
    const colorIndex = DRAW_COLORS.findIndex((c) => c.key === key);
    if (colorIndex >= 0) {
      this.selectColor(colorIndex);
      return true;
    }

    // Check for eraser (0)
    if (key === ERASER_KEY) {
      this.selectEraser();
      return true;
    }

    // Brush size: Q to decrease, E to increase
    if (key === "q" || key === "Q") {
      this.decreaseBrushSize();
      return true;
    }
    if (key === "e" || key === "E") {
      this.increaseBrushSize();
      return true;
    }

    // R to toggle 3D mode
    if (key === "r" || key === "R") {
      this.toggle3DMode();
      return true;
    }

    return false;
  }

  /**
   * Register a callback for state changes
   */
  onChange(callback: DrawModeChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Register a callback for clear action
   */
  onClear(callback: ClearCallback): void {
    this.clearCallbacks.push(callback);
  }

  /**
   * Trigger clear action
   */
  triggerClear(): void {
    for (const cb of this.clearCallbacks) {
      cb();
    }
  }

  /**
   * Get current state
   */
  getState(): DrawModeState {
    return { ...this.state };
  }

  private notifyChange(): void {
    const state = this.getState();
    for (const cb of this.callbacks) {
      cb(state);
    }
  }

  private updateUI(): void {
    // Update palette visibility
    if (this.paletteEl) {
      this.paletteEl.classList.toggle("visible", this.state.enabled);
    }

    // Update indicator visibility
    if (this.indicatorEl) {
      this.indicatorEl.classList.toggle("visible", this.state.enabled);
    }

    // Update selected state on color buttons
    if (this.paletteEl) {
      const buttons = this.paletteEl.querySelectorAll(".draw-color-btn");
      buttons.forEach((btn, index) => {
        const isSelected =
          !this.state.isEraser && index === this.state.selectedColorIndex;
        btn.classList.toggle("selected", isSelected);
      });

      const eraserBtn = this.paletteEl.querySelector(".draw-eraser-btn");

      // Update brush size display
      const brushSizeEl = this.paletteEl.querySelector(
        ".draw-brush-size-value",
      );
      if (brushSizeEl) {
        brushSizeEl.textContent = String(this.state.brushSize);
      }
      if (eraserBtn) {
        eraserBtn.classList.toggle("selected", this.state.isEraser);
      }

      // Update 3D toggle state
      const toggle3DBtn = this.paletteEl.querySelector(".draw-3d-toggle");
      if (toggle3DBtn) {
        toggle3DBtn.classList.toggle("active", this.state.is3DMode);
      }
    }
  }

  private renderPalette(): void {
    if (!this.paletteEl) return;

    // Generate color buttons
    const colorsHtml = DRAW_COLORS.map((color, index) => {
      const hexColor = "#" + color.color.toString(16).padStart(6, "0");
      return `
        <button
          type="button"
          class="draw-color-btn${index === 0 ? " selected" : ""}"
          data-color-index="${index}"
          style="--color: ${hexColor}"
          title="${color.name} (${color.key})"
        >
          <span class="draw-color-key">${color.key}</span>
        </button>
      `;
    }).join("");

    // Add eraser button
    const eraserHtml = `
      <button
        type="button"
        class="draw-eraser-btn"
        title="Eraser (0)"
      >
        <span class="draw-eraser-icon">✕</span>
        <span class="draw-color-key">0</span>
      </button>
    `;

    // Add clear button
    const clearHtml = `
      <button
        type="button"
        class="draw-clear-btn"
        title="Clear all (X)"
      >
        <span class="draw-clear-icon">🗑</span>
      </button>
    `;

    // Add brush size controls
    const brushSizeHtml = `
      <div class="draw-brush-size">
        <button type="button" class="draw-brush-btn draw-brush-minus" title="Smaller (Q)">−</button>
        <span class="draw-brush-size-value">${this.state.brushSize}</span>
        <button type="button" class="draw-brush-btn draw-brush-plus" title="Larger (E)">+</button>
      </div>
    `;

    // Add 3D toggle button
    const toggle3DHtml = `
      <button
        type="button"
        class="draw-3d-toggle${this.state.is3DMode ? " active" : ""}"
        title="Toggle 3D stacking (R)"
      >
        <span class="draw-3d-icon">3D</span>
      </button>
    `;

    const sep = '<div class="draw-separator"></div>';
    this.paletteEl.innerHTML =
      colorsHtml +
      sep +
      eraserHtml +
      clearHtml +
      sep +
      brushSizeHtml +
      sep +
      toggle3DHtml;

    // Add click handlers
    this.paletteEl.querySelectorAll(".draw-color-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const index = parseInt(
          (e.currentTarget as HTMLElement).dataset.colorIndex || "0",
          10,
        );
        this.selectColor(index);
      });
    });

    const eraserBtn = this.paletteEl.querySelector(".draw-eraser-btn");
    if (eraserBtn) {
      eraserBtn.addEventListener("click", () => {
        this.selectEraser();
      });
    }

    const clearBtn = this.paletteEl.querySelector(".draw-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        this.triggerClear();
      });
    }

    const brushMinusBtn = this.paletteEl.querySelector(".draw-brush-minus");
    if (brushMinusBtn) {
      brushMinusBtn.addEventListener("click", () => {
        this.decreaseBrushSize();
      });
    }

    const brushPlusBtn = this.paletteEl.querySelector(".draw-brush-plus");
    if (brushPlusBtn) {
      brushPlusBtn.addEventListener("click", () => {
        this.increaseBrushSize();
      });
    }

    const toggle3DBtn = this.paletteEl.querySelector(".draw-3d-toggle");
    if (toggle3DBtn) {
      toggle3DBtn.addEventListener("click", () => {
        this.toggle3DMode();
      });
    }
  }
}

export const drawMode = new DrawModeManager();
