/**
 * TaskDecomposition - Animated task card decomposition effect
 *
 * When a user submits a goal, it visually decomposes into individual
 * task cards that fly to the assigned AI agent characters.
 *
 * Used in the demo video at [0:25-0:35].
 */

import * as THREE from "three";
import type { RealmRole } from "../../shared/types";
import { REALM_ROLES } from "../../shared/types";

// ============================================================================
// Types
// ============================================================================

export interface TaskCard {
  role: RealmRole;
  text: string;
}

interface FlyingCard {
  sprite: THREE.Sprite;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  progress: number;
  speed: number;
  delay: number;
  elapsed: number;
  done: boolean;
}

// ============================================================================
// TaskDecomposition Class
// ============================================================================

export class TaskDecomposition {
  private scene: THREE.Scene;
  private flyingCards: FlyingCard[] = [];
  private updateBound: () => void;
  private animating = false;
  private clock = new THREE.Clock(false);
  private onCompleteCb: (() => void) | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.updateBound = () => this.update();
  }

  /**
   * Animate task cards flying from a central point to target positions
   *
   * @param origin - World position where cards originate (e.g., center of screen)
   * @param tasks - Array of tasks with role and text
   * @param targets - Map of role -> world position (where the agent is)
   * @param onComplete - Callback when all cards have arrived
   */
  animate(
    origin: THREE.Vector3,
    tasks: TaskCard[],
    targets: Map<RealmRole, THREE.Vector3>,
    onComplete?: () => void,
  ): void {
    this.cleanup();
    this.onCompleteCb = onComplete ?? null;

    // Create flying cards with staggered delays
    tasks.forEach((task, i) => {
      const target = targets.get(task.role);
      if (!target) return;

      const sprite = this.createCardSprite(task);
      sprite.position.copy(origin);
      this.scene.add(sprite);

      this.flyingCards.push({
        sprite,
        startPos: origin.clone(),
        endPos: target.clone().add(new THREE.Vector3(0, 2, 0)), // Float above agent
        progress: 0,
        speed: 0.6 + Math.random() * 0.3, // Slightly varied speeds
        delay: i * 0.15, // Stagger each card
        elapsed: 0,
        done: false,
      });
    });

    // Start animation loop
    this.clock.start();
    this.animating = true;
    this.tick();
  }

  // --------------------------------------------------------------------------
  // Animation Loop
  // --------------------------------------------------------------------------

  private tick(): void {
    if (!this.animating) return;
    requestAnimationFrame(this.updateBound);
  }

  private update(): void {
    const delta = this.clock.getDelta();

    let allDone = true;

    for (const card of this.flyingCards) {
      if (card.done) continue;

      card.elapsed += delta;
      if (card.elapsed < card.delay) {
        allDone = false;
        continue;
      }

      // Advance progress
      card.progress += delta * card.speed;

      if (card.progress >= 1) {
        // Card arrived
        card.progress = 1;
        card.done = true;

        // Fade out and remove after brief pause
        this.fadeOutSprite(card.sprite);
      } else {
        allDone = false;

        // Ease-out cubic interpolation
        const t = 1 - Math.pow(1 - card.progress, 3);

        // Arc path - rise up in the middle then come down
        const arcHeight = 3 * Math.sin(card.progress * Math.PI);

        card.sprite.position.lerpVectors(card.startPos, card.endPos, t);
        card.sprite.position.y += arcHeight;

        // Scale: start small, grow to full, shrink slightly at end
        const scale = card.progress < 0.1
          ? card.progress / 0.1
          : card.progress > 0.8
            ? 1 - (card.progress - 0.8) / 0.2 * 0.3
            : 1;
        card.sprite.scale.setScalar(scale).multiplyScalar(2.5);
        card.sprite.scale.x *= 2; // Cards are wider than tall

        // Slight rotation wobble during flight
        card.sprite.material.rotation =
          Math.sin(card.progress * Math.PI * 4) * 0.1;

        // Opacity: fade in at start
        (card.sprite.material as THREE.SpriteMaterial).opacity = Math.min(
          card.progress / 0.15,
          1,
        );
      }
    }

    if (allDone) {
      this.animating = false;
      this.clock.stop();

      // Cleanup after fade animations complete
      setTimeout(() => {
        this.cleanup();
        this.onCompleteCb?.();
      }, 800);
    } else {
      this.tick();
    }
  }

  // --------------------------------------------------------------------------
  // Card Creation
  // --------------------------------------------------------------------------

  private createCardSprite(task: TaskCard): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext("2d")!;

    const roleConfig = REALM_ROLES[task.role];
    const accentR = (roleConfig.accentColor >> 16) & 0xff;
    const accentG = (roleConfig.accentColor >> 8) & 0xff;
    const accentB = roleConfig.accentColor & 0xff;

    // Card background
    ctx.fillStyle = `rgba(20, 25, 35, 0.9)`;
    this.roundRect(ctx, 8, 8, 496, 176, 16);
    ctx.fill();

    // Accent border (left side)
    ctx.fillStyle = `rgb(${accentR}, ${accentG}, ${accentB})`;
    this.roundRect(ctx, 8, 8, 8, 176, 4);
    ctx.fill();

    // Top border glow
    ctx.strokeStyle = `rgba(${accentR}, ${accentG}, ${accentB}, 0.4)`;
    ctx.lineWidth = 2;
    this.roundRect(ctx, 8, 8, 496, 176, 16);
    ctx.stroke();

    // Role emoji + name
    ctx.font = "bold 28px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = `rgb(${accentR}, ${accentG}, ${accentB})`;
    ctx.textBaseline = "top";
    ctx.fillText(`${roleConfig.emoji} ${roleConfig.name}`, 28, 24);

    // Task text
    ctx.font = "22px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    const maxWidth = 450;
    const words = task.text.split(" ");
    let line = "";
    let y = 70;
    for (const word of words) {
      const testLine = line + word + " ";
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && line !== "") {
        ctx.fillText(line.trim(), 28, y);
        line = word + " ";
        y += 30;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line.trim(), 28, y);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(5, 1.875, 1); // 512:192 aspect ratio
    sprite.renderOrder = 999; // Render on top

    return sprite;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // --------------------------------------------------------------------------
  // Effects
  // --------------------------------------------------------------------------

  private fadeOutSprite(sprite: THREE.Sprite): void {
    const material = sprite.material as THREE.SpriteMaterial;
    const startOpacity = material.opacity;
    const startTime = Date.now();
    const duration = 600;

    const fade = () => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      material.opacity = startOpacity * (1 - t);

      // Float up slightly while fading
      sprite.position.y += 0.02;

      if (t < 1) {
        requestAnimationFrame(fade);
      } else {
        this.scene.remove(sprite);
        material.dispose();
        material.map?.dispose();
      }
    };

    requestAnimationFrame(fade);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  private cleanup(): void {
    this.animating = false;
    this.clock.stop();

    for (const card of this.flyingCards) {
      this.scene.remove(card.sprite);
      const mat = card.sprite.material as THREE.SpriteMaterial;
      mat.dispose();
      mat.map?.dispose();
    }
    this.flyingCards = [];
  }

  dispose(): void {
    this.cleanup();
    this.onCompleteCb = null;
  }
}

// ============================================================================
// Demo Task Data
// ============================================================================

/**
 * Pre-defined tasks for the v2.0 launch demo scenario
 */
export const DEMO_TASKS: TaskCard[] = [
  { role: "engineer", text: "Write database migration for v2.0 schema" },
  { role: "engineer", text: "Deploy to staging and run test suite" },
  { role: "engineer", text: "Update API endpoints for new features" },
  { role: "marketer", text: "Research competitor launch strategies" },
  { role: "marketer", text: "Write press release and social copy" },
  { role: "marketer", text: "Plan Product Hunt / HN launch sequence" },
  { role: "designer", text: "Create launch page mockups (3 variants)" },
  { role: "designer", text: "Design email announcement template" },
  { role: "designer", text: "Update product screenshots for v2.0" },
  { role: "analyst", text: "Pull feature adoption metrics (90 days)" },
  { role: "analyst", text: "Generate launch readiness report" },
  { role: "analyst", text: "Create user segment analysis for targeting" },
];
