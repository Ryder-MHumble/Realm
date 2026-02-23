/**
 * Station Panels
 *
 * Shows recent tool activity history for each workstation.
 * Toggled with P key, hidden by default.
 */

import * as THREE from "three";
import type { StationType } from "../../shared/types";
import { t } from "../i18n";

export interface ToolHistoryItem {
  text: string; // "npm test" or "config.ts"
  success: boolean;
  timestamp: number;
}

interface StationPanel {
  sprite: THREE.Sprite;
  history: ToolHistoryItem[];
  needsUpdate: boolean;
}

// Station display names and colors
const STATION_CONFIG: Record<
  StationType,
  { name: string; color: string; icon: string }
> = {
  center: { name: "CENTER", color: "#4ac8e8", icon: "" },
  bookshelf: { name: "LIBRARY", color: "#fbbf24", icon: "" },
  desk: { name: "DESK", color: "#4ade80", icon: "" },
  workbench: { name: "WORKBENCH", color: "#f97316", icon: "" },
  terminal: { name: "TERMINAL", color: "#22d3ee", icon: "" },
  scanner: { name: "SCANNER", color: "#60a5fa", icon: "" },
  antenna: { name: "ANTENNA", color: "#4ac8e8", icon: "" },
  portal: { name: "PORTAL", color: "#22d3d8", icon: "" },
  taskboard: { name: "TASKBOARD", color: "#fb923c", icon: "" },
};

// Station positions (relative to zone center)
const STATION_OFFSETS: Record<StationType, [number, number, number]> = {
  center: [0, 0, 0],
  bookshelf: [0, 0, -4],
  desk: [4, 0, 0],
  workbench: [-4, 0, 0],
  terminal: [0, 0, 4],
  scanner: [3, 0, -3],
  antenna: [-3, 0, -3],
  portal: [-3, 0, 3],
  taskboard: [3, 0, 3],
};

const MAX_HISTORY = 3;
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 160;
const PANEL_SCALE = 2.5;

export class StationPanels {
  private panels: Map<string, Map<StationType, StationPanel>> = new Map(); // zoneId -> stationType -> panel
  private scene: THREE.Scene;
  private visible = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create panels for a zone
   */
  createPanelsForZone(
    zoneId: string,
    zonePosition: THREE.Vector3,
    zoneColor: number,
  ): void {
    const zonePanels = new Map<StationType, StationPanel>();

    for (const [stationType, offset] of Object.entries(STATION_OFFSETS)) {
      if (stationType === "center") continue; // Skip center station

      const sprite = this.createPanelSprite(stationType as StationType);

      // Position panel offset from station, raised and angled back
      const [ox, , oz] = offset;
      sprite.position.set(
        zonePosition.x + ox * 0.7, // Closer to center
        zonePosition.y + 3.5, // Above station
        zonePosition.z + oz * 0.7,
      );

      sprite.visible = this.visible;
      this.scene.add(sprite);

      zonePanels.set(stationType as StationType, {
        sprite,
        history: [],
        needsUpdate: false,
      });
    }

    this.panels.set(zoneId, zonePanels);
  }

  /**
   * Update panel positions for a zone (e.g., after drag-and-drop move)
   */
  updateZonePosition(zoneId: string, newPosition: THREE.Vector3): void {
    const zonePanels = this.panels.get(zoneId);
    if (!zonePanels) return;

    for (const [stationType, panel] of zonePanels) {
      const offset = STATION_OFFSETS[stationType];
      if (!offset) continue;
      const [ox, , oz] = offset;
      panel.sprite.position.set(
        newPosition.x + ox * 0.7,
        newPosition.y + 3.5,
        newPosition.z + oz * 0.7,
      );
    }
  }

  /**
   * Remove panels for a zone
   */
  removePanelsForZone(zoneId: string): void {
    const zonePanels = this.panels.get(zoneId);
    if (!zonePanels) return;

    for (const [, panel] of zonePanels) {
      this.scene.remove(panel.sprite);
      panel.sprite.material.map?.dispose();
      (panel.sprite.material as THREE.SpriteMaterial).dispose();
    }

    this.panels.delete(zoneId);
  }

  /**
   * Add a tool use to station history
   */
  addToolUse(
    zoneId: string,
    station: StationType,
    item: Omit<ToolHistoryItem, "timestamp">,
  ): void {
    const zonePanels = this.panels.get(zoneId);
    if (!zonePanels) return;

    const panel = zonePanels.get(station);
    if (!panel) return;

    // Add new item
    panel.history.push({
      ...item,
      timestamp: Date.now(),
    });

    // Trim to max
    while (panel.history.length > MAX_HISTORY) {
      panel.history.shift();
    }

    panel.needsUpdate = true;
  }

  /**
   * Toggle visibility of all panels
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const [, zonePanels] of this.panels) {
      for (const [, panel] of zonePanels) {
        panel.sprite.visible = visible;
      }
    }
  }

  /**
   * Get visibility state
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Update panels that need re-rendering
   */
  update(): void {
    for (const [, zonePanels] of this.panels) {
      for (const [stationType, panel] of zonePanels) {
        if (panel.needsUpdate) {
          this.renderPanel(panel, stationType);
          panel.needsUpdate = false;
        }
      }
    }
  }

  /**
   * Create a panel sprite for a station
   */
  private createPanelSprite(stationType: StationType): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(
      PANEL_SCALE,
      PANEL_SCALE * (CANVAS_HEIGHT / CANVAS_WIDTH),
      1,
    );

    // Render initial state
    this.renderPanelCanvas(canvas, stationType, []);

    return sprite;
  }

  /**
   * Re-render a panel's canvas
   */
  private renderPanel(panel: StationPanel, stationType: StationType): void {
    const material = panel.sprite.material as THREE.SpriteMaterial;
    const texture = material.map as THREE.CanvasTexture;
    const canvas = texture.image as HTMLCanvasElement;

    this.renderPanelCanvas(canvas, stationType, panel.history);
    texture.needsUpdate = true;
  }

  /**
   * Render panel content to canvas
   */
  private renderPanelCanvas(
    canvas: HTMLCanvasElement,
    stationType: StationType,
    history: ToolHistoryItem[],
  ): void {
    const ctx = canvas.getContext("2d")!;
    const config = STATION_CONFIG[stationType];

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = "rgba(10, 15, 25, 0.9)";
    this.roundRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 8);
    ctx.fill();

    // Border
    ctx.strokeStyle = config.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.6;
    this.roundRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Header
    ctx.fillStyle = config.color;
    ctx.font = "bold 16px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(t(`station.${stationType}`), 20, 20);

    // Divider
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, 44);
    ctx.lineTo(canvas.width - 20, 44);
    ctx.stroke();

    // History items
    const startY = 54;
    const lineHeight = 32;

    if (history.length === 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("No activity yet", 20, startY + 8);
    } else {
      ctx.font = "13px system-ui, -apple-system, sans-serif";

      history.forEach((item, i) => {
        const y = startY + i * lineHeight;

        // Status indicator
        ctx.fillStyle = item.success ? "#4ade80" : "#f87171";
        ctx.beginPath();
        ctx.arc(26, y + 12, 4, 0, Math.PI * 2);
        ctx.fill();

        // Text
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        const maxTextWidth = canvas.width - 60;
        let displayText = item.text;

        // Truncate if needed
        if (ctx.measureText(displayText).width > maxTextWidth) {
          while (
            ctx.measureText(displayText + "...").width > maxTextWidth &&
            displayText.length > 0
          ) {
            displayText = displayText.slice(0, -1);
          }
          displayText += "...";
        }

        ctx.fillText(displayText, 38, y + 8);
      });
    }
  }

  /**
   * Draw a rounded rectangle path
   */
  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }
}
