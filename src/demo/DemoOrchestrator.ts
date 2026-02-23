/**
 * DemoOrchestrator - Sets up the Realm demo scene
 *
 * Creates a virtual office with 4 AI agents at workstations,
 * a shared meeting room area, and runs the demo sequence
 * for the product video.
 */

import * as THREE from "three";
import type { WorkshopScene, Zone } from "../scene/WorkshopScene";
import type { RealmRole } from "../../shared/types";
import { REALM_ROLES } from "../../shared/types";
import { Claude } from "../entities/ClaudeMon";
import { TaskDecomposition, DEMO_TASKS } from "./TaskDecomposition";

// ============================================================================
// Types
// ============================================================================

export interface DemoAgent {
  role: RealmRole;
  character: Claude;
  zone: Zone;
  sessionId: string;
}

interface DemoConfig {
  scene: WorkshopScene;
}

// ============================================================================
// Constants
// ============================================================================

/** Zone placement for 4 agents in a 2x2 office grid */
const AGENT_POSITIONS: Array<{
  role: RealmRole;
  hintX: number;
  hintZ: number;
}> = [
  { role: "engineer", hintX: -12, hintZ: -12 }, // Top-left
  { role: "marketer", hintX: 12, hintZ: -12 }, // Top-right
  { role: "designer", hintX: -12, hintZ: 12 }, // Bottom-left
  { role: "analyst", hintX: 12, hintZ: 12 }, // Bottom-right
];

// ============================================================================
// DemoOrchestrator Class
// ============================================================================

export class DemoOrchestrator {
  private scene: WorkshopScene;
  private agents: Map<RealmRole, DemoAgent> = new Map();
  private meetingRoom: THREE.Group | null = null;
  private taskDecomposition: TaskDecomposition;
  private isRunning = false;

  constructor(config: DemoConfig) {
    this.scene = config.scene;
    this.taskDecomposition = new TaskDecomposition(config.scene.scene);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Set up the full office scene with 4 agents
   */
  setupOffice(): void {
    // Create 4 agent zones
    for (const agentConfig of AGENT_POSITIONS) {
      const sessionId = `realm-${agentConfig.role}`;
      const roleConfig = REALM_ROLES[agentConfig.role];

      // Create zone with role-specific color
      const zone = this.scene.createZone(sessionId, {
        color: roleConfig.statusColor,
        hintPosition: { x: agentConfig.hintX, z: agentConfig.hintZ },
      });

      // Update zone label to show role name
      this.scene.updateZoneLabel(sessionId, roleConfig.label);

      // Create character with role variant
      const character = new Claude(this.scene, {
        role: agentConfig.role,
        startStation: "center",
        displayName: roleConfig.name,
      });

      // Position character at zone center
      const centerStation = zone.stations.get("center");
      if (centerStation) {
        character.mesh.position.copy(centerStation.position);
      }

      this.agents.set(agentConfig.role, {
        role: agentConfig.role,
        character,
        zone,
        sessionId,
      });
    }

    // Create central meeting room
    this.createMeetingRoom();
  }

  /**
   * Get a demo agent by role
   */
  getAgent(role: RealmRole): DemoAgent | undefined {
    return this.agents.get(role);
  }

  /**
   * Trigger task decomposition animation independently
   */
  async decomposeTask(): Promise<void> {
    await this.phaseTaskDecomposition();
  }

  /**
   * Run the full demo sequence for the video
   */
  async runDemoSequence(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Phase 1: All agents idle at their desks (2s)
      await this.delay(2000);

      // Phase 1.5: Task decomposition animation (cards fly to agents)
      await this.phaseTaskDecomposition();

      // Phase 2: Agents start working (scattered start)
      await this.phaseStartWorking();

      // Phase 3: Agents work at various stations (8s)
      await this.phaseAgentsWorking();

      // Phase 4: Morning meeting - agents gather
      await this.phaseMorningMeeting();
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Make all agents gather in the meeting room area
   */
  async gatherForMeeting(): Promise<void> {
    if (!this.meetingRoom) return;

    const meetingPos = this.meetingRoom.position.clone();
    const offsets = [
      new THREE.Vector3(-1.5, 0, -1.5),
      new THREE.Vector3(1.5, 0, -1.5),
      new THREE.Vector3(-1.5, 0, 1.5),
      new THREE.Vector3(1.5, 0, 1.5),
    ];

    let i = 0;
    for (const agent of this.agents.values()) {
      const targetPos = meetingPos.clone().add(offsets[i]);
      agent.character.moveToPosition(targetPos, "center");
      i++;
      await this.delay(300); // Stagger arrivals
    }

    // Wait for all to arrive
    await this.delay(3000);

    // Set all to thinking (meeting pose)
    for (const agent of this.agents.values()) {
      agent.character.setState("thinking");
    }
  }

  /**
   * Send agents back to their workstations
   */
  async dismissMeeting(): Promise<void> {
    for (const agent of this.agents.values()) {
      const centerStation = agent.zone.stations.get("center");
      if (centerStation) {
        agent.character.moveToPosition(centerStation.position, "center");
      }
      await this.delay(200);
    }
  }

  /**
   * Make a specific agent move to a station and work
   */
  agentWorkAt(role: RealmRole, station: string): void {
    const agent = this.agents.get(role);
    if (!agent) return;

    const targetStation = agent.zone.stations.get(station as any);
    if (targetStation) {
      agent.character.moveToPosition(targetStation.position, station as any);
    }
  }

  /**
   * Set task label for an agent
   */
  setAgentTask(role: RealmRole, task: string): void {
    const agent = this.agents.get(role);
    if (!agent) return;
    agent.character.setTaskLabel(task);
  }

  // --------------------------------------------------------------------------
  // Meeting Room Creation
  // --------------------------------------------------------------------------

  private createMeetingRoom(): void {
    this.meetingRoom = new THREE.Group();

    // Position at world center (between the 4 zones)
    this.meetingRoom.position.set(0, 0, 0);

    // Conference table
    const tableGeo = new THREE.BoxGeometry(4, 0.15, 2.5);
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x2a3540,
      roughness: 0.6,
      metalness: 0.3,
    });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.y = 0.75;
    table.castShadow = true;
    table.receiveShadow = true;
    this.meetingRoom.add(table);

    // Table legs
    const legGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.7, 8);
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x1a2530,
      roughness: 0.5,
      metalness: 0.4,
    });
    const legPositions = [
      [-1.7, 0.35, -1.0],
      [1.7, 0.35, -1.0],
      [-1.7, 0.35, 1.0],
      [1.7, 0.35, 1.0],
    ];
    for (const [lx, ly, lz] of legPositions) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, ly, lz);
      this.meetingRoom.add(leg);
    }

    // Whiteboard (standing behind the table)
    const boardGeo = new THREE.BoxGeometry(3.5, 2, 0.1);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xf0f0f0,
      roughness: 0.9,
      metalness: 0.0,
    });
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.set(0, 2.0, -2.0);
    board.castShadow = true;
    this.meetingRoom.add(board);

    // Whiteboard frame
    const frameGeo = new THREE.BoxGeometry(3.7, 2.2, 0.05);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x404050,
      roughness: 0.5,
      metalness: 0.3,
    });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.set(0, 2.0, -2.05);
    this.meetingRoom.add(frame);

    // Whiteboard stand/legs
    const standGeo = new THREE.BoxGeometry(0.08, 3.2, 0.08);
    const standMat = new THREE.MeshStandardMaterial({
      color: 0x404050,
      roughness: 0.5,
      metalness: 0.4,
    });
    const leftStand = new THREE.Mesh(standGeo, standMat);
    leftStand.position.set(-1.7, 1.6, -2.0);
    this.meetingRoom.add(leftStand);

    const rightStand = new THREE.Mesh(standGeo, standMat);
    rightStand.position.set(1.7, 1.6, -2.0);
    this.meetingRoom.add(rightStand);

    // Floor marker - meeting area indicator ring
    const ringGeo = new THREE.RingGeometry(3.5, 3.7, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xa78bfa,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.meetingRoom.add(ring);

    // "Meeting Room" label
    const label = this.createTextSprite("Meeting Room", 0xa78bfa);
    label.position.set(0, 4.5, 0);
    this.meetingRoom.add(label);

    this.scene.scene.add(this.meetingRoom);
  }

  private createTextSprite(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;

    // Background pill
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    ctx.fillStyle = `rgba(${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(b * 255)}, 0.15)`;
    const pillW = 480;
    const pillH = 80;
    const pillX = (512 - pillW) / 2;
    const pillY = (128 - pillH) / 2;
    const pillR = 20;
    ctx.beginPath();
    ctx.moveTo(pillX + pillR, pillY);
    ctx.lineTo(pillX + pillW - pillR, pillY);
    ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR);
    ctx.lineTo(pillX + pillW, pillY + pillH - pillR);
    ctx.quadraticCurveTo(
      pillX + pillW,
      pillY + pillH,
      pillX + pillW - pillR,
      pillY + pillH,
    );
    ctx.lineTo(pillX + pillR, pillY + pillH);
    ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR);
    ctx.lineTo(pillX, pillY + pillR);
    ctx.quadraticCurveTo(pillX, pillY, pillX + pillR, pillY);
    ctx.closePath();
    ctx.fill();

    // Border
    ctx.strokeStyle = `rgba(${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(b * 255)}, 0.4)`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 40px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(5, 1.25, 1);
    return sprite;
  }

  // --------------------------------------------------------------------------
  // Demo Phases
  // --------------------------------------------------------------------------

  private async phaseTaskDecomposition(): Promise<void> {
    // Origin: center of the scene (meeting room area)
    const origin = new THREE.Vector3(0, 2, 0);

    // Build target positions from agent zones
    const targets = new Map<RealmRole, THREE.Vector3>();
    for (const [role, agent] of this.agents) {
      const center = agent.zone.stations.get("center");
      if (center) {
        targets.set(role, center.position.clone());
      }
    }

    // Run the card animation
    await new Promise<void>((resolve) => {
      this.taskDecomposition.animate(origin, DEMO_TASKS, targets, resolve);
    });

    // Brief pause after cards arrive
    await this.delay(800);
  }

  private async phaseStartWorking(): Promise<void> {
    // Stagger agents starting to work at different stations
    const tasks: Array<{
      role: RealmRole;
      station: string;
      task: string;
      delay: number;
    }> = [
      {
        role: "engineer",
        station: "terminal",
        task: "Writing migration script",
        delay: 0,
      },
      {
        role: "marketer",
        station: "antenna",
        task: "Researching competitors",
        delay: 500,
      },
      {
        role: "designer",
        station: "desk",
        task: "Creating mockups",
        delay: 800,
      },
      {
        role: "analyst",
        station: "scanner",
        task: "Pulling user metrics",
        delay: 1200,
      },
    ];

    for (const task of tasks) {
      await this.delay(task.delay);
      this.setAgentTask(task.role, task.task);
      this.agentWorkAt(task.role, task.station);
    }
  }

  private async phaseAgentsWorking(): Promise<void> {
    // Simulate agents moving between stations over time
    await this.delay(3000);

    // Engineer finishes terminal, moves to workbench
    this.setAgentTask("engineer", "Deploying to staging");
    this.agentWorkAt("engineer", "workbench");

    await this.delay(2000);

    // Marketer finishes research, moves to desk to write
    this.setAgentTask("marketer", "Writing press release");
    this.agentWorkAt("marketer", "desk");

    await this.delay(2000);

    // Designer moves to scanner to review references
    this.setAgentTask("designer", "Reviewing design system");
    this.agentWorkAt("designer", "scanner");

    await this.delay(1500);

    // Analyst moves to taskboard to plan report
    this.setAgentTask("analyst", "Generating report");
    this.agentWorkAt("analyst", "taskboard");
  }

  private async phaseMorningMeeting(): Promise<void> {
    // Clear task labels
    for (const role of [
      "engineer",
      "marketer",
      "designer",
      "analyst",
    ] as RealmRole[]) {
      this.setAgentTask(role, "");
    }

    // Gather all agents at meeting room
    await this.gatherForMeeting();

    // Set sequential "presenting" state
    await this.delay(2000);

    // Engineer presents
    const engineer = this.agents.get("engineer");
    if (engineer) {
      this.setAgentTask("engineer", "Presenting: Staging deploy");
      engineer.character.setState("working");
      await this.delay(3000);
      engineer.character.setState("thinking");
      this.setAgentTask("engineer", "");
    }

    // Marketer presents
    const marketer = this.agents.get("marketer");
    if (marketer) {
      this.setAgentTask("marketer", "Presenting: Launch strategy");
      marketer.character.setState("working");
      await this.delay(3000);
      marketer.character.setState("thinking");
      this.setAgentTask("marketer", "");
    }

    // Designer presents
    const designer = this.agents.get("designer");
    if (designer) {
      this.setAgentTask("designer", "Presenting: 2 mockup options");
      designer.character.setState("working");
      await this.delay(3000);
      designer.character.setState("thinking");
      this.setAgentTask("designer", "");
    }

    // Analyst presents
    const analyst = this.agents.get("analyst");
    if (analyst) {
      this.setAgentTask("analyst", "Presenting: Readiness report");
      analyst.character.setState("working");
      await this.delay(3000);
      analyst.character.setState("thinking");
      this.setAgentTask("analyst", "");
    }
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clean up demo resources
   */
  dispose(): void {
    // Dispose characters
    for (const agent of this.agents.values()) {
      agent.character.dispose();
    }
    this.agents.clear();

    // Remove meeting room
    if (this.meetingRoom) {
      this.scene.scene.remove(this.meetingRoom);
      this.meetingRoom.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
      this.meetingRoom = null;
    }

    // Dispose task decomposition
    this.taskDecomposition.dispose();
  }
}
