/**
 * ClaudeMon - Cute robot buddy for the workshop
 *
 * Design: Friendly robot that fits the hexagonal tech aesthetic
 * - Round head with screen/visor face (cute LED eyes)
 * - Metallic body with panel lines and glowing accents
 * - Tech colors (dark metal, cyan/purple glows)
 * - Expressive despite being clearly robotic
 */

import * as THREE from "three";
import type { StationType, RealmRole } from "../../shared/types";
import { REALM_ROLES } from "../../shared/types";
import type { WorkshopScene } from "../scene/WorkshopScene";
import type {
  ICharacter,
  CharacterOptions,
  CharacterState,
} from "./ICharacter";
import {
  IdleBehaviorManager,
  WorkingBehaviorManager,
  STATION_ANIMATIONS,
  type CharacterParts,
} from "./animations";

// Re-export for backwards compatibility
export type ClaudeState = CharacterState;
export type ClaudeOptions = CharacterOptions;

const DEFAULT_OPTIONS: Required<ClaudeOptions> = {
  scale: 1,
  color: 0x2a3a4a, // Dark blue-gray metal
  statusColor: 0x4ade80,
  startStation: "center",
  role: undefined as unknown as RealmRole,
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
  private moveSpeed = 3;
  private bobTime = 0;
  private workTime = 0;
  private thinkTime = 0;
  private currentFacingAngle = 0;
  private currentMoveSpeed = 0;
  private updateCallback: ((delta: number) => void) | null = null;

  // Body parts for animation
  private head: THREE.Group;
  private visor: THREE.Mesh;
  private leftEye: THREE.Mesh;
  private rightEye: THREE.Mesh;
  private body: THREE.Group;
  private leftArm: THREE.Group;
  private rightArm: THREE.Group;
  private antenna: THREE.Group;
  private statusRing: THREE.Mesh;
  private thoughtBubbles: THREE.Group;
  private glowAccents: THREE.Group;

  // Realm role config (resolved from options)
  private roleAccentColor: number = 0x67e8f9;

  // Floating labels
  private nameLabel: THREE.Sprite | null = null;
  private taskLabelSprite: THREE.Sprite | null = null;

  // Behavior systems
  private idleBehaviorManager: IdleBehaviorManager;
  private workingBehaviorManager: WorkingBehaviorManager;

  constructor(scene: WorkshopScene, options: ClaudeOptions = {}) {
    this.scene = scene;

    // Apply role presets if a role is specified
    const merged = { ...DEFAULT_OPTIONS, ...options };
    if (options.role && REALM_ROLES[options.role]) {
      const roleConfig = REALM_ROLES[options.role];
      if (!options.color) merged.color = roleConfig.color;
      if (!options.statusColor) merged.statusColor = roleConfig.statusColor;
      this.roleAccentColor = roleConfig.accentColor;
      if (!options.displayName) merged.displayName = roleConfig.name;
    }
    this.options = merged;

    this.id = Math.random().toString(36).substring(2, 9);
    this.mesh = new THREE.Group();

    // Create body parts
    this.head = this.createHead();
    this.visor = this.head.getObjectByName("visor") as THREE.Mesh;
    this.leftEye = this.head.getObjectByName("leftEye") as THREE.Mesh;
    this.rightEye = this.head.getObjectByName("rightEye") as THREE.Mesh;
    this.body = this.createBody();
    this.leftArm = this.createArm(-1);
    this.rightArm = this.createArm(1);
    this.antenna = this.createAntenna();
    this.statusRing = this.createStatusRing();
    this.thoughtBubbles = this.createThoughtBubbles();
    this.glowAccents = this.createGlowAccents();

    this.mesh.add(this.head);
    this.mesh.add(this.body);
    this.mesh.add(this.leftArm);
    this.mesh.add(this.rightArm);
    this.mesh.add(this.antenna);
    this.mesh.add(this.statusRing);
    this.mesh.add(this.thoughtBubbles);
    this.mesh.add(this.glowAccents);

    // Create floating name label if displayName is set
    if (this.options.displayName) {
      this.nameLabel = this.createNameLabel(this.options.displayName);
      this.mesh.add(this.nameLabel);
    }

    // Create task label if set
    if (this.options.taskLabel) {
      this.taskLabelSprite = this.createTaskLabel(this.options.taskLabel);
      this.mesh.add(this.taskLabelSprite);
    }

    // Initialize behavior systems
    this.idleBehaviorManager = new IdleBehaviorManager();
    this.workingBehaviorManager = new WorkingBehaviorManager();

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

    // Register update callback
    this.updateCallback = (delta: number) => this.update(delta);
    scene.onRender(this.updateCallback);
  }

  private createHead(): THREE.Group {
    const group = new THREE.Group();

    // Main head - rounded cube shape (robot but friendly)
    const headGeometry = new THREE.SphereGeometry(0.28, 32, 32);
    headGeometry.scale(1, 0.9, 0.85);
    const headMaterial = new THREE.MeshStandardMaterial({
      color: this.options.color,
      roughness: 0.3,
      metalness: 0.7,
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.castShadow = true;
    group.add(head);

    // Visor/face screen - where the cute eyes appear
    const visorGeometry = new THREE.PlaneGeometry(0.32, 0.18);
    const visorMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a2e,
      transparent: true,
      opacity: 0.9,
    });
    const visor = new THREE.Mesh(visorGeometry, visorMaterial);
    visor.name = "visor";
    visor.position.set(0, 0.02, 0.24);
    group.add(visor);

    // Visor frame/border (glowing edge - uses role accent)
    const frameGeometry = new THREE.RingGeometry(0.17, 0.19, 32);
    frameGeometry.scale(1, 0.6, 1);
    const frameMaterial = new THREE.MeshBasicMaterial({
      color: this.roleAccentColor,
      transparent: true,
      opacity: 0.6,
    });
    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    frame.position.set(0, 0.02, 0.241);
    group.add(frame);

    // LED Eyes - rounded rectangle shape (like LED displays)
    const eyeShape = new THREE.Shape();
    const eyeW = 0.032; // width
    const eyeH = 0.045; // height (taller than wide)
    const eyeR = 0.012; // corner radius
    // Draw rounded rectangle
    eyeShape.moveTo(-eyeW / 2 + eyeR, -eyeH / 2);
    eyeShape.lineTo(eyeW / 2 - eyeR, -eyeH / 2);
    eyeShape.quadraticCurveTo(eyeW / 2, -eyeH / 2, eyeW / 2, -eyeH / 2 + eyeR);
    eyeShape.lineTo(eyeW / 2, eyeH / 2 - eyeR);
    eyeShape.quadraticCurveTo(eyeW / 2, eyeH / 2, eyeW / 2 - eyeR, eyeH / 2);
    eyeShape.lineTo(-eyeW / 2 + eyeR, eyeH / 2);
    eyeShape.quadraticCurveTo(-eyeW / 2, eyeH / 2, -eyeW / 2, eyeH / 2 - eyeR);
    eyeShape.lineTo(-eyeW / 2, -eyeH / 2 + eyeR);
    eyeShape.quadraticCurveTo(
      -eyeW / 2,
      -eyeH / 2,
      -eyeW / 2 + eyeR,
      -eyeH / 2,
    );

    const eyeGeometry = new THREE.ShapeGeometry(eyeShape);
    const eyeMaterial = new THREE.MeshBasicMaterial({
      color: this.roleAccentColor, // Role accent glow
    });

    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial.clone());
    leftEye.name = "leftEye";
    leftEye.position.set(-0.07, 0.03, 0.242);
    group.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial.clone());
    rightEye.name = "rightEye";
    rightEye.position.set(0.07, 0.03, 0.242);
    group.add(rightEye);

    // Cute mouth - small curved LED line
    const mouthCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.04, 0, 0),
      new THREE.Vector3(0, -0.015, 0),
      new THREE.Vector3(0.04, 0, 0),
    );
    const mouthPoints = mouthCurve.getPoints(10);
    const mouthGeometry = new THREE.BufferGeometry().setFromPoints(mouthPoints);
    const mouthMaterial = new THREE.LineBasicMaterial({
      color: this.roleAccentColor,
      transparent: true,
      opacity: 0.8,
    });
    const mouth = new THREE.Line(mouthGeometry, mouthMaterial);
    mouth.position.set(0, -0.04, 0.242);
    group.add(mouth);

    // Panel line details on head
    const panelGeometry = new THREE.RingGeometry(
      0.27,
      0.275,
      32,
      1,
      0,
      Math.PI,
    );
    const panelMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a2a3a,
      side: THREE.DoubleSide,
    });
    const panelLine = new THREE.Mesh(panelGeometry, panelMaterial);
    panelLine.rotation.x = Math.PI / 2;
    panelLine.position.y = 0.05;
    group.add(panelLine);

    // "Ear" speakers - cute round accents
    const earGeometry = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16);
    const earMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4a5a,
      roughness: 0.4,
      metalness: 0.6,
    });

    const leftEar = new THREE.Mesh(earGeometry, earMaterial);
    leftEar.rotation.z = Math.PI / 2;
    leftEar.position.set(-0.26, 0.02, 0);
    group.add(leftEar);

    const rightEar = new THREE.Mesh(earGeometry, earMaterial);
    rightEar.rotation.z = Math.PI / 2;
    rightEar.position.set(0.26, 0.02, 0);
    group.add(rightEar);

    group.position.y = 0.52;
    return group;
  }

  private createBody(): THREE.Group {
    const group = new THREE.Group();

    // Main body - chunky rounded shape
    const bodyGeometry = new THREE.CylinderGeometry(0.18, 0.22, 0.3, 16);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: this.options.color,
      roughness: 0.35,
      metalness: 0.65,
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.castShadow = true;
    group.add(body);

    // Chest panel with glow
    const panelGeometry = new THREE.PlaneGeometry(0.16, 0.12);
    const panelMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a2e,
      transparent: true,
      opacity: 0.8,
    });
    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.position.set(0, 0.02, 0.18);
    group.add(panel);

    // Chest light (status indicator - role accent)
    const lightGeometry = new THREE.CircleGeometry(0.03, 16);
    const lightMaterial = new THREE.MeshBasicMaterial({
      color: this.roleAccentColor,
      transparent: true,
      opacity: 0.9,
    });
    const chestLight = new THREE.Mesh(lightGeometry, lightMaterial);
    chestLight.position.set(0, 0.02, 0.181);
    chestLight.name = "chestLight";
    group.add(chestLight);

    // Belt/waist detail
    const beltGeometry = new THREE.TorusGeometry(0.2, 0.02, 8, 32);
    const beltMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a5a6a,
      roughness: 0.3,
      metalness: 0.7,
    });
    const belt = new THREE.Mesh(beltGeometry, beltMaterial);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = -0.12;
    group.add(belt);

    // Legs - stubby robot legs
    const legGeometry = new THREE.CylinderGeometry(0.06, 0.07, 0.15, 12);
    const legMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4a5a,
      roughness: 0.4,
      metalness: 0.6,
    });

    const leftLeg = new THREE.Mesh(legGeometry, legMaterial);
    leftLeg.position.set(-0.1, -0.22, 0);
    leftLeg.castShadow = true;
    group.add(leftLeg);

    const rightLeg = new THREE.Mesh(legGeometry, legMaterial);
    rightLeg.position.set(0.1, -0.22, 0);
    rightLeg.castShadow = true;
    group.add(rightLeg);

    // Feet - rounded robot feet
    const footGeometry = new THREE.SphereGeometry(0.07, 12, 8);
    footGeometry.scale(1.2, 0.5, 1.3);
    const footMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a3a4a,
      roughness: 0.4,
      metalness: 0.6,
    });

    const leftFoot = new THREE.Mesh(footGeometry, footMaterial);
    leftFoot.position.set(-0.1, -0.32, 0.02);
    leftFoot.name = "leftFoot";
    group.add(leftFoot);

    const rightFoot = new THREE.Mesh(footGeometry, footMaterial);
    rightFoot.position.set(0.1, -0.32, 0.02);
    rightFoot.name = "rightFoot";
    group.add(rightFoot);

    group.position.y = 0.22;
    return group;
  }

  private createArm(side: number): THREE.Group {
    const group = new THREE.Group();

    // Shoulder joint
    const shoulderGeometry = new THREE.SphereGeometry(0.05, 12, 12);
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a5a6a,
      roughness: 0.3,
      metalness: 0.7,
    });
    const shoulder = new THREE.Mesh(shoulderGeometry, jointMaterial);
    group.add(shoulder);

    // Arm segment
    const armGeometry = new THREE.CylinderGeometry(0.035, 0.04, 0.15, 10);
    const armMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4a5a,
      roughness: 0.4,
      metalness: 0.6,
    });
    const arm = new THREE.Mesh(armGeometry, armMaterial);
    arm.position.y = -0.1;
    arm.castShadow = true;
    group.add(arm);

    // Hand - cute rounded claw/gripper
    const handGeometry = new THREE.SphereGeometry(0.045, 12, 12);
    const hand = new THREE.Mesh(handGeometry, jointMaterial);
    hand.position.y = -0.18;
    hand.name = "hand";
    group.add(hand);

    group.position.set(side * 0.24, 0.26, 0);
    return group;
  }

  private createAntenna(): THREE.Group {
    const group = new THREE.Group();

    // Antenna base
    const baseGeometry = new THREE.CylinderGeometry(0.03, 0.04, 0.04, 12);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4a5a,
      roughness: 0.4,
      metalness: 0.6,
    });
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    group.add(base);

    // Antenna stalk
    const stalkGeometry = new THREE.CylinderGeometry(0.015, 0.02, 0.12, 8);
    const stalkMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a5a6a,
      roughness: 0.3,
      metalness: 0.7,
    });
    const stalk = new THREE.Mesh(stalkGeometry, stalkMaterial);
    stalk.position.y = 0.08;
    group.add(stalk);

    // Glowing tip (role accent color)
    const tipGeometry = new THREE.SphereGeometry(0.035, 12, 12);
    const tipMaterial = new THREE.MeshBasicMaterial({
      color: this.roleAccentColor,
      transparent: true,
      opacity: 0.9,
    });
    const tip = new THREE.Mesh(tipGeometry, tipMaterial);
    tip.position.y = 0.16;
    tip.name = "antennaTip";
    group.add(tip);

    group.position.set(0, 0.78, 0);
    return group;
  }

  private createGlowAccents(): THREE.Group {
    const group = new THREE.Group();

    // Glowing lines on the body (role accent)
    const lineMaterial = new THREE.MeshBasicMaterial({
      color: this.roleAccentColor,
      transparent: true,
      opacity: 0.4,
    });

    // Vertical lines on body
    const lineGeometry = new THREE.PlaneGeometry(0.01, 0.2);

    const leftLine = new THREE.Mesh(lineGeometry, lineMaterial.clone());
    leftLine.position.set(-0.12, 0.22, 0.19);
    group.add(leftLine);

    const rightLine = new THREE.Mesh(lineGeometry, lineMaterial.clone());
    rightLine.position.set(0.12, 0.22, 0.19);
    group.add(rightLine);

    return group;
  }

  private createStatusRing(): THREE.Mesh {
    const geometry = new THREE.RingGeometry(0.28, 0.32, 32);
    const material = new THREE.MeshBasicMaterial({
      color: this.options.statusColor,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    return ring;
  }

  private createThoughtBubbles(): THREE.Group {
    const group = new THREE.Group();

    // Hexagonal thought bubbles (fits the tech theme!)
    const sizes = [0.04, 0.06, 0.09];
    const positions = [
      { x: 0.3, y: 0.75, z: 0.1 },
      { x: 0.42, y: 0.9, z: 0.12 },
      { x: 0.52, y: 1.1, z: 0.14 },
    ];

    sizes.forEach((size, i) => {
      // Hexagon shape for tech feel
      const geometry = new THREE.CircleGeometry(size, 6);
      const material = new THREE.MeshBasicMaterial({
        color: this.roleAccentColor,
        transparent: true,
        opacity: 0.6,
      });
      const bubble = new THREE.Mesh(geometry, material);
      bubble.position.set(positions[i].x, positions[i].y, positions[i].z);
      bubble.rotation.z = Math.PI / 6; // Pointy top hex
      bubble.userData.baseY = positions[i].y;
      bubble.userData.offset = i * 0.7;
      group.add(bubble);
    });

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
    if (this.state !== "walking") {
      this.currentFacingAngle = this.mesh.rotation.y;
      this.currentMoveSpeed = 0;
    }
    this.state = "walking";
    this.updateStatusColor();
  }

  moveToPosition(position: THREE.Vector3, station: StationType): void {
    this.targetPosition = position.clone();
    this.currentStation = station;
    if (this.state !== "walking") {
      this.currentFacingAngle = this.mesh.rotation.y;
      this.currentMoveSpeed = 0;
    }
    this.state = "walking";
    this.updateStatusColor();
  }

  shiftTargetPosition(delta: THREE.Vector3): void {
    if (this.targetPosition) {
      this.targetPosition.add(delta);
    }
  }

  setState(state: ClaudeState): void {
    const parts = this.getCharacterParts();

    // Stop any idle behaviors when leaving idle state
    if (this.state === "idle" && state !== "idle") {
      this.idleBehaviorManager.stop(parts);
    }

    // Stop working behaviors when leaving working state
    if (this.state === "working" && state !== "working") {
      this.workingBehaviorManager.stop(parts);
    }

    this.state = state;
    this.updateStatusColor();

    if (state === "working") {
      this.workTime = 0;
      // Start station-specific working animation
      this.workingBehaviorManager.start(this.currentStation, parts);
    } else if (state === "thinking") {
      this.thinkTime = 0;
    }
  }

  /** Get character parts for idle behavior system */
  private getCharacterParts(): CharacterParts {
    return {
      head: this.head,
      leftEye: this.leftEye,
      rightEye: this.rightEye,
      leftArm: this.leftArm,
      rightArm: this.rightArm,
      antenna: this.antenna,
      body: this.body,
      mesh: this.mesh,
    };
  }

  private updateStatusColor(): void {
    const material = this.statusRing.material as THREE.MeshBasicMaterial;
    const antennaTip = this.antenna.getObjectByName("antennaTip") as THREE.Mesh;
    const antennaMaterial = antennaTip.material as THREE.MeshBasicMaterial;
    const leftEyeMat = this.leftEye.material as THREE.MeshBasicMaterial;
    const rightEyeMat = this.rightEye.material as THREE.MeshBasicMaterial;

    switch (this.state) {
      case "idle":
        material.color.setHex(this.options.statusColor); // Role color or default green
        material.opacity = 0.5;
        antennaMaterial.color.setHex(this.roleAccentColor);
        leftEyeMat.color.setHex(this.roleAccentColor);
        rightEyeMat.color.setHex(this.roleAccentColor);
        break;
      case "walking":
        material.color.setHex(0x60a5fa); // Blue
        material.opacity = 0.6;
        antennaMaterial.color.setHex(0x60a5fa);
        leftEyeMat.color.setHex(0x60a5fa);
        rightEyeMat.color.setHex(0x60a5fa);
        break;
      case "working":
        material.color.setHex(0xfbbf24); // Amber
        material.opacity = 0.7;
        antennaMaterial.color.setHex(0xfbbf24);
        leftEyeMat.color.setHex(0xfbbf24);
        rightEyeMat.color.setHex(0xfbbf24);
        break;
      case "thinking":
        material.color.setHex(0xa78bfa); // Purple
        material.opacity = 0.6;
        antennaMaterial.color.setHex(0xa78bfa);
        leftEyeMat.color.setHex(0xa78bfa);
        rightEyeMat.color.setHex(0xa78bfa);
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

        // Smooth speed: accelerate from rest, decelerate near target
        const decelZone = 2.0;
        const decelFactor = distance < decelZone ? distance / decelZone : 1.0;
        const desiredSpeed = this.moveSpeed * decelFactor;
        const accelLerp = 1 - Math.exp(-6 * delta);
        this.currentMoveSpeed +=
          (desiredSpeed - this.currentMoveSpeed) * accelLerp;
        this.currentMoveSpeed = Math.max(this.currentMoveSpeed, 0.3);
        const moveDistance = Math.min(this.currentMoveSpeed * delta, distance);
        this.mesh.position.add(direction.multiplyScalar(moveDistance));

        // Smooth facing: lerp rotation instead of snapping
        const targetAngle = Math.atan2(direction.x, direction.z);
        let angleDiff = targetAngle - this.currentFacingAngle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        const facingLerp = 1 - Math.exp(-10 * delta);
        this.currentFacingAngle += angleDiff * facingLerp;
        while (this.currentFacingAngle > Math.PI)
          this.currentFacingAngle -= Math.PI * 2;
        while (this.currentFacingAngle < -Math.PI)
          this.currentFacingAngle += Math.PI * 2;
        this.mesh.rotation.y = this.currentFacingAngle;

        // Walking animation (speed-responsive)
        const speedRatio = this.currentMoveSpeed / this.moveSpeed;
        this.bobTime += delta * (8 + 4 * speedRatio);

        // Body bob
        this.head.position.y = 0.52 + Math.abs(Math.sin(this.bobTime)) * 0.04;

        // Arm swing (amplitude scales with speed)
        const armSwing = 0.25 + 0.15 * speedRatio;
        this.leftArm.rotation.x = Math.sin(this.bobTime) * armSwing;
        this.rightArm.rotation.x = Math.sin(this.bobTime + Math.PI) * armSwing;

        // Feet movement
        const leftFoot = this.body.getObjectByName("leftFoot") as THREE.Mesh;
        const rightFoot = this.body.getObjectByName("rightFoot") as THREE.Mesh;
        if (leftFoot && rightFoot) {
          leftFoot.position.y =
            -0.32 + Math.max(0, Math.sin(this.bobTime)) * 0.03;
          rightFoot.position.y =
            -0.32 + Math.max(0, Math.sin(this.bobTime + Math.PI)) * 0.03;
        }

        // Antenna bounce
        this.antenna.rotation.x = Math.sin(this.bobTime * 1.5) * 0.15;

        // Eyes look forward (eager)
        this.leftEye.scale.setScalar(1.1);
        this.rightEye.scale.setScalar(1.1);
      } else {
        this.mesh.position.copy(this.targetPosition);
        this.targetPosition = null;
        this.currentMoveSpeed = 0;
        this.setState(this.currentStation === "center" ? "idle" : "working");
      }
    }

    // Idle animation
    if (this.state === "idle") {
      this.bobTime += delta * 2;

      // Check if a special behavior is playing
      const behaviorPlaying = this.idleBehaviorManager.update(
        this.getCharacterParts(),
        delta,
      );

      // Only run base idle animation when no special behavior is playing
      if (!behaviorPlaying) {
        // Gentle hover/bob
        this.head.position.y = 0.52 + Math.sin(this.bobTime) * 0.015;

        // Antenna gentle sway
        this.antenna.rotation.z = Math.sin(this.bobTime * 0.7) * 0.1;

        // Arms relaxed
        this.leftArm.rotation.x = Math.sin(this.bobTime * 0.5) * 0.05;
        this.rightArm.rotation.x = Math.sin(this.bobTime * 0.5 + 0.5) * 0.05;

        // Occasional "blink" (eyes shrink briefly)
        const blinkCycle = (this.bobTime * 0.4) % (Math.PI * 2);
        if (blinkCycle < 0.15) {
          this.leftEye.scale.setScalar(0.3);
          this.rightEye.scale.setScalar(0.3);
        } else {
          this.leftEye.scale.setScalar(1);
          this.rightEye.scale.setScalar(1);
        }
      }
    }

    // Working animation - uses station-specific behaviors
    if (this.state === "working") {
      this.workTime += delta;

      // Run station-specific working animation
      this.workingBehaviorManager.update(this.getCharacterParts(), delta);

      // Small thought bubbles while working
      this.thinkTime += delta * 3;
      this.thoughtBubbles.visible = true;
      this.thoughtBubbles.scale.setScalar(0.5);
      this.thoughtBubbles.children.forEach((bubble) => {
        const mesh = bubble as THREE.Mesh;
        const baseY = mesh.userData.baseY as number;
        const offset = mesh.userData.offset as number;
        mesh.position.y = baseY + Math.sin(this.thinkTime * 3 + offset) * 0.03;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.3 + Math.sin(this.thinkTime * 4 + offset) * 0.2;
      });
    }

    // Thinking animation
    if (this.state === "thinking") {
      this.thinkTime += delta * 2;

      // Head tilt (pondering)
      this.head.rotation.z = Math.sin(this.thinkTime * 0.5) * 0.1;
      this.head.position.y = 0.52 + Math.sin(this.thinkTime) * 0.01;

      // One arm up in thinking pose
      this.rightArm.rotation.x = -0.8;
      this.rightArm.rotation.z = -0.3 + Math.sin(this.thinkTime) * 0.05;
      this.leftArm.rotation.x = Math.sin(this.thinkTime * 0.7) * 0.1;

      // Antenna searching
      this.antenna.rotation.z = Math.sin(this.thinkTime) * 0.2;
      this.antenna.rotation.x = Math.sin(this.thinkTime * 0.7) * 0.15;

      // Eyes look up and around
      this.leftEye.position.x = -0.07 + Math.sin(this.thinkTime * 0.5) * 0.02;
      this.rightEye.position.x = 0.07 + Math.sin(this.thinkTime * 0.5) * 0.02;
      this.leftEye.position.y = 0.03 + 0.01;
      this.rightEye.position.y = 0.03 + 0.01;

      // Full thought bubbles
      this.thoughtBubbles.visible = true;
      this.thoughtBubbles.scale.setScalar(1);
      this.thoughtBubbles.children.forEach((bubble) => {
        const mesh = bubble as THREE.Mesh;
        const baseY = mesh.userData.baseY as number;
        const offset = mesh.userData.offset as number;
        mesh.position.y = baseY + Math.sin(this.thinkTime * 2 + offset) * 0.05;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.5 + Math.sin(this.thinkTime * 3 + offset) * 0.3;
      });
    } else if (this.state !== "working") {
      this.thoughtBubbles.visible = false;
      // Reset positions
      this.leftEye.position.set(-0.07, 0.03, 0.242);
      this.rightEye.position.set(0.07, 0.03, 0.242);
      this.head.rotation.z = 0;
      this.rightArm.rotation.z = 0;
    }

    // Status ring rotation
    this.statusRing.rotation.z += delta * 0.3;

    // Glowing accents pulse
    this.glowAccents.children.forEach((line, i) => {
      const mat = (line as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = 0.3 + Math.sin(Date.now() * 0.002 + i) * 0.2;
    });

    // Antenna tip glow pulse
    const antennaTip = this.antenna.getObjectByName("antennaTip") as THREE.Mesh;
    if (antennaTip) {
      const mat = antennaTip.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.7 + Math.sin(Date.now() * 0.003) * 0.2;
    }

    // Chest light pulse
    const chestLight = this.body.getObjectByName("chestLight") as THREE.Mesh;
    if (chestLight) {
      const mat = chestLight.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.6 + Math.sin(Date.now() * 0.004) * 0.3;
    }
  }

  // ============================================================================
  // Dev/Debug API
  // ============================================================================

  /** Get list of idle behavior names (for dev UI) */
  getIdleBehaviorNames(): string[] {
    return this.idleBehaviorManager.getBehaviorNames();
  }

  /** Force play a specific idle behavior (for dev/testing) */
  playIdleBehavior(name: string): boolean {
    // Force to idle state first
    if (this.state !== "idle") {
      this.setState("idle");
    }
    return this.idleBehaviorManager.forcePlay(name, this.getCharacterParts());
  }

  /** Play a random idle behavior (for zone activation, etc.) */
  playRandomIdleBehavior(): string | null {
    // Force to idle state first
    if (this.state !== "idle") {
      this.setState("idle");
    }
    return this.idleBehaviorManager.forcePlayRandom(this.getCharacterParts());
  }

  /** Get list of station working behavior names (for dev UI) */
  getWorkingBehaviorStations(): string[] {
    return Object.keys(STATION_ANIMATIONS);
  }

  /** Force play a specific station's working behavior (for dev/testing) */
  playWorkingBehavior(station: string): void {
    // Force to working state at specified station
    this.currentStation = station as StationType;
    this.setState("working");
  }

  // ============================================================================
  // Realm: Floating Labels
  // ============================================================================

  /** Create a floating name label sprite above the character */
  private createNameLabel(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = 256;
    canvas.height = 64;

    // Background pill shape
    const accentHex = "#" + this.roleAccentColor.toString(16).padStart(6, "0");
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    const radius = 16;
    const x = 8,
      y = 8,
      w = 240,
      h = 48;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();

    // Accent border
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text
    ctx.fillStyle = accentHex;
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.2, 0.3, 1);
    sprite.position.set(0, 1.05, 0);
    return sprite;
  }

  /** Create a floating task label sprite (smaller, below name) */
  private createTaskLabel(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = 512;
    canvas.height = 48;

    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, 512, 48);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "18px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const truncated = text.length > 40 ? text.slice(0, 37) + "..." : text;
    ctx.fillText(truncated, 256, 24);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.6, 0.15, 1);
    sprite.position.set(0, 0.9, 0);
    return sprite;
  }

  /** Update the task label text dynamically */
  setTaskLabel(text: string): void {
    if (this.taskLabelSprite) {
      this.mesh.remove(this.taskLabelSprite);
      const mat = this.taskLabelSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.taskLabelSprite = null;
    }

    if (text) {
      this.taskLabelSprite = this.createTaskLabel(text);
      this.mesh.add(this.taskLabelSprite);
    }
  }

  dispose(): void {
    if (this.updateCallback) {
      this.scene.offRender(this.updateCallback);
      this.updateCallback = null;
    }

    this.scene.scene.remove(this.mesh);

    // Dispose geometries and materials
    const disposeMesh = (obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      }
    };

    this.mesh.traverse(disposeMesh);
  }
}
