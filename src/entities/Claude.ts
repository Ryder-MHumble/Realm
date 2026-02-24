/**
 * Claude - The main character entity
 *
 * A cute representation of Claude that moves around the workshop!
 */

import * as THREE from "three";
import type { StationType } from "../../shared/types";
import type { WorkshopScene, Station } from "../scene/WorkshopScene";
import type {
  ICharacter,
  CharacterOptions,
  CharacterState,
} from "./ICharacter";

// Re-export for backwards compatibility
export type ClaudeState = CharacterState;
export type ClaudeOptions = CharacterOptions;

const DEFAULT_OPTIONS: Required<ClaudeOptions> = {
  scale: 1,
  color: 0xd4a574, // Warm beige/tan (Claude's brand color)
  statusColor: 0x4ade80, // Green
  startStation: "center",
  role: undefined as any,
  displayName: "",
  taskLabel: "",
};

export class Claude implements ICharacter {
  public readonly mesh: THREE.Group;
  public state: CharacterState = "idle";
  public currentStation: StationType = "center";
  public readonly id: string;

  private scene: WorkshopScene;
  private options: Required<ClaudeOptions>;
  private targetPosition: THREE.Vector3 | null = null;
  private moveSpeed = 3; // units per second
  private bobTime = 0;
  private workTime = 0;
  private thinkTime = 0;
  private updateCallback: ((delta: number) => void) | null = null;

  // Body parts for animation
  private body: THREE.Mesh;
  private head: THREE.Mesh;
  private leftArm: THREE.Mesh;
  private rightArm: THREE.Mesh;
  private statusRing: THREE.Mesh;
  private thoughtBubbles: THREE.Group;

  constructor(scene: WorkshopScene, options: ClaudeOptions = {}) {
    this.scene = scene;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.id = Math.random().toString(36).substring(2, 9);
    this.mesh = new THREE.Group();

    // Create body parts
    this.body = this.createBody();
    this.head = this.createHead();
    this.leftArm = this.createArm(-0.35);
    this.rightArm = this.createArm(0.35);
    this.statusRing = this.createStatusRing();
    this.thoughtBubbles = this.createThoughtBubbles();

    this.mesh.add(this.body);
    this.mesh.add(this.head);
    this.mesh.add(this.leftArm);
    this.mesh.add(this.rightArm);
    this.mesh.add(this.statusRing);
    this.mesh.add(this.thoughtBubbles);

    // Apply scale
    this.mesh.scale.setScalar(this.options.scale);

    // Position at start station
    this.currentStation = this.options.startStation;
    const startStation = scene.stations.get(this.options.startStation);
    if (startStation) {
      this.mesh.position.copy(startStation.position);
    }

    // Add to scene
    scene.scene.add(this.mesh);

    // Register update callback (save reference for cleanup)
    this.updateCallback = (delta: number) => this.update(delta);
    scene.onRender(this.updateCallback);
  }

  private createBody(): THREE.Mesh {
    // Rounded body (capsule-like)
    const geometry = new THREE.CapsuleGeometry(0.25, 0.4, 8, 16);
    const material = new THREE.MeshStandardMaterial({
      color: this.options.color,
      roughness: 0.7,
      metalness: 0.1,
    });
    const body = new THREE.Mesh(geometry, material);
    body.position.y = 0.5;
    body.castShadow = true;
    return body;
  }

  private createHead(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(0.22, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: this.options.color,
      roughness: 0.7,
      metalness: 0.1,
    });
    const head = new THREE.Mesh(geometry, material);
    head.position.y = 1.0;
    head.castShadow = true;

    // Eyes (simple dark spheres)
    const eyeGeometry = new THREE.SphereGeometry(0.04, 8, 8);
    const eyeMaterial = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.3,
    });

    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(-0.08, 0.05, 0.18);
    head.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(0.08, 0.05, 0.18);
    head.add(rightEye);

    return head;
  }

  private createArm(xOffset: number): THREE.Mesh {
    const geometry = new THREE.CapsuleGeometry(0.06, 0.25, 4, 8);
    const material = new THREE.MeshStandardMaterial({
      color: this.options.color,
      roughness: 0.7,
      metalness: 0.1,
    });
    const arm = new THREE.Mesh(geometry, material);
    arm.position.set(xOffset, 0.55, 0);
    arm.castShadow = true;
    return arm;
  }

  private createStatusRing(): THREE.Mesh {
    const geometry = new THREE.RingGeometry(0.35, 0.4, 32);
    const material = new THREE.MeshBasicMaterial({
      color: this.options.statusColor,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    return ring;
  }

  private createThoughtBubbles(): THREE.Group {
    const group = new THREE.Group();

    // Three bubbles of increasing size, floating up and to the right
    const sizes = [0.08, 0.12, 0.18];
    const positions = [
      { x: 0.25, y: 1.25, z: 0.2 },
      { x: 0.4, y: 1.45, z: 0.25 },
      { x: 0.55, y: 1.7, z: 0.3 },
    ];

    sizes.forEach((size, i) => {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
      });
      const geometry = new THREE.SphereGeometry(size, 16, 16);
      const bubble = new THREE.Mesh(geometry, material);
      bubble.position.set(positions[i].x, positions[i].y, positions[i].z);
      bubble.userData.baseY = positions[i].y;
      bubble.userData.offset = i * 0.7; // Phase offset for animation
      group.add(bubble);
    });

    // Start hidden
    group.visible = false;
    return group;
  }

  moveTo(station: StationType): void {
    const targetStation = this.scene.stations.get(station);
    if (!targetStation) {
      console.warn(`Unknown station: ${station}`);
      return;
    }

    this.targetPosition = targetStation.position.clone();
    this.currentStation = station;
    this.state = "walking";
    this.updateStatusColor();
  }

  /**
   * Move to a specific world position (for zone-aware movement)
   */
  moveToPosition(position: THREE.Vector3, station: StationType): void {
    this.targetPosition = position.clone();
    this.currentStation = station;
    this.state = "walking";
    this.updateStatusColor();
  }

  shiftTargetPosition(delta: THREE.Vector3): void {
    if (this.targetPosition) {
      this.targetPosition.add(delta);
    }
  }

  setState(state: ClaudeState): void {
    this.state = state;
    this.updateStatusColor();

    if (state === "working") {
      this.workTime = 0;
    } else if (state === "thinking") {
      this.thinkTime = 0;
    }
  }

  private updateStatusColor(): void {
    const material = this.statusRing.material as THREE.MeshBasicMaterial;

    switch (this.state) {
      case "idle":
        material.color.setHex(0x4ade80); // Green
        material.opacity = 0.6;
        break;
      case "walking":
        material.color.setHex(0x60a5fa); // Blue
        material.opacity = 0.8;
        break;
      case "working":
        material.color.setHex(0xfbbf24); // Yellow/Orange
        material.opacity = 0.9;
        break;
      case "thinking":
        material.color.setHex(0xa78bfa); // Purple
        material.opacity = 0.7;
        break;
    }
  }

  private update(delta: number): void {
    // Movement
    if (this.targetPosition && this.state === "walking") {
      const direction = this.targetPosition.clone().sub(this.mesh.position);
      const distance = direction.length();

      if (distance > 0.1) {
        direction.normalize();
        const moveDistance = Math.min(this.moveSpeed * delta, distance);
        this.mesh.position.add(direction.multiplyScalar(moveDistance));

        // Face movement direction
        const angle = Math.atan2(direction.x, direction.z);
        this.mesh.rotation.y = angle;

        // Walking bob
        this.bobTime += delta * 10;
        this.body.position.y = 0.5 + Math.sin(this.bobTime) * 0.03;
        this.head.position.y = 1.0 + Math.sin(this.bobTime) * 0.03;

        // Arm swing
        this.leftArm.rotation.x = Math.sin(this.bobTime) * 0.3;
        this.rightArm.rotation.x = -Math.sin(this.bobTime) * 0.3;
      } else {
        // Arrived
        this.mesh.position.copy(this.targetPosition);
        this.targetPosition = null;
        // Set idle when returning to center, working otherwise
        this.setState(this.currentStation === "center" ? "idle" : "working");
      }
    }

    // Idle animation
    if (this.state === "idle") {
      this.bobTime += delta * 2;
      this.body.position.y = 0.5 + Math.sin(this.bobTime) * 0.02;
      this.head.position.y = 1.0 + Math.sin(this.bobTime) * 0.02;

      // Subtle arm sway
      this.leftArm.rotation.z = Math.sin(this.bobTime * 0.5) * 0.1;
      this.rightArm.rotation.z = -Math.sin(this.bobTime * 0.5) * 0.1;
    }

    // Working animation
    if (this.state === "working") {
      this.workTime += delta * 8;

      // Working motion (like hammering or typing)
      this.rightArm.rotation.x = Math.sin(this.workTime) * 0.5 - 0.5;
      this.leftArm.rotation.x = Math.sin(this.workTime + Math.PI) * 0.3 - 0.3;

      // Slight body bob
      this.body.position.y = 0.5 + Math.abs(Math.sin(this.workTime)) * 0.02;
    }

    // Thinking animation
    if (this.state === "thinking") {
      this.thinkTime += delta * 3;

      // Head tilt/nod
      this.head.rotation.z = Math.sin(this.thinkTime) * 0.1;
      this.head.rotation.x = Math.sin(this.thinkTime * 0.7) * 0.05;

      // Hand on chin pose
      this.rightArm.rotation.x = -0.8;
      this.rightArm.rotation.z = -0.3;
      this.leftArm.rotation.x = 0;
      this.leftArm.rotation.z = 0.2;

      // Show and animate thought bubbles (full size)
      this.thoughtBubbles.visible = true;
      this.thoughtBubbles.scale.setScalar(1.0);
      this.thoughtBubbles.children.forEach((bubble, i) => {
        const mesh = bubble as THREE.Mesh;
        const baseY = mesh.userData.baseY as number;
        const offset = mesh.userData.offset as number;
        mesh.position.y = baseY + Math.sin(this.thinkTime * 2 + offset) * 0.05;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.7 + Math.sin(this.thinkTime * 3 + offset) * 0.2;
      });
    } else if (this.state === "working") {
      // Show smaller thought bubbles while working (still processing)
      this.thinkTime += delta * 4;
      this.thoughtBubbles.visible = true;
      this.thoughtBubbles.scale.setScalar(0.6); // Smaller when working
      this.thoughtBubbles.children.forEach((bubble, i) => {
        const mesh = bubble as THREE.Mesh;
        const baseY = mesh.userData.baseY as number;
        const offset = mesh.userData.offset as number;
        mesh.position.y = baseY + Math.sin(this.thinkTime * 3 + offset) * 0.03;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.4 + Math.sin(this.thinkTime * 4 + offset) * 0.15;
      });
    } else {
      // Hide thought bubbles when idle/walking
      this.thoughtBubbles.visible = false;
    }

    // Status ring pulse
    const ringMaterial = this.statusRing.material as THREE.MeshBasicMaterial;
    if (this.state === "working" || this.state === "thinking") {
      const pulse = 0.6 + Math.sin(Date.now() * 0.005) * 0.3;
      ringMaterial.opacity = pulse;
    }

    // Status ring rotation
    this.statusRing.rotation.z += delta * 0.5;
  }

  dispose(): void {
    // Remove from render loop
    if (this.updateCallback) {
      this.scene.offRender(this.updateCallback);
      this.updateCallback = null;
    }

    // Remove from scene
    this.scene.scene.remove(this.mesh);

    // Dispose geometries
    this.body.geometry.dispose();
    this.head.geometry.dispose();
    this.leftArm.geometry.dispose();
    this.rightArm.geometry.dispose();
    this.statusRing.geometry.dispose();
    this.thoughtBubbles.children.forEach((bubble) => {
      const mesh = bubble as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });

    // Dispose materials
    (this.body.material as THREE.Material).dispose();
    (this.head.material as THREE.Material).dispose();
    (this.leftArm.material as THREE.Material).dispose();
    (this.rightArm.material as THREE.Material).dispose();
    (this.statusRing.material as THREE.Material).dispose();
  }
}
