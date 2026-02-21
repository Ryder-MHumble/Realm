/**
 * WorkshopScene - The main 3D environment
 *
 * A cozy workshop where Claude works at different stations
 * Supports multiple zones for multi-session visualization
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { StationType, TextTile } from "../../shared/types";
import { HexGrid } from "../utils/HexGrid";
import { soundManager } from "../audio";
import {
  ZoneNotifications,
  type NotificationOptions,
} from "./ZoneNotifications";
import { StationPanels } from "./StationPanels";
import { drawMode } from "../ui/DrawMode";
import {
  addBookshelfDetails,
  addTerminalDetails,
  addAntennaDetails,
  addPortalDetails,
  addScannerDetails,
  addDeskDetails,
  addWorkbenchDetails,
  addTaskboardDetails,
} from "./stations";

export interface Station {
  type: StationType;
  position: THREE.Vector3; // World position (updated when zone elevation changes)
  localPosition: THREE.Vector3; // Position relative to zone (for recalculating world pos)
  mesh: THREE.Group;
  label: string;
  contextSprite?: THREE.Sprite;
}

export type AttentionReason = "question" | "finished" | "error" | null;

export interface Zone {
  id: string;
  group: THREE.Group;
  stations: Map<StationType, Station>;
  platform: THREE.Mesh;
  ring: THREE.Mesh;
  floor: THREE.Mesh;
  color: number;
  position: THREE.Vector3;
  label?: THREE.Sprite;
  gitLabel?: THREE.Sprite; // Git status display on floor
  pulseIntensity: number; // For activity pulse effect
  attentionReason: AttentionReason; // Persistent attention state
  attentionTime: number; // Time accumulator for attention pulse
  particles: THREE.Points;
  particleVelocities: Float32Array;
  status: "idle" | "working" | "waiting" | "attention" | "offline";
  // Animation state for enter/exit transitions
  animationState?: "entering" | "exiting";
  animationProgress?: number; // 0 to 1
  // Elevation from painting hexes under the zone (raises the platform)
  // NOTE: zone.position.y is always 0. Components needing world Y must add elevation:
  //   - focusZone(): camera target includes elevation
  //   - ZoneNotifications: tracks elevations via updateZoneElevation callback
  //   - Claude position: updated via onZoneElevation callback in main.ts
  //   - Click pulses: manually add elevation in main.ts click handler
  elevation: number;
  // Vertical edge lines (shown when elevated)
  edgeLines?: THREE.LineSegments;
  // Solid side faces (shown when elevated)
  sideMesh?: THREE.Mesh;
}

export type CameraMode = "focused" | "overview" | "follow-active";

// Zone colors for different sessions - ice/cyan theme
export const ZONE_COLORS = [
  0x4ac8e8, // Cyan (primary)
  0x60a5fa, // Blue
  0x22d3d8, // Teal
  0x4ade80, // Green
  0xa78bfa, // Purple
  0xfbbf24, // Orange
  0xf472b6, // Pink
  0xa3e635, // Lime
];

export class WorkshopScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public controls: OrbitControls;

  // Multi-zone support
  public zones: Map<string, Zone> = new Map();
  public hexGrid: HexGrid; // Hex grid for zone placement
  private zoneColorIndex = 0; // For cycling through colors

  // Pending zones (loading animation before zone is created)
  private pendingZones: Map<
    string,
    {
      group: THREE.Group;
      spinner: THREE.Group;
      ring: THREE.Line;
      position: THREE.Vector3;
      age: number;
    }
  > = new Map();

  // Pending zone animation constants
  private static readonly PENDING = {
    DOT_COUNT: 3,
    DOT_RADIUS: 0.3,
    DOT_SEGMENTS: 8,
    SPINNER_RADIUS: 1.5,
    SPINNER_HEIGHT: 0.5,
    ROTATION_SPEED: 2,
    PULSE_SPEED: 3,
    SCALE_BASE: 0.8,
    SCALE_RANGE: 0.3,
    BOB_RANGE: 0.2,
    RING_OPACITY_BASE: 0.3,
    RING_OPACITY_RANGE: 0.2,
    RING_PULSE_SPEED: 2,
  } as const;

  // Camera modes
  public cameraMode: CameraMode = "focused";
  public focusedZoneId: string | null = null;
  private onCameraModeChange: ((mode: CameraMode) => void) | null = null;
  private onZoneElevationChange:
    | ((sessionId: string, elevation: number) => void)
    | null = null;

  // Pending zone elevations (loaded from localStorage, applied when zones are created)
  private pendingZoneElevations: Map<string, number> = new Map();

  // Camera animation
  private cameraTargetPos = new THREE.Vector3();
  private cameraTargetLookAt = new THREE.Vector3();
  private cameraAnimating = false;
  private readonly cameraLerpSpeed = 8; // Higher = faster animation

  // Legacy single-zone compat (points to first zone)
  public stations: Map<StationType, Station> = new Map();

  private container: HTMLElement;
  private animationId: number | null = null;
  private onRenderCallbacks: Array<(delta: number) => void> = [];
  private clock = new THREE.Clock();

  // FPS tracking
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private fpsElement: HTMLElement | null = null;

  // Click pulse effects (ring expands, hex fades)
  private clickPulses: Array<{
    mesh: THREE.Mesh | THREE.Line;
    age: number;
    maxAge: number;
    type?: "ring" | "hex" | "ripple";
    delay?: number; // Delay before animation starts (for ripple effect)
    startOpacity?: number; // Peak opacity when flashing
    baseOpacity?: number; // Opacity to fade back to (matches permanent grid)
    highlightColor?: THREE.Color; // Color to flash to
    baseColor?: THREE.Color; // Color to fade back to
  }> = [];

  // Station glow pulses (brief highlight when tool uses station)
  private stationPulses: Array<{
    ring: THREE.Mesh;
    age: number;
    maxAge: number;
    baseOpacity: number;
    peakOpacity: number;
  }> = [];

  // Floating notifications (file changes, etc.) - OLD, replaced by ZoneNotifications
  private notifications: Array<{
    sprite: THREE.Sprite;
    startY: number;
    age: number;
    maxAge: number;
  }> = [];

  // Zone notification system (new)
  public zoneNotifications: ZoneNotifications;

  // Station info panels
  public stationPanels: StationPanels;

  // Ambient floating particles
  private ambientParticles: THREE.Points | null = null;
  private ambientParticleData: Array<{
    baseY: number;
    phase: number;
    speed: number;
    radius: number;
    angle: number;
  }> = [];

  // Time accumulator for animations
  private time = 0;

  // World hex grid overlay
  private worldHexGrid: THREE.Group | THREE.LineSegments | null = null;

  // Text tiles (grid labels)
  private textTileSprites = new Map<
    string,
    {
      sprite: THREE.Sprite;
      tile: TextTile;
    }
  >();

  // Painted hexes (draw mode) - stores mesh, height, and color
  private paintedHexes = new Map<
    string,
    { mesh: THREE.Mesh; height: number; color: number }
  >();

  // Hex hover highlight
  private hoverHighlight: THREE.Line | null = null;

  // Zone group connection lines (Civ6-style links between grouped zones)
  private groupLinks: Map<
    string,
    {
      line: THREE.Line;
      glowLine: THREE.Line;
      label?: THREE.Sprite;
      memberIds: string[]; // claude session IDs
    }
  > = new Map();
  private groupLinkTime = 0;

  // Drag preview (ghost hex for zone drag-and-drop)
  private dragPreview: THREE.Group | null = null;
  private hoverRaycaster = new THREE.Raycaster();
  private hoverMouse = new THREE.Vector2();
  private lastHoveredHex: { q: number; r: number } | null = null;

  // === HOVER SOUND TUNING ===
  // Set to false to disable hover sounds entirely
  private readonly HOVER_SOUND_ENABLED = true;
  // Expected radius of the playable hex grid (in hex units)
  // Used to normalize distance for pitch calculation
  // Increase this if you expand the grid
  private readonly HOVER_SOUND_MAX_RADIUS = 8;

  // World grid size (number of hex rings from center)
  private gridRange = 20;

  constructor(container: HTMLElement) {
    this.container = container;

    // Scene - dark blue-black like ice cave
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080c14);
    // No fog - allows viewing multiple zones without fadeout

    // Hex grid for zone placement (radius=10, spacing=1.0 for touching hexes)
    this.hexGrid = new HexGrid(10, 1.0);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      500, // Far plane extended for multi-zone viewing
    );
    this.camera.position.set(8, 6, 8);
    this.camera.lookAt(0, 0, 0);

    // Renderer - optimized for performance
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // Disable for performance (can enable if needed)
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Lower max
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap; // Fastest shadow type
    container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 150; // Extended for multi-zone overview
    this.controls.target.set(0, 0, 0);

    // Stop camera animation when user manually interacts with controls
    this.controls.addEventListener("start", () => {
      this.cameraAnimating = false;
    });

    // Setup
    this.setupLighting();
    this.createWorldFloor(); // Invisible, just for click detection
    this.createWorldHexGrid();
    this.createAmbientParticles();
    this.setupHoverHighlight();

    // Initialize zone notification system
    this.zoneNotifications = new ZoneNotifications(this.scene);

    // Initialize station panels
    this.stationPanels = new StationPanels(this.scene);

    // Handle resize
    window.addEventListener("resize", this.handleResize);
  }

  /**
   * Setup hex hover highlight effect
   */
  private setupHoverHighlight(): void {
    // Create hex outline for hover highlight
    const hexRadius = this.hexGrid.hexRadius;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      points.push(
        new THREE.Vector3(
          hexRadius * Math.cos(angle),
          0.03,
          hexRadius * Math.sin(angle),
        ),
      );
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x8eeeff, // Light cyan
      transparent: true,
      opacity: 0.7,
    });

    this.hoverHighlight = new THREE.Line(geometry, material);
    this.hoverHighlight.visible = false;
    this.scene.add(this.hoverHighlight);

    // Listen for mouse movement
    this.renderer.domElement.addEventListener("mousemove", this.handleHover);
    this.renderer.domElement.addEventListener(
      "mouseleave",
      this.handleHoverLeave,
    );
  }

  private handleHover = (event: MouseEvent): void => {
    if (!this.hoverHighlight || !this.worldFloor) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.hoverMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.hoverRaycaster.setFromCamera(this.hoverMouse, this.camera);
    const intersects = this.hoverRaycaster.intersectObject(this.worldFloor);

    if (intersects.length > 0) {
      const point = intersects[0].point;
      const hexCoord = this.hexGrid.cartesianToHex(point.x, point.z);
      const hexCenter = this.hexGrid.axialToCartesian(hexCoord);

      // Check if we moved to a different hex
      const isNewHex =
        !this.lastHoveredHex ||
        this.lastHoveredHex.q !== hexCoord.q ||
        this.lastHoveredHex.r !== hexCoord.r;

      if (isNewHex) {
        this.lastHoveredHex = { q: hexCoord.q, r: hexCoord.r };

        if (this.HOVER_SOUND_ENABLED) {
          // Calculate hex distance from center (0,0)
          // Formula for axial coordinates: (|q| + |q+r| + |r|) / 2
          const { q, r } = hexCoord;
          const hexDistance = (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;

          // Normalize to 0-1 range based on expected grid radius
          const normalizedDistance = hexDistance / this.HOVER_SOUND_MAX_RADIUS;

          soundManager.playHover(normalizedDistance);
        }
      }

      this.hoverHighlight.position.set(hexCenter.x, 0, hexCenter.z);
      this.hoverHighlight.visible = true;
    } else {
      this.hoverHighlight.visible = false;
      this.lastHoveredHex = null;
    }
  };

  private handleHoverLeave = (): void => {
    if (this.hoverHighlight) {
      this.hoverHighlight.visible = false;
    }
    this.lastHoveredHex = null;
  };

  /**
   * Create a pending zone with loading animation
   * Shows while waiting for the real zone to be created
   */
  createPendingZone(id: string, hintPosition?: { x: number; z: number }): void {
    if (this.pendingZones.has(id)) return;

    const P = WorkshopScene.PENDING;

    // Find position - use hint or next spiral position (peek without occupying)
    const hexCoord = hintPosition
      ? this.hexGrid.findNearestFreeFromCartesian(
          hintPosition.x,
          hintPosition.z,
        )
      : this.hexGrid.peekNextInSpiral();

    const { x, z } = this.hexGrid.axialToCartesian(hexCoord);
    const position = new THREE.Vector3(x, 0, z);

    const group = new THREE.Group();
    group.position.copy(position);

    // Translucent hexagon outline (reuse hex shape helper)
    const ring = this.createHexOutline(10, 0x4ac8e8, 0.5);
    group.add(ring);

    // Spinning loader - dots arranged in a circle
    const spinner = new THREE.Group();
    const dotGeom = new THREE.SphereGeometry(
      P.DOT_RADIUS,
      P.DOT_SEGMENTS,
      P.DOT_SEGMENTS,
    );
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0x4ac8e8,
      opacity: 0.8,
      transparent: true,
    });

    for (let i = 0; i < P.DOT_COUNT; i++) {
      const dot = new THREE.Mesh(dotGeom, dotMat.clone());
      const angle = ((Math.PI * 2) / P.DOT_COUNT) * i;
      dot.position.set(
        Math.cos(angle) * P.SPINNER_RADIUS,
        P.SPINNER_HEIGHT,
        Math.sin(angle) * P.SPINNER_RADIUS,
      );
      spinner.add(dot);
    }
    group.add(spinner);

    this.scene.add(group);
    this.pendingZones.set(id, { group, spinner, ring, position, age: 0 });
  }

  /**
   * Create a hexagon outline (reusable helper)
   */
  private createHexOutline(
    radius: number,
    color: number,
    opacity: number,
  ): THREE.Line {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6; // Pointy-top
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * radius,
          0.1,
          Math.sin(angle) * radius,
        ),
      );
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, opacity, transparent: true }),
    );
  }

  /**
   * Remove a pending zone (called when real zone is created or on failure)
   * @param id - Identifier of the pending zone
   */
  removePendingZone(id: string): void {
    const pending = this.pendingZones.get(id);
    if (!pending) return;

    this.scene.remove(pending.group);
    pending.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
      if (obj instanceof THREE.Line) {
        obj.geometry?.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
    });
    this.pendingZones.delete(id);
  }

  /**
   * Update pending zone animations (called from render loop)
   */
  private updatePendingZones(delta: number): void {
    const P = WorkshopScene.PENDING;

    for (const pending of this.pendingZones.values()) {
      pending.age += delta;

      // Rotate spinner group
      pending.spinner.rotation.y += delta * P.ROTATION_SPEED;

      // Pulse each dot (scale + vertical bob, phase-offset)
      pending.spinner.children.forEach((dot, i) => {
        const phase =
          pending.age * P.PULSE_SPEED + i * ((Math.PI * 2) / P.DOT_COUNT);
        dot.scale.setScalar(P.SCALE_BASE + Math.sin(phase) * P.SCALE_RANGE);
        dot.position.y = P.SPINNER_HEIGHT + Math.sin(phase) * P.BOB_RANGE;
      });

      // Pulse ring opacity
      const ringMat = pending.ring.material as THREE.LineBasicMaterial;
      ringMat.opacity =
        P.RING_OPACITY_BASE +
        Math.sin(pending.age * P.RING_PULSE_SPEED) * P.RING_OPACITY_RANGE;
    }
  }

  /**
   * Create a new zone for a session
   * @param sessionId - Unique session identifier
   * @param options - Optional color and hint position for direction-aware placement
   */
  createZone(
    sessionId: string,
    options?: { color?: number; hintPosition?: { x: number; z: number } },
  ): Zone {
    // Check if zone already exists
    const existing = this.zones.get(sessionId);
    if (existing) return existing;

    // Remove any pending zone with matching position
    // We check all pending zones and remove ones near this zone's target position
    for (const [pendingId, pending] of this.pendingZones) {
      if (options?.hintPosition) {
        const dist = Math.hypot(
          pending.position.x - options.hintPosition.x,
          pending.position.z - options.hintPosition.z,
        );
        if (dist < 25) {
          // Within roughly one hex diameter
          this.removePendingZone(pendingId);
          break;
        }
      }
    }

    // Determine hex position using direction-aware placement or spiral fallback
    const hexCoord = options?.hintPosition
      ? this.hexGrid.findNearestFreeFromCartesian(
          options.hintPosition.x,
          options.hintPosition.z,
        )
      : this.hexGrid.getNextInSpiral();

    // Mark hex as occupied
    this.hexGrid.occupy(hexCoord, sessionId);

    // Clear any painted hex at this position (zones take precedence)
    this.clearPaintedHex(hexCoord);

    // Assign color and convert hex to world position
    const zoneColor =
      options?.color ?? ZONE_COLORS[this.zoneColorIndex++ % ZONE_COLORS.length];
    const { x, z } = this.hexGrid.axialToCartesian(hexCoord);
    const position = new THREE.Vector3(x, 0, z);

    // Create zone group
    const group = new THREE.Group();
    group.position.copy(position);
    this.scene.add(group);

    // IMPORTANT: Update world matrix before creating stations
    // so localToWorld() returns correct world positions
    group.updateMatrixWorld(true);

    // Create zone platform/floor
    const { platform, ring, floor } = this.createZonePlatform(group, zoneColor);

    // Create stations in this zone
    const stations = this.createZoneStations(group, zoneColor);

    // Create floating session label
    const label = this.createZoneLabel(sessionId, zoneColor);
    label.position.set(0, 4, 0);
    group.add(label);

    // Create git status label on floor
    const gitLabel = this.createGitLabel();
    gitLabel.position.set(0, 0.15, 2.5); // Near front edge of hex
    gitLabel.visible = false; // Hidden until we have git data
    group.add(gitLabel);

    // Create particle system for activity effects
    const { particles, velocities } = this.createParticleSystem(zoneColor);
    group.add(particles);

    // Create vertical edge lines (hidden until zone is elevated)
    const edgeLines = this.createZoneEdgeLines(zoneColor);
    edgeLines.visible = false;
    this.scene.add(edgeLines); // Add to scene (not group) so they stay at world origin
    edgeLines.position.copy(position); // Position at zone's world location

    // Create solid side faces (hidden until zone is elevated)
    const sideMesh = this.createZoneSideMesh(zoneColor);
    sideMesh.visible = false;
    this.scene.add(sideMesh);
    sideMesh.position.copy(position);

    const zone: Zone = {
      id: sessionId,
      group,
      stations,
      platform,
      ring,
      floor,
      color: zoneColor,
      position,
      label,
      gitLabel,
      pulseIntensity: 0,
      attentionReason: null,
      attentionTime: 0,
      particles,
      particleVelocities: velocities,
      status: "idle",
      // Start animation
      animationState: "entering",
      animationProgress: 0,
      // Elevation from painting
      elevation: 0,
      edgeLines,
      sideMesh,
    };

    // Start with scale 0 for enter animation
    group.scale.setScalar(0.01);

    // Hide elements initially (they'll fade in)
    for (const station of stations.values()) {
      station.mesh.visible = false;
    }
    if (label) label.visible = false;
    particles.visible = false;

    this.zones.set(sessionId, zone);

    // Register zone with notification system
    this.zoneNotifications.registerZone(sessionId, position);

    // Create station panels for this zone
    this.stationPanels.createPanelsForZone(sessionId, position, zoneColor);

    // Legacy compat: first zone's stations become default
    if (this.zones.size === 1) {
      this.stations = stations;
    }

    // Focus camera on first zone
    if (this.zones.size === 1) {
      this.focusZone(sessionId);
    }

    // Apply pending elevation if one was loaded from localStorage
    const pendingElevation = this.pendingZoneElevations.get(sessionId);
    if (pendingElevation !== undefined) {
      this.setZoneElevation(sessionId, pendingElevation);
      this.pendingZoneElevations.delete(sessionId);
    }

    console.log(
      `Created zone for session ${sessionId.slice(0, 8)} at position`,
      position,
    );
    return zone;
  }

  /**
   * Get a zone by session ID
   */
  getZone(sessionId: string): Zone | undefined {
    return this.zones.get(sessionId);
  }

  /**
   * Get a zone's world position for spatial audio
   * Returns {x, z} coordinates or null if zone doesn't exist
   */
  getZoneWorldPosition(sessionId: string): { x: number; z: number } | null {
    const zone = this.zones.get(sessionId);
    if (!zone) return null;
    return { x: zone.position.x, z: zone.position.z };
  }

  /**
   * Get the hex grid position for a zone
   */
  getZoneHexPosition(sessionId: string): { q: number; r: number } | null {
    const zone = this.zones.get(sessionId);
    if (!zone) return null;
    return this.hexGrid.cartesianToHex(zone.position.x, zone.position.z);
  }

  /**
   * Delete a zone with exit animation
   */
  deleteZone(sessionId: string): boolean {
    const zone = this.zones.get(sessionId);
    if (!zone) return false;

    // If already exiting, don't restart
    if (zone.animationState === "exiting") return true;

    // Start exit animation
    zone.animationState = "exiting";
    zone.animationProgress = 0;

    // Release hex position for reuse immediately (so new zones can use it)
    this.hexGrid.release(sessionId);

    console.log(`Starting exit animation for zone ${sessionId.slice(0, 8)}`);
    return true;
  }

  /**
   * Actually remove a zone after animation completes
   */
  private finalizeZoneDelete(sessionId: string): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    // Unregister from notification system
    this.zoneNotifications.unregisterZone(sessionId);

    // Remove station panels
    this.stationPanels.removePanelsForZone(sessionId);

    // Remove from scene
    this.scene.remove(zone.group);

    // Dispose of geometries and materials
    zone.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      } else if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      } else if (obj instanceof THREE.Points) {
        obj.geometry?.dispose();
        (obj.material as THREE.PointsMaterial)?.dispose();
      }
    });

    // Clean up label
    if (zone.label) {
      const material = zone.label.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }

    // Clean up context sprites from stations
    for (const station of zone.stations.values()) {
      if (station.contextSprite) {
        station.contextSprite.material.map?.dispose();
        station.contextSprite.material.dispose();
      }
    }

    // Clean up edge lines
    if (zone.edgeLines) {
      this.scene.remove(zone.edgeLines);
      zone.edgeLines.geometry.dispose();
      (zone.edgeLines.material as THREE.LineBasicMaterial).dispose();
    }

    // Clean up side mesh
    if (zone.sideMesh) {
      this.scene.remove(zone.sideMesh);
      zone.sideMesh.geometry.dispose();
      (zone.sideMesh.material as THREE.MeshStandardMaterial).dispose();
    }

    this.zones.delete(sessionId);
    console.log(`Deleted zone for session ${sessionId.slice(0, 8)}`);

    // If we deleted the focused zone, unfocus
    if (this.focusedZoneId === sessionId) {
      this.focusedZoneId = null;
    }
  }

  /**
   * Focus camera on a specific zone
   */
  focusZone(sessionId: string, animate = true): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    this.focusedZoneId = sessionId;
    this.cameraMode = "focused";

    // Account for zone elevation (raised zones from hex painting underneath)
    const target = zone.position.clone();
    target.y += zone.elevation;
    const cameraPos = target.clone().add(new THREE.Vector3(8, 6, 8));

    if (animate) {
      this.animateCameraTo(cameraPos, target);
    } else {
      this.controls.target.copy(target);
      this.camera.position.copy(cameraPos);
    }

    this.notifyCameraModeChange();
  }

  /**
   * Raise a zone's elevation (used when painting under zones)
   * @param sessionId - The zone to raise
   * @param amount - Amount to raise (default 0.5)
   * @returns true if zone was raised
   */
  raiseZone(sessionId: string, amount = 0.5): boolean {
    const zone = this.zones.get(sessionId);
    if (!zone) return false;

    const maxElevation = 100; // Same as painted hex limit
    if (zone.elevation >= maxElevation) return false;

    const newElevation = Math.min(zone.elevation + amount, maxElevation);
    const targetY = newElevation;

    // Animate the zone rising
    const startY = zone.group.position.y;
    const startTime = performance.now();
    const duration = 150; // Quick rise animation

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease out
      const eased = 1 - Math.pow(1 - progress, 3);

      zone.group.position.y = startY + (targetY - startY) * eased;

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        zone.elevation = newElevation;
        // Update edge lines and side mesh to final position
        this.updateZoneEdgeLines(zone);
        this.updateZoneSideMesh(zone);
        // Play a subtle sound
        soundManager.play("click");
        // Notify listeners (for Claude position updates)
        this.notifyZoneElevationChange(sessionId, newElevation);
      }
    };
    requestAnimationFrame(animate);

    // Update edge lines and side mesh during animation start
    zone.elevation = newElevation; // Set temporarily for edge/side update
    this.updateZoneEdgeLines(zone);
    this.updateZoneSideMesh(zone);

    // Spawn a visual effect at top of zone
    const worldPos = zone.position.clone();
    this.spawnStackEffect(worldPos.x, worldPos.z, newElevation, zone.color);

    return true;
  }

  /**
   * Lower a zone's elevation (used when erasing on zones)
   * @param sessionId - The zone to lower
   * @param amount - Amount to lower (default 0.5)
   * @returns true if zone was lowered
   */
  lowerZone(sessionId: string, amount = 0.5): boolean {
    const zone = this.zones.get(sessionId);
    if (!zone) return false;

    // Can't go below 0
    if (zone.elevation <= 0) return false;

    const newElevation = Math.max(zone.elevation - amount, 0);
    const targetY = newElevation;

    // Animate the zone lowering
    const startY = zone.group.position.y;
    const startTime = performance.now();
    const duration = 150; // Quick animation

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease out
      const eased = 1 - Math.pow(1 - progress, 3);

      zone.group.position.y = startY + (targetY - startY) * eased;

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        zone.elevation = newElevation;
        // Update edge lines and side mesh to final position
        this.updateZoneEdgeLines(zone);
        this.updateZoneSideMesh(zone);
        // Play a subtle sound
        soundManager.play("click");
        // Notify listeners (for Claude position updates)
        this.notifyZoneElevationChange(sessionId, newElevation);
      }
    };
    requestAnimationFrame(animate);

    // Update edge lines and side mesh during animation start
    zone.elevation = newElevation; // Set temporarily for edge/side update
    this.updateZoneEdgeLines(zone);
    this.updateZoneSideMesh(zone);

    return true;
  }

  /**
   * Get the zone occupying a hex position (if any)
   */
  getZoneAtHex(hex: { q: number; r: number }): Zone | null {
    const sessionId = this.hexGrid.getOccupant(hex);
    if (!sessionId) return null;
    return this.zones.get(sessionId) ?? null;
  }

  /**
   * Switch to bird's eye overview showing all zones
   */
  setOverviewMode(): void {
    this.cameraMode = "overview";
    this.focusedZoneId = null;

    // Calculate center and extent of all zones
    if (this.zones.size === 0) return;

    let minX = Infinity,
      maxX = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;

    for (const zone of this.zones.values()) {
      minX = Math.min(minX, zone.position.x - 10);
      maxX = Math.max(maxX, zone.position.x + 10);
      minZ = Math.min(minZ, zone.position.z - 10);
      maxZ = Math.max(maxZ, zone.position.z + 10);
    }

    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const extentX = maxX - minX;
    const extentZ = maxZ - minZ;
    const extent = Math.max(extentX, extentZ, 30);

    // Position camera high above looking down
    const height = extent * 0.8;
    const targetLookAt = new THREE.Vector3(centerX, 0, centerZ);
    const targetPos = new THREE.Vector3(
      centerX,
      height,
      centerZ + extent * 0.3,
    );

    this.animateCameraTo(targetPos, targetLookAt);
    this.notifyCameraModeChange();
  }

  /**
   * Animate camera to a new position and look-at target
   */
  private animateCameraTo(
    position: THREE.Vector3,
    lookAt: THREE.Vector3,
  ): void {
    this.cameraTargetPos.copy(position);
    this.cameraTargetLookAt.copy(lookAt);
    this.cameraAnimating = true;
  }

  /**
   * Enable follow-active mode (camera follows activity)
   */
  setFollowActiveMode(): void {
    this.cameraMode = "follow-active";
    this.notifyCameraModeChange();
  }

  /**
   * Get zone by index (for keyboard shortcuts)
   */
  getZoneByIndex(index: number): Zone | undefined {
    const zones = Array.from(this.zones.values());
    return zones[index];
  }

  /**
   * Register callback for camera mode changes
   */
  onCameraMode(callback: (mode: CameraMode) => void): void {
    this.onCameraModeChange = callback;
  }

  private notifyCameraModeChange(): void {
    if (this.onCameraModeChange) {
      this.onCameraModeChange(this.cameraMode);
    }
  }

  /**
   * Register callback for zone elevation changes (for updating Claude positions)
   */
  onZoneElevation(
    callback: (sessionId: string, elevation: number) => void,
  ): void {
    this.onZoneElevationChange = callback;
  }

  private notifyZoneElevationChange(
    sessionId: string,
    elevation: number,
  ): void {
    // Update station world positions to account for new elevation
    this.updateStationPositions(sessionId);
    // Update zone notifications to use new elevation
    this.zoneNotifications.updateZoneElevation(sessionId, elevation);
    // Notify external listeners (for Claude position updates)
    if (this.onZoneElevationChange) {
      this.onZoneElevationChange(sessionId, elevation);
    }
  }

  /**
   * Update all station world positions for a zone (called when elevation changes)
   */
  private updateStationPositions(sessionId: string): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    // Save original scale (may be 0.01 during enter animation)
    const originalScale = zone.group.scale.clone();

    // Temporarily set scale to 1 for correct world position calculation
    // (localToWorld uses scale, but we want positions independent of animation state)
    zone.group.scale.setScalar(1);

    // Force update world matrix with scale=1
    zone.group.updateMatrixWorld(true);

    for (const station of zone.stations.values()) {
      // Recalculate world position from local position
      const worldPos = station.localPosition.clone();
      zone.group.localToWorld(worldPos);
      station.position.copy(worldPos);
    }

    // Restore original scale for animation
    zone.group.scale.copy(originalScale);
    zone.group.updateMatrixWorld(true);
  }

  /**
   * Create vertical edge lines for a zone (shown when elevated)
   * Creates 6 vertical lines at hex corners + 6 horizontal lines at top
   */
  private createZoneEdgeLines(color: number): THREE.LineSegments {
    const hexRadius = 10;
    const positions: number[] = [];

    // Create vertical lines at each hex corner
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = hexRadius * Math.cos(angle);
      const z = hexRadius * Math.sin(angle);

      // Vertical line from y=0 to y=1 (will be scaled by elevation)
      positions.push(x, 0, z); // Bottom
      positions.push(x, 1, z); // Top
    }

    // Create horizontal lines connecting corners at top (y=1)
    for (let i = 0; i < 6; i++) {
      const angle1 = (Math.PI / 3) * i - Math.PI / 2;
      const angle2 = (Math.PI / 3) * ((i + 1) % 6) - Math.PI / 2;
      const x1 = hexRadius * Math.cos(angle1);
      const z1 = hexRadius * Math.sin(angle1);
      const x2 = hexRadius * Math.cos(angle2);
      const z2 = hexRadius * Math.sin(angle2);

      positions.push(x1, 1, z1);
      positions.push(x2, 1, z2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );

    const material = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      linewidth: 2,
    });

    return new THREE.LineSegments(geometry, material);
  }

  /**
   * Create solid side faces for an elevated zone
   */
  private createZoneSideMesh(color: number): THREE.Mesh {
    const hexRadius = 10;
    // 6 sides, each side is a quad (2 triangles = 6 vertices)
    const vertexCount = 6 * 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);

    let idx = 0;
    for (let i = 0; i < 6; i++) {
      const angle1 = (Math.PI / 3) * i - Math.PI / 2;
      const angle2 = (Math.PI / 3) * ((i + 1) % 6) - Math.PI / 2;
      const x1 = hexRadius * Math.cos(angle1);
      const z1 = hexRadius * Math.sin(angle1);
      const x2 = hexRadius * Math.cos(angle2);
      const z2 = hexRadius * Math.sin(angle2);

      // Calculate outward normal for this face
      const midAngle = (angle1 + angle2) / 2;
      const nx = Math.cos(midAngle);
      const nz = Math.sin(midAngle);

      // Triangle 1: bottom-left, bottom-right, top-right
      positions[idx * 3] = x1;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z1;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;
      positions[idx * 3] = x2;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z2;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;
      positions[idx * 3] = x2;
      positions[idx * 3 + 1] = 1;
      positions[idx * 3 + 2] = z2;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;

      // Triangle 2: bottom-left, top-right, top-left
      positions[idx * 3] = x1;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z1;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;
      positions[idx * 3] = x2;
      positions[idx * 3 + 1] = 1;
      positions[idx * 3 + 2] = z2;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;
      positions[idx * 3] = x1;
      positions[idx * 3 + 1] = 1;
      positions[idx * 3 + 2] = z1;
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = 0;
      normals[idx * 3 + 2] = nz;
      idx++;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

    const material = new THREE.MeshStandardMaterial({
      color: color,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    });

    return new THREE.Mesh(geometry, material);
  }

  /**
   * Update zone side mesh to match elevation
   */
  updateZoneSideMesh(zone: Zone): void {
    if (!zone.sideMesh) return;

    const elevation = zone.elevation;
    if (elevation <= 0) {
      zone.sideMesh.visible = false;
      return;
    }

    zone.sideMesh.visible = true;

    const positions = zone.sideMesh.geometry.attributes
      .position as THREE.BufferAttribute;
    const hexRadius = 10;

    let idx = 0;
    for (let i = 0; i < 6; i++) {
      const angle1 = (Math.PI / 3) * i - Math.PI / 2;
      const angle2 = (Math.PI / 3) * ((i + 1) % 6) - Math.PI / 2;
      const x1 = hexRadius * Math.cos(angle1);
      const z1 = hexRadius * Math.sin(angle1);
      const x2 = hexRadius * Math.cos(angle2);
      const z2 = hexRadius * Math.sin(angle2);

      // Triangle 1: bottom-left, bottom-right, top-right
      positions.setXYZ(idx++, x1, 0, z1);
      positions.setXYZ(idx++, x2, 0, z2);
      positions.setXYZ(idx++, x2, elevation, z2);

      // Triangle 2: bottom-left, top-right, top-left
      positions.setXYZ(idx++, x1, 0, z1);
      positions.setXYZ(idx++, x2, elevation, z2);
      positions.setXYZ(idx++, x1, elevation, z1);
    }

    positions.needsUpdate = true;
  }

  /**
   * Update zone edge lines to match elevation
   */
  updateZoneEdgeLines(zone: Zone): void {
    if (!zone.edgeLines) return;

    const elevation = zone.elevation;
    if (elevation <= 0) {
      zone.edgeLines.visible = false;
      return;
    }

    zone.edgeLines.visible = true;

    // Update vertex positions to reflect current elevation
    const positions = zone.edgeLines.geometry.attributes
      .position as THREE.BufferAttribute;
    const hexRadius = 10;

    let idx = 0;
    // Update vertical lines (6 lines, 2 points each)
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = hexRadius * Math.cos(angle);
      const z = hexRadius * Math.sin(angle);

      // Bottom point (y=0)
      positions.setXYZ(idx++, x, 0, z);
      // Top point (y=elevation)
      positions.setXYZ(idx++, x, elevation, z);
    }

    // Update horizontal lines at top (6 lines, 2 points each)
    for (let i = 0; i < 6; i++) {
      const angle1 = (Math.PI / 3) * i - Math.PI / 2;
      const angle2 = (Math.PI / 3) * ((i + 1) % 6) - Math.PI / 2;
      const x1 = hexRadius * Math.cos(angle1);
      const z1 = hexRadius * Math.sin(angle1);
      const x2 = hexRadius * Math.cos(angle2);
      const z2 = hexRadius * Math.sin(angle2);

      positions.setXYZ(idx++, x1, elevation, z1);
      positions.setXYZ(idx++, x2, elevation, z2);
    }

    positions.needsUpdate = true;
  }

  /**
   * Create a pointy-top hexagon shape
   */
  private createHexagonShape(radius: number): THREE.Shape {
    const shape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      // Pointy-top: start at 90 degrees (top point)
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);
      if (i === 0) {
        shape.moveTo(x, y);
      } else {
        shape.lineTo(x, y);
      }
    }
    shape.closePath();
    return shape;
  }

  private createZonePlatform(
    group: THREE.Group,
    color: number,
  ): { platform: THREE.Mesh; ring: THREE.Mesh; floor: THREE.Mesh } {
    const hexRadius = 10;

    // Zone floor hexagon - slightly brighter/more active than world
    const floorShape = this.createHexagonShape(hexRadius);
    const floorGeometry = new THREE.ShapeGeometry(floorShape);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a2535, // Slightly brighter blue - more "active"
      roughness: 0.7,
      metalness: 0.15,
      emissive: color,
      emissiveIntensity: 0.02, // Subtle glow from zone color
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    // Colored hex ring around zone (will pulse with activity)
    const outerShape = this.createHexagonShape(hexRadius);
    const innerShape = this.createHexagonShape(hexRadius - 0.5);
    outerShape.holes.push(innerShape as unknown as THREE.Path);
    const ringGeometry = new THREE.ShapeGeometry(outerShape);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);

    // Center platform (keep as cylinder - looks like a pedestal)
    const platformGeometry = new THREE.CylinderGeometry(1, 1.2, 0.2, 6); // 6 sides for hex
    const platformMaterial = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.5,
      metalness: 0.3,
      emissive: color,
      emissiveIntensity: 0.1,
    });
    const platform = new THREE.Mesh(platformGeometry, platformMaterial);
    platform.position.y = 0.1;
    platform.rotation.y = Math.PI / 6; // Align with hex
    platform.receiveShadow = true;
    platform.castShadow = true;
    group.add(platform);

    // No internal hex grid lines - zone floor is clean
    // World hex grid shows through conceptually

    return { platform, ring, floor };
  }

  /**
   * Add subtle hex grid lines inside the zone
   */
  private addHexGridLines(group: THREE.Group, radius: number): void {
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x3090b0, // Cyan/teal
      transparent: true,
      opacity: 0.25,
    });

    // Draw lines from center to each vertex
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = radius * 0.9 * Math.cos(angle);
      const z = radius * 0.9 * Math.sin(angle);

      const points = [
        new THREE.Vector3(0, 0.01, 0),
        new THREE.Vector3(x, 0.01, z),
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, lineMaterial);
      group.add(line);
    }

    // Draw concentric hex rings
    for (const r of [3, 6]) {
      const ringPoints: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        ringPoints.push(
          new THREE.Vector3(r * Math.cos(angle), 0.01, r * Math.sin(angle)),
        );
      }
      const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPoints);
      const ringLine = new THREE.Line(ringGeo, lineMaterial);
      group.add(ringLine);
    }
  }

  /**
   * Create floating label for a zone
   */
  private createZoneLabel(sessionId: string, color: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    // Higher resolution for crisp text
    canvas.width = 512;
    canvas.height = 96;

    this.drawLabelShape(
      ctx,
      canvas.width,
      canvas.height,
      color,
      sessionId.slice(0, 8),
    );

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(5, 1.2, 1);

    return sprite;
  }

  /**
   * Draw glowing text label - no box, just text with glow effect
   */
  private drawLabelShape(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    color: number,
    text: string,
    keybind?: string,
  ): void {
    const colorHex = `#${color.toString(16).padStart(6, "0")}`;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Setup text style
    ctx.font = "600 36px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Truncate if needed
    let displayText = text;
    const maxWidth = width - 80;
    let textWidth = ctx.measureText(displayText).width;
    if (textWidth > maxWidth) {
      while (textWidth > maxWidth && displayText.length > 3) {
        displayText = displayText.slice(0, -1);
        textWidth = ctx.measureText(displayText + "…").width;
      }
      displayText += "…";
    }

    // Build full label with keybind
    const fullText = keybind ? `${keybind}  ${displayText}` : displayText;
    const centerX = width / 2;
    const centerY = height / 2;

    // Dark backdrop for readability (soft shadow, not a box)
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillText(fullText, centerX, centerY);
    ctx.fillText(fullText, centerX, centerY); // Double for stronger shadow
    ctx.restore();

    // Colored glow - outer (big bloom)
    ctx.save();
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 30;
    ctx.fillStyle = colorHex;
    ctx.globalAlpha = 0.3;
    ctx.fillText(fullText, centerX, centerY);
    ctx.fillText(fullText, centerX, centerY);
    ctx.restore();

    // Colored glow - middle
    ctx.save();
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 12;
    ctx.fillStyle = colorHex;
    ctx.globalAlpha = 0.5;
    ctx.fillText(fullText, centerX, centerY);
    ctx.restore();

    // Colored glow - inner (tight)
    ctx.save();
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 4;
    ctx.fillStyle = colorHex;
    ctx.globalAlpha = 0.8;
    ctx.fillText(fullText, centerX, centerY);
    ctx.restore();

    // Main text - crisp white
    ctx.fillStyle = "#ffffff";
    ctx.fillText(fullText, centerX, centerY);
  }

  /**
   * Update the floating label for a zone
   * @param keybind - Optional keybind string (1-6, Q-Y, A-H, Z-N) to show as badge
   */
  updateZoneLabel(sessionId: string, newLabel: string, keybind?: string): void {
    const zone = this.zones.get(sessionId);
    if (!zone || !zone.label) return;

    // Redraw the label with new text using shared drawing function
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = 512;
    canvas.height = 96;

    this.drawLabelShape(
      ctx,
      canvas.width,
      canvas.height,
      zone.color,
      newLabel,
      keybind,
    );

    // Update texture
    const material = zone.label.material as THREE.SpriteMaterial;
    if (material.map) {
      material.map.dispose();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    material.map = texture;
    material.needsUpdate = true;
  }

  // ============================================================================
  // Text Tiles (Grid Labels)
  // ============================================================================

  /**
   * Set all text tiles (called when receiving tiles from server)
   */
  setTextTiles(tiles: TextTile[]): void {
    // Remove tiles that no longer exist
    const newIds = new Set(tiles.map((t) => t.id));
    for (const [id] of this.textTileSprites) {
      if (!newIds.has(id)) {
        this.removeTextTile(id);
      }
    }

    // Add or update tiles
    for (const tile of tiles) {
      if (this.textTileSprites.has(tile.id)) {
        this.updateTextTile(tile);
      } else {
        this.addTextTile(tile);
      }
    }
  }

  /**
   * Add a text tile to the scene
   */
  addTextTile(tile: TextTile): void {
    const sprite = this.createTextTileSprite(tile.text, tile.color);

    // Position at hex center, accounting for painted hex height
    const { x, z } = this.hexGrid.axialToCartesian(tile.position);
    const hexHeight = this.getPaintedHexHeight(tile.position);
    sprite.position.set(x, 0.5 + hexHeight, z);

    this.scene.add(sprite);
    this.textTileSprites.set(tile.id, { sprite, tile });
  }

  /**
   * Get the height of a painted hex at a position (0 if not painted)
   */
  getPaintedHexHeight(hex: { q: number; r: number }): number {
    const key = `${hex.q},${hex.r}`;
    const data = this.paintedHexes.get(key);
    return data?.height ?? 0;
  }

  /**
   * Update an existing text tile
   */
  updateTextTile(tile: TextTile): void {
    const entry = this.textTileSprites.get(tile.id);
    if (!entry) return;

    // Update position if changed (including height for painted hexes)
    const { x, z } = this.hexGrid.axialToCartesian(tile.position);
    const hexHeight = this.getPaintedHexHeight(tile.position);
    entry.sprite.position.set(x, 0.5 + hexHeight, z);

    // Update text/color if changed
    if (entry.tile.text !== tile.text || entry.tile.color !== tile.color) {
      const material = entry.sprite.material as THREE.SpriteMaterial;
      if (material.map) {
        material.map.dispose();
      }
      const { texture, lineCount } = this.createTextTileTexture(
        tile.text,
        tile.color,
      );
      material.map = texture;
      material.needsUpdate = true;

      // Update scale - maintain 2:1 aspect ratio to avoid distortion
      const baseWidth = 16;
      const baseHeight = 8;
      const scale = 1 + (lineCount - 1) * 0.3;
      entry.sprite.scale.set(baseWidth * scale, baseHeight * scale, 1);
    }

    entry.tile = tile;
  }

  /**
   * Remove a text tile from the scene
   */
  removeTextTile(tileId: string): void {
    const entry = this.textTileSprites.get(tileId);
    if (!entry) return;

    this.scene.remove(entry.sprite);
    const material = entry.sprite.material as THREE.SpriteMaterial;
    if (material.map) {
      material.map.dispose();
    }
    material.dispose();
    this.textTileSprites.delete(tileId);
  }

  /**
   * Get text tile at a hex position (for click detection)
   */
  getTextTileAtHex(hex: { q: number; r: number }): TextTile | null {
    for (const [, entry] of this.textTileSprites) {
      if (entry.tile.position.q === hex.q && entry.tile.position.r === hex.r) {
        return entry.tile;
      }
    }
    return null;
  }

  /**
   * Get all text tiles
   */
  getTextTiles(): TextTile[] {
    return Array.from(this.textTileSprites.values()).map((e) => e.tile);
  }

  /**
   * Create a text tile sprite
   */
  private createTextTileSprite(text: string, color?: string): THREE.Sprite {
    const { texture, lineCount } = this.createTextTileTexture(text, color);

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);

    // Must maintain canvas aspect ratio (2:1) to avoid text distortion
    // Scale uniformly based on line count
    const baseWidth = 16;
    const baseHeight = 8; // 2:1 ratio matches canvas 1024x512
    const scale = 1 + (lineCount - 1) * 0.3; // Grow 30% per extra line
    sprite.scale.set(baseWidth * scale, baseHeight * scale, 1);

    return sprite;
  }

  /**
   * Create texture for text tile with multi-line support
   */
  private createTextTileTexture(
    text: string,
    color?: string,
  ): {
    texture: THREE.CanvasTexture;
    lineCount: number;
  } {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    // Larger canvas for more text
    canvas.width = 1024;
    canvas.height = 512;

    const tileColor = color || "#4ac8e8"; // Default to cyan theme
    const fontSize = 36;
    const lineHeight = fontSize * 1.4;
    const padding = 32;
    const maxWidth = canvas.width - padding * 2;
    const minContentWidth = 200; // Minimum panel width for short text

    // Setup font for measurements
    ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;

    // Word wrap text
    const lines = this.wrapText(ctx, text, maxWidth);

    // Calculate actual content bounds with minimum width
    const textHeight = lines.length * lineHeight;
    const maxLineWidth = Math.max(
      ...lines.map((line) => ctx.measureText(line).width),
    );
    const contentWidth = Math.max(
      Math.min(maxLineWidth + padding * 2, canvas.width),
      minContentWidth,
    );
    const contentHeight = textHeight + padding * 2;

    // Calculate panel dimensions (centered in canvas)
    const panelX = (canvas.width - contentWidth) / 2;
    const panelY = (canvas.height - contentHeight) / 2;
    const bevel = Math.min(contentHeight * 0.25, 60); // Hex-style beveled corners, capped to avoid cutting text

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw hexagonal panel background (flat-top hex style with beveled left/right edges)
    ctx.save();
    ctx.fillStyle = "rgba(10, 12, 18, 0.92)";
    ctx.beginPath();
    ctx.moveTo(panelX + bevel, panelY); // Top-left after bevel
    ctx.lineTo(panelX + contentWidth - bevel, panelY); // Top-right before bevel
    ctx.lineTo(panelX + contentWidth, panelY + bevel); // Right top corner
    ctx.lineTo(panelX + contentWidth, panelY + contentHeight - bevel); // Right bottom before bevel
    ctx.lineTo(panelX + contentWidth - bevel, panelY + contentHeight); // Bottom-right
    ctx.lineTo(panelX + bevel, panelY + contentHeight); // Bottom-left
    ctx.lineTo(panelX, panelY + contentHeight - bevel); // Left bottom corner
    ctx.lineTo(panelX, panelY + bevel); // Left top before bevel
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Draw text with subtle glow
    ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const textStartY = panelY + padding + 4; // Below accent line
    const centerX = canvas.width / 2;

    // Subtle glow layer
    ctx.save();
    ctx.shadowColor = tileColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = tileColor;
    ctx.globalAlpha = 0.3;
    lines.forEach((line, i) => {
      ctx.fillText(line, centerX, textStartY + i * lineHeight);
    });
    ctx.restore();

    // Main text
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    lines.forEach((line, i) => {
      ctx.fillText(line, centerX, textStartY + i * lineHeight);
    });
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    return {
      texture,
      lineCount: lines.length,
    };
  }

  /**
   * Word wrap text to fit within maxWidth
   */
  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
  ): string[] {
    const lines: string[] = [];

    // First split by explicit line breaks
    const paragraphs = text.split("\n");

    for (const paragraph of paragraphs) {
      if (paragraph.trim() === "") {
        lines.push("");
        continue;
      }

      const words = paragraph.split(" ");
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine) {
        lines.push(currentLine);
      }
    }

    return lines.length > 0 ? lines : [""];
  }

  /**
   * Create git status label sprite (initially blank)
   */
  private createGitLabel(): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 48;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      opacity: 0.9,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(3, 0.6, 1);

    return sprite;
  }

  /**
   * Update git status display for a zone
   */
  updateZoneGitStatus(
    sessionId: string,
    gitStatus: {
      branch: string;
      linesAdded: number;
      linesRemoved: number;
      totalFiles: number;
      isRepo: boolean;
    } | null,
  ): void {
    const zone = this.zones.get(sessionId);
    if (!zone || !zone.gitLabel) return;

    // Hide if no git data or not a repo
    if (!gitStatus || !gitStatus.isRepo) {
      zone.gitLabel.visible = false;
      return;
    }

    // Format: "main +142/-37" or "main • clean" if no changes
    const hasChanges =
      gitStatus.linesAdded > 0 ||
      gitStatus.linesRemoved > 0 ||
      gitStatus.totalFiles > 0;
    let text: string;
    let color: string;

    if (hasChanges) {
      text = `${gitStatus.branch} +${gitStatus.linesAdded}/-${gitStatus.linesRemoved}`;
      // Color based on amount of changes
      const changeScore = gitStatus.linesAdded + gitStatus.linesRemoved;
      if (changeScore > 500) {
        color = "#f87171"; // Red - lots of changes
      } else if (changeScore > 100) {
        color = "#fbbf24"; // Amber - moderate changes
      } else {
        color = "#4ade80"; // Green - small changes
      }
    } else {
      text = `${gitStatus.branch} ✓`;
      color = "#9ca3af"; // Gray - clean
    }

    // Draw the label
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = 256;
    canvas.height = 48;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Semi-transparent background pill
    const textWidth = ctx.measureText(text).width || 100;
    ctx.font = "600 20px ui-monospace, monospace";
    const measuredWidth = ctx.measureText(text).width;
    const pillWidth = Math.min(canvas.width - 8, measuredWidth + 24);
    const pillX = (canvas.width - pillWidth) / 2;
    const pillY = 8;
    const pillHeight = 32;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 6);
    ctx.fill();

    // Text
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    // Update texture
    const material = zone.gitLabel.material as THREE.SpriteMaterial;
    if (material.map) {
      material.map.dispose();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    material.map = texture;
    material.needsUpdate = true;

    zone.gitLabel.visible = true;
  }

  /**
   * Trigger activity pulse on a zone
   */
  pulseZone(sessionId: string): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;
    zone.pulseIntensity = 1.0;

    // Spawn particles
    this.emitParticles(zone);

    // In follow-active mode, animate camera to active zone
    if (
      this.cameraMode === "follow-active" &&
      this.focusedZoneId !== sessionId
    ) {
      this.focusedZoneId = sessionId;
      const target = zone.position.clone();
      const cameraPos = target.clone().add(new THREE.Vector3(8, 6, 8));
      this.animateCameraTo(cameraPos, target);
    }
  }

  /**
   * Set attention state on a zone (persists until cleared)
   */
  setZoneAttention(sessionId: string, reason: AttentionReason): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;
    zone.attentionReason = reason;
    zone.attentionTime = 0;
  }

  /**
   * Clear attention state on a zone
   * Note: Call setZoneStatus() after this to update colors
   */
  clearZoneAttention(sessionId: string): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;
    zone.attentionReason = null;
    zone.attentionTime = 0;
    zone.ring.scale.setScalar(1);
    // Colors are controlled by setZoneStatus(), not here
  }

  /**
   * Set zone status - changes floor AND ring color to indicate state
   */
  setZoneStatus(sessionId: string, status: Zone["status"]): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    zone.status = status;
    const floorMat = zone.floor.material as THREE.MeshStandardMaterial;
    const ringMat = zone.ring.material as THREE.MeshBasicMaterial;

    // Status color mappings (ice/cyan theme)
    const statusColors: Record<
      Zone["status"],
      { emissive: number; intensity: number; ring: number; ringOpacity: number }
    > = {
      idle: {
        emissive: zone.color,
        intensity: 0.02,
        ring: zone.color,
        ringOpacity: 0.4,
      },
      working: {
        emissive: 0x22d3ee,
        intensity: 0.08,
        ring: 0x22d3ee,
        ringOpacity: 0.5,
      },
      waiting: {
        emissive: 0xfbbf24,
        intensity: 0.06,
        ring: 0xfbbf24,
        ringOpacity: 0.6,
      },
      attention: {
        emissive: 0xf87171,
        intensity: 0.1,
        ring: 0xf87171,
        ringOpacity: 0.7,
      },
      offline: {
        emissive: 0x404050,
        intensity: 0.01,
        ring: 0x404050,
        ringOpacity: 0.2,
      },
    };

    const colors = statusColors[status];

    // Update floor
    floorMat.emissive.setHex(colors.emissive);
    floorMat.emissiveIntensity = colors.intensity;

    // Update ring to match (overrides attention pulse animation)
    ringMat.color.setHex(colors.ring);
    ringMat.opacity = colors.ringOpacity;
  }

  /**
   * Get all zones that need attention
   */
  getZonesNeedingAttention(): { id: string; reason: AttentionReason }[] {
    const result: { id: string; reason: AttentionReason }[] = [];
    for (const [id, zone] of this.zones) {
      if (zone.attentionReason) {
        result.push({ id, reason: zone.attentionReason });
      }
    }
    return result;
  }

  /**
   * Pulse a station's ring to highlight tool activity
   * Creates a brief glow effect (0.3s fade-in, 0.5s hold, 0.5s fade-out)
   */
  pulseStation(sessionId: string, stationType: StationType): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    const station = zone.stations.get(stationType);
    if (!station || stationType === "center") return;

    // Find the ring mesh in the station group (last child is typically the ring)
    let ring: THREE.Mesh | undefined;
    station.mesh.traverse((child) => {
      if (
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.RingGeometry
      ) {
        ring = child;
      }
    });

    if (!ring) return;

    const ringMat = (ring as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const baseOpacity = ringMat.opacity;

    // Don't add another pulse if already pulsing
    if (this.stationPulses.some((p) => p.ring === ring)) return;

    this.stationPulses.push({
      ring,
      age: 0,
      maxAge: 1.3, // 0.3s in + 0.5s hold + 0.5s out
      baseOpacity,
      peakOpacity: Math.min(1, baseOpacity + 0.5),
    });
  }

  /**
   * Create particle system for a zone
   */
  private createParticleSystem(color: number): {
    particles: THREE.Points;
    velocities: Float32Array;
  } {
    const particleCount = 20;
    const positions = new Float32Array(particleCount * 3);
    const velocities = new Float32Array(particleCount * 3);

    // Initialize all particles far below (truly hidden until emitted)
    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = -1000; // Far below - won't render through floor
      positions[i * 3 + 2] = 0;
      velocities[i * 3] = 0;
      velocities[i * 3 + 1] = 0;
      velocities[i * 3 + 2] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: color,
      size: 0.15,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particles = new THREE.Points(geometry, material);
    return { particles, velocities };
  }

  /**
   * Emit particles from a zone
   */
  private emitParticles(zone: Zone): void {
    const positions = zone.particles.geometry.attributes.position
      .array as Float32Array;
    const velocities = zone.particleVelocities;

    // Find inactive particles and activate them
    let activated = 0;
    for (let i = 0; i < positions.length / 3 && activated < 5; i++) {
      if (positions[i * 3 + 1] < -5) {
        // Spawn from center platform
        positions[i * 3] = (Math.random() - 0.5) * 2;
        positions[i * 3 + 1] = 0.5;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 2;

        // Random upward velocity with spread
        velocities[i * 3] = (Math.random() - 0.5) * 2;
        velocities[i * 3 + 1] = 2 + Math.random() * 2;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 2;

        activated++;
      }
    }

    zone.particles.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Create ambient floating particles for atmosphere
   */
  private createAmbientParticles(): void {
    const particleCount = 60;
    const positions = new Float32Array(particleCount * 3);

    // Initialize particles in a smaller area above zones
    for (let i = 0; i < particleCount; i++) {
      const radius = 2 + Math.random() * 15; // Stay closer to center (2-17 units)
      const angle = Math.random() * Math.PI * 2;
      const baseY = 6 + Math.random() * 12; // Float higher (6-18 units up)

      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = baseY;
      positions[i * 3 + 2] = Math.sin(angle) * radius;

      // Store particle data for animation
      this.ambientParticleData.push({
        baseY,
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.5,
        radius,
        angle,
      });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0x4ac8e8, // Cyan to match ice theme
      size: 0.12,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.ambientParticles = new THREE.Points(geometry, material);
    this.scene.add(this.ambientParticles);
  }

  /**
   * Update ambient particles - gentle floating motion
   */
  private updateAmbientParticles(delta: number): void {
    if (!this.ambientParticles) return;

    const positions = this.ambientParticles.geometry.attributes.position
      .array as Float32Array;

    for (let i = 0; i < this.ambientParticleData.length; i++) {
      const data = this.ambientParticleData[i];

      // Gentle circular drift
      data.angle += delta * 0.02 * data.speed;

      // Float up and down
      const yOffset = Math.sin(this.time * data.speed + data.phase) * 1.5;

      positions[i * 3] = Math.cos(data.angle) * data.radius;
      positions[i * 3 + 1] = data.baseY + yOffset;
      positions[i * 3 + 2] = Math.sin(data.angle) * data.radius;
    }

    this.ambientParticles.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Create all stations for a zone
   */
  private createZoneStations(
    group: THREE.Group,
    zoneColor: number,
  ): Map<StationType, Station> {
    const stations = new Map<StationType, Station>();

    const stationConfigs: Array<{
      type: StationType;
      position: [number, number, number];
      label: string;
      color: number;
    }> = [
      {
        type: "center",
        position: [0, 0, 0],
        label: "Center",
        color: zoneColor,
      },
      {
        type: "bookshelf",
        position: [0, 0, -4],
        label: "Library",
        color: 0x2a4a5a,
      }, // Dark teal
      { type: "desk", position: [4, 0, 0], label: "Desk", color: 0x3a4a5a }, // Blue-gray
      {
        type: "workbench",
        position: [-4, 0, 0],
        label: "Workbench",
        color: 0x3a4a55,
      }, // Steel blue
      {
        type: "terminal",
        position: [0, 0, 4],
        label: "Terminal",
        color: 0x1a2a3a,
      }, // Dark blue
      {
        type: "scanner",
        position: [3, 0, -3],
        label: "Scanner",
        color: 0x2a4a6a,
      }, // Blue
      {
        type: "antenna",
        position: [-3, 0, -3],
        label: "Antenna",
        color: 0x3a5a6a,
      }, // Teal
      {
        type: "portal",
        position: [-3, 0, 3],
        label: "Portal",
        color: 0x3a4a6a,
      }, // Deep blue
      {
        type: "taskboard",
        position: [3, 0, 3],
        label: "Task Board",
        color: 0x3a4a5a,
      }, // Blue-gray
    ];

    for (const config of stationConfigs) {
      const station = this.createStationInZone(group, config);
      stations.set(config.type, station);
    }

    return stations;
  }

  /**
   * Create a single station within a zone group
   */
  private createStationInZone(
    zoneGroup: THREE.Group,
    config: {
      type: StationType;
      position: [number, number, number];
      label: string;
      color: number;
    },
  ): Station {
    const stationGroup = new THREE.Group();
    const [x, y, z] = config.position;

    if (config.type === "center") {
      stationGroup.position.set(x, y, z);
      zoneGroup.add(stationGroup);

      // Position is relative to zone, need world position for Claude
      const localPos = new THREE.Vector3(x, 0.3, z);
      const worldPos = localPos.clone();
      zoneGroup.localToWorld(worldPos);

      return {
        type: config.type,
        position: worldPos,
        localPosition: localPos,
        mesh: stationGroup,
        label: config.label,
      };
    }

    // Base/table
    const baseGeometry = new THREE.BoxGeometry(1.5, 0.8, 1);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: config.color,
      roughness: 0.7,
      metalness: 0.2,
    });
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.y = 0.4;
    base.castShadow = true;
    base.receiveShadow = true;
    stationGroup.add(base);

    // Station-specific details (from modular station files)
    switch (config.type) {
      case "bookshelf":
        addBookshelfDetails(stationGroup);
        break;
      case "desk":
        addDeskDetails(stationGroup);
        break;
      case "workbench":
        addWorkbenchDetails(stationGroup);
        break;
      case "terminal":
        addTerminalDetails(stationGroup);
        break;
      case "antenna":
        addAntennaDetails(stationGroup);
        break;
      case "portal":
        addPortalDetails(stationGroup);
        break;
      case "scanner":
        addScannerDetails(stationGroup);
        break;
      case "taskboard":
        addTaskboardDetails(stationGroup);
        break;
    }

    // Station indicator ring
    const ringGeometry = new THREE.RingGeometry(0.9, 1, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    stationGroup.add(ring);

    stationGroup.position.set(x, y, z);
    zoneGroup.add(stationGroup);

    // Calculate world position for Claude to stand
    const localPos = new THREE.Vector3(x, 0.3, z);
    const toCenter = new THREE.Vector3(-x, 0, -z).normalize();
    localPos.add(toCenter.multiplyScalar(1.2));

    const worldPos = localPos.clone();
    zoneGroup.localToWorld(worldPos);

    return {
      type: config.type,
      position: worldPos,
      localPosition: localPos,
      mesh: stationGroup,
      label: config.label,
    };
  }

  private setupLighting(): void {
    // Ambient light - increased to compensate for fewer lights
    const ambient = new THREE.AmbientLight(0x606080, 0.8);
    this.scene.add(ambient);

    // Main directional light (sun) - reduced shadow map for performance
    const sun = new THREE.DirectionalLight(0xfff5e6, 1.2);
    sun.position.set(5, 10, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 512; // Reduced from 2048
    sun.shadow.mapSize.height = 512;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 20;
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 8;
    sun.shadow.camera.bottom = -8;
    this.scene.add(sun);

    // Hemisphere light for nice ambient fill (cheaper than point lights)
    const hemi = new THREE.HemisphereLight(0xfff5e6, 0x404060, 0.4);
    this.scene.add(hemi);
  }

  // World floor for empty-space click detection
  public worldFloor: THREE.Mesh | null = null;

  /**
   * Create an invisible floor plane for click detection only
   * (hex grid provides the visual floor)
   */
  private createWorldFloor(): void {
    const floorGeometry = new THREE.PlaneGeometry(500, 500);
    const floorMaterial = new THREE.MeshBasicMaterial({
      visible: false, // Invisible - just for raycasting
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    floor.name = "worldFloor";
    this.scene.add(floor);
    this.worldFloor = floor;
  }

  /**
   * Create a world-level hex grid overlay
   * Renders subtle hex outlines across the floor to establish
   * the hex grid as the "base reality" of the world
   *
   * Uses merged geometry (single BufferGeometry with LineSegments)
   * for optimal performance - allows many more hexes with one draw call
   */
  private createWorldHexGrid(): void {
    const hexRadius = this.hexGrid.hexRadius;
    const gridRange = this.gridRange;

    // Collect ALL line segments into one array
    // LineSegments needs pairs: [start1, end1, start2, end2, ...]
    const vertices: number[] = [];

    // Precompute hex corner angles (pointy-top orientation)
    const angles: number[] = [];
    for (let i = 0; i < 6; i++) {
      angles.push((Math.PI / 3) * i - Math.PI / 2);
    }

    // Iterate through hex coordinates in range
    for (let q = -gridRange; q <= gridRange; q++) {
      for (let r = -gridRange; r <= gridRange; r++) {
        // Skip if too far from center (keep it roughly circular)
        // Uses cube coordinate constraint: |q| + |r| + |s| / 2 <= range
        if (Math.abs(q) + Math.abs(r) + Math.abs(-q - r) > gridRange * 2)
          continue;

        const { x, z } = this.hexGrid.axialToCartesian({ q, r });

        // Add 6 line segments for this hex
        for (let i = 0; i < 6; i++) {
          const startAngle = angles[i];
          const endAngle = angles[(i + 1) % 6];

          // Start point
          vertices.push(
            x + hexRadius * Math.cos(startAngle),
            0,
            z + hexRadius * Math.sin(startAngle),
          );
          // End point
          vertices.push(
            x + hexRadius * Math.cos(endAngle),
            0,
            z + hexRadius * Math.sin(endAngle),
          );
        }
      }
    }

    // Create single merged geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );

    const material = new THREE.LineBasicMaterial({
      color: 0x4ac8e8, // Cyan/ice blue
      transparent: true,
      opacity: 0.35,
    });

    // ONE LineSegments object instead of ~127 Lines
    const lines = new THREE.LineSegments(geometry, material);
    lines.position.y = 0.01; // Just above floor

    this.scene.add(lines);
    this.worldHexGrid = lines;
  }

  // Station details moved to src/scene/stations/

  private handleResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  onRender(callback: (delta: number) => void): void {
    this.onRenderCallbacks.push(callback);
  }

  offRender(callback: (delta: number) => void): void {
    const index = this.onRenderCallbacks.indexOf(callback);
    if (index !== -1) {
      this.onRenderCallbacks.splice(index, 1);
    }
  }

  start(): void {
    this.fpsElement = document.getElementById("fps");

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);

      const delta = this.clock.getDelta();

      // FPS counter
      this.frameCount++;
      const now = performance.now();
      if (now - this.lastFpsUpdate >= 1000) {
        if (this.fpsElement) {
          this.fpsElement.textContent = `${this.frameCount} FPS`;
        }
        this.frameCount = 0;
        this.lastFpsUpdate = now;
      }

      // Animate camera if needed
      if (this.cameraAnimating) {
        const lerpFactor = 1 - Math.exp(-this.cameraLerpSpeed * delta);

        this.camera.position.lerp(this.cameraTargetPos, lerpFactor);
        this.controls.target.lerp(this.cameraTargetLookAt, lerpFactor);

        // Stop animating when close enough
        const posDist = this.camera.position.distanceTo(this.cameraTargetPos);
        const targetDist = this.controls.target.distanceTo(
          this.cameraTargetLookAt,
        );
        if (posDist < 0.01 && targetDist < 0.01) {
          this.camera.position.copy(this.cameraTargetPos);
          this.controls.target.copy(this.cameraTargetLookAt);
          this.cameraAnimating = false;
        }
      }

      // Update controls
      this.controls.update();

      // Update time accumulator
      this.time += delta;

      // Call render callbacks
      for (const callback of this.onRenderCallbacks) {
        callback(delta);
      }

      // Update ambient floating particles
      this.updateAmbientParticles(delta);

      // Update zone pulse effects and particles
      const zonesToFinalize: string[] = [];
      for (const zone of this.zones.values()) {
        // Handle enter/exit animations
        if (zone.animationState === "entering") {
          zone.animationProgress = Math.min(
            1,
            (zone.animationProgress ?? 0) + delta * 2,
          ); // 0.5 second animation

          // Ease out cubic for smooth deceleration
          const t = zone.animationProgress;
          const eased = 1 - Math.pow(1 - t, 3);

          // Scale up the zone group
          zone.group.scale.setScalar(eased);

          // Fade in ring and floor
          const ringMat = zone.ring.material as THREE.MeshBasicMaterial;
          const floorMat = zone.floor.material as THREE.MeshStandardMaterial;
          ringMat.opacity = eased * 0.4;
          floorMat.opacity = eased;

          // Show stations and particles when mostly visible
          if (t > 0.5) {
            for (const station of zone.stations.values()) {
              station.mesh.visible = true;
            }
            zone.particles.visible = true;
          }

          // Show label at the end
          if (t > 0.7 && zone.label) {
            zone.label.visible = true;
          }

          // Animation complete
          if (t >= 1) {
            zone.animationState = undefined;
            zone.animationProgress = undefined;
          }
        } else if (zone.animationState === "exiting") {
          zone.animationProgress = Math.min(
            1,
            (zone.animationProgress ?? 0) + delta * 2.5,
          ); // 0.4 second animation

          // Ease in cubic for accelerating exit
          const t = zone.animationProgress;
          const eased = 1 - Math.pow(t, 2);

          // Scale down
          zone.group.scale.setScalar(Math.max(0.01, eased));

          // Fade out ring and floor
          const ringMat = zone.ring.material as THREE.MeshBasicMaterial;
          const floorMat = zone.floor.material as THREE.MeshStandardMaterial;
          ringMat.opacity = eased * 0.4;
          floorMat.opacity = eased;

          // Hide elements early
          if (t > 0.3) {
            if (zone.label) zone.label.visible = false;
            zone.particles.visible = false;
          }
          if (t > 0.5) {
            for (const station of zone.stations.values()) {
              station.mesh.visible = false;
            }
          }

          // Animation complete - mark for removal
          if (t >= 1) {
            zonesToFinalize.push(zone.id);
          }
        }

        // Station floating animation - gentle bob
        for (const station of zone.stations.values()) {
          if (station.type !== "center") {
            const baseY = 0; // Stations sit on ground level
            const floatOffset =
              Math.sin(this.time * 1.5 + station.position.x * 0.5) * 0.03;
            station.mesh.position.y = baseY + floatOffset;
          }
        }
        const ringMat = zone.ring.material as THREE.MeshBasicMaterial;

        // Ring pulse animation (color is controlled by setZoneStatus, this only animates opacity/scale)
        if (zone.attentionReason) {
          zone.attentionTime += delta;

          // Different intensity by type - questions/errors are urgent, finished is subtle
          if (zone.attentionReason === "finished") {
            // Subtle, slow pulse for finished
            const pulse = Math.sin(zone.attentionTime * 2) * 0.5 + 0.5;
            zone.ring.scale.setScalar(1 + pulse * 0.02);
          } else {
            // More noticeable pulse for questions/errors
            const pulse = Math.sin(zone.attentionTime * 4) * 0.5 + 0.5;
            zone.ring.scale.setScalar(1 + pulse * 0.08);
          }
        } else if (zone.pulseIntensity > 0) {
          // Activity pulse (brief)
          zone.pulseIntensity = Math.max(0, zone.pulseIntensity - delta * 0.5);
          zone.ring.scale.setScalar(1 + zone.pulseIntensity * 0.05);
        } else {
          // No pulse - reset scale
          zone.ring.scale.setScalar(1);
        }

        // Update particles
        const positions = zone.particles.geometry.attributes.position
          .array as Float32Array;
        const velocities = zone.particleVelocities;
        let needsUpdate = false;

        for (let i = 0; i < positions.length / 3; i++) {
          const y = positions[i * 3 + 1];
          if (y > -5) {
            // Apply velocity
            positions[i * 3] += velocities[i * 3] * delta;
            positions[i * 3 + 1] += velocities[i * 3 + 1] * delta;
            positions[i * 3 + 2] += velocities[i * 3 + 2] * delta;

            // Apply gravity
            velocities[i * 3 + 1] -= 5 * delta;

            // Fade out when falling
            if (positions[i * 3 + 1] < 0) {
              positions[i * 3 + 1] = -1000; // Hide far below
            }

            needsUpdate = true;
          }
        }

        if (needsUpdate) {
          zone.particles.geometry.attributes.position.needsUpdate = true;
        }
      }

      // Finalize any zones that finished exit animation
      for (const zoneId of zonesToFinalize) {
        this.finalizeZoneDelete(zoneId);
      }

      // Update click pulses
      this.updateClickPulses(delta);

      // Update station pulses
      this.updateStationPulses(delta);

      // Update pending zones (loading animations)
      this.updatePendingZones(delta);

      // Update floating notifications (legacy)
      this.updateNotifications(delta);

      // Update zone notifications (new system)
      this.zoneNotifications.update(delta);

      // Update station panels
      this.stationPanels.update();

      // Animate group link glow
      this.groupLinkTime += delta;
      for (const link of this.groupLinks.values()) {
        const glowMat = link.glowLine.material as THREE.LineBasicMaterial;
        const pulse = 0.15 + 0.15 * Math.sin(this.groupLinkTime * 2);
        glowMat.opacity = pulse;
      }

      // Render
      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Create a text sprite for floating labels
   * Dynamically scales font size to fit long text
   */
  private createTextSprite(text: string, color = "#ffffff"): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    // Size canvas for text
    canvas.width = 512;
    canvas.height = 96;
    const maxWidth = canvas.width - 60;

    // Calculate optimal font size (start large, shrink to fit)
    let fontSize = 28;
    const minFontSize = 14;
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

    while (ctx.measureText(text).width > maxWidth && fontSize > minFontSize) {
      fontSize -= 2;
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    }

    // If still too wide, abbreviate
    let displayText = text;
    if (ctx.measureText(text).width > maxWidth) {
      // For paths, show .../<parent>/<file>
      if (text.includes("/")) {
        const parts = text.split("/");
        if (parts.length >= 2) {
          displayText = ".../" + parts.slice(-2).join("/");
        } else {
          displayText = ".../" + parts.pop();
        }
      }
      // For commands, show beginning and end
      if (ctx.measureText(displayText).width > maxWidth) {
        const maxChars = Math.floor(maxWidth / (fontSize * 0.6));
        const half = Math.floor((maxChars - 3) / 2);
        displayText = text.slice(0, half) + "..." + text.slice(-half);
      }
    }

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Dark backdrop for readability
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillText(displayText, centerX, centerY);
    ctx.fillText(displayText, centerX, centerY);
    ctx.restore();

    // Colored glow - outer
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.fillText(displayText, centerX, centerY);
    ctx.fillText(displayText, centerX, centerY);
    ctx.restore();

    // Colored glow - inner
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.fillText(displayText, centerX, centerY);
    ctx.restore();

    // Main text - white
    ctx.fillStyle = "#ffffff";
    ctx.fillText(displayText, centerX, centerY);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(4, 0.8, 1);

    return sprite;
  }

  /**
   * Set context text above a station in a specific zone
   */
  setStationContext(
    stationType: StationType,
    context: string | null,
    sessionId?: string,
  ): void {
    // Find stations either from zone or legacy
    let stations: Map<StationType, Station>;
    if (sessionId) {
      const zone = this.zones.get(sessionId);
      if (!zone) return;
      stations = zone.stations;
    } else {
      stations = this.stations;
    }

    const station = stations.get(stationType);
    if (!station) return;

    // Remove existing context sprite
    if (station.contextSprite) {
      station.mesh.remove(station.contextSprite);
      station.contextSprite.material.map?.dispose();
      station.contextSprite.material.dispose();
      station.contextSprite = undefined;
    }

    // Add new context if provided
    if (context) {
      const color = this.getStationColor(stationType);
      station.contextSprite = this.createTextSprite(context, color);
      station.contextSprite.position.set(0, 2.5, 0);
      station.mesh.add(station.contextSprite);
    }
  }

  /**
   * Clear all station contexts for a zone (or all zones if no sessionId)
   */
  clearAllContexts(sessionId?: string): void {
    if (sessionId) {
      const zone = this.zones.get(sessionId);
      if (!zone) return;
      for (const [type] of zone.stations) {
        this.setStationContext(type, null, sessionId);
      }
    } else {
      // Clear all zones
      for (const [zoneId, zone] of this.zones) {
        for (const [type] of zone.stations) {
          this.setStationContext(type, null, zoneId);
        }
      }
    }
  }

  private getStationColor(type: StationType): string {
    const colors: Record<StationType, string> = {
      center: "#4ac8e8", // Cyan (primary)
      bookshelf: "#fbbf24", // Orange/gold for books
      desk: "#4ade80", // Green
      workbench: "#f97316", // Orange
      terminal: "#22d3ee", // Cyan
      scanner: "#60a5fa", // Blue
      antenna: "#4ac8e8", // Cyan
      portal: "#22d3d8", // Teal
      taskboard: "#fb923c", // Orange
    };
    return colors[type] || "#ffffff";
  }

  /**
   * Spawn a click pulse effect at a world position
   * Creates an expanding ring + hex wave that ripples outward
   *
   * IMPORTANT: This uses additive blending (THREE.AdditiveBlending) which is critical.
   *
   * Why previous approaches failed:
   * 1. Normal alpha blending with opacity fade: Our overlay would OBSCURE the permanent
   *    hex grid underneath as it faded. Even at low opacity, the overlay partially blocked
   *    the grid, making it appear darker than baseline. When removed, it "popped" back.
   *
   * 2. Trying to fade TO the grid's opacity (0.35): This caused stacking - our overlay
   *    at 0.35 + permanent grid at 0.35 = brighter than normal. Couldn't match baseline.
   *
   * 3. Creating all hexes upfront with delays: Even with opacity 0, adding geometry
   *    caused visual artifacts. Outer tiles would flicker before the wave reached them.
   *
   * Why this approach works:
   * - Additive blending only ADDS light, never obscures. At opacity 0, it contributes
   *   nothing, so the permanent grid shows through unchanged.
   * - depthWrite: false prevents z-fighting with the permanent grid at y=0.01
   * - setTimeout spawns each ring only when needed, not all at once
   * - Simple fade from peak to 0 with ease-out curve for smooth disappearance
   */
  spawnClickPulse(x: number, z: number, color = 0x4ac8e8, y = 0.03): void {
    const hexRadius = this.hexGrid.hexRadius;
    const clickedHex = this.hexGrid.cartesianToHex(x, z);

    // 1. Expanding ring at click point
    const ringGeometry = new THREE.RingGeometry(0.2, 0.4, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x8eefff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y, z);
    this.scene.add(ring);

    this.clickPulses.push({
      mesh: ring,
      age: 0,
      maxAge: 0.5,
      type: "ring",
    });

    // 2. Hex wave - spawn each ring over time
    const spawnHexRing = (ringNum: number, strength: number) => {
      const hexes =
        ringNum === 0 ? [clickedHex] : this.getHexRing(clickedHex, ringNum);

      for (const hex of hexes) {
        const center = this.hexGrid.axialToCartesian(hex);
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 2;
          points.push(
            new THREE.Vector3(
              center.x + hexRadius * Math.cos(angle),
              0.02,
              center.z + hexRadius * Math.sin(angle),
            ),
          );
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
          color: 0x8eefff,
          transparent: true,
          opacity: strength,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        this.scene.add(line);

        this.clickPulses.push({
          mesh: line,
          age: 0,
          maxAge: 0.5,
          type: "ripple",
          startOpacity: strength,
        });
      }
    };

    // Spawn rings with gentler decay so wave travels further
    const maxRings = 7;
    const msPerRing = 45;

    for (let r = 0; r <= maxRings; r++) {
      const strength = Math.pow(0.6, r); // Gentler: 1.0 -> 0.6 -> 0.36 -> 0.22 -> 0.13 -> 0.08 -> 0.05 -> 0.03
      if (strength < 0.03) continue; // Skip if too dim
      if (r === 0) {
        spawnHexRing(0, strength);
      } else {
        setTimeout(() => spawnHexRing(r, strength), r * msPerRing);
      }
    }
  }

  /**
   * Get all hex coordinates in a ring at distance `ring` from center
   */
  private getHexRing(
    center: { q: number; r: number },
    ring: number,
  ): Array<{ q: number; r: number }> {
    if (ring === 0) return [center];

    const results: Array<{ q: number; r: number }> = [];
    const directions = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];

    // Start at "east" corner
    let hex = { q: center.q + ring, r: center.r };

    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        results.push({ ...hex });
        const dir = directions[(side + 2) % 6];
        hex = { q: hex.q + dir.q, r: hex.r + dir.r };
      }
    }

    return results;
  }

  /**
   * Update click pulse animations (called from render loop)
   */
  private updateClickPulses(delta: number): void {
    for (let i = this.clickPulses.length - 1; i >= 0; i--) {
      const pulse = this.clickPulses[i];

      // Handle delay before animation starts
      if (pulse.delay && pulse.delay > 0) {
        pulse.delay -= delta;
        continue; // Don't animate yet
      }

      pulse.age += delta;
      const progress = pulse.age / pulse.maxAge;

      if (progress >= 1) {
        // Remove finished pulse
        this.scene.remove(pulse.mesh);
        pulse.mesh.geometry.dispose();
        (pulse.mesh.material as THREE.Material).dispose();
        this.clickPulses.splice(i, 1);
      } else if (pulse.type === "ring") {
        // Ring: expand and fade out
        const scale = 1 + progress * 4;
        pulse.mesh.scale.set(scale, scale, 1);
        const opacity = 0.9 * (1 - progress * progress);
        (pulse.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
      } else if (pulse.type === "ripple") {
        // Ripple: appear at peak, fade to 0 with ease-out curve
        const material = pulse.mesh.material as THREE.LineBasicMaterial;
        const peakOpacity = pulse.startOpacity ?? 1.0;
        // Ease-out: stays bright early, fades smoothly to 0 at end
        const fade = Math.pow(1 - progress, 2);
        material.opacity = peakOpacity * fade;
      } else {
        // Hex: pulse brightness then fade out
        const pulsePhase = Math.sin(progress * Math.PI * 2) * 0.3;
        const fadeOut = 1 - progress * progress;
        const opacity = Math.min(1, (0.7 + pulsePhase) * fadeOut);
        (pulse.mesh.material as THREE.LineBasicMaterial).opacity = opacity;
      }
    }
  }

  /**
   * Update station pulse animations (called from render loop)
   */
  private updateStationPulses(delta: number): void {
    for (let i = this.stationPulses.length - 1; i >= 0; i--) {
      const pulse = this.stationPulses[i];
      pulse.age += delta;
      const progress = pulse.age / pulse.maxAge;

      if (progress >= 1) {
        // Animation complete - restore base opacity and remove
        const mat = pulse.ring.material as THREE.MeshBasicMaterial;
        mat.opacity = pulse.baseOpacity;
        this.stationPulses.splice(i, 1);
      } else {
        // Animate opacity: 0.3s fade in, 0.5s hold, 0.5s fade out
        const mat = pulse.ring.material as THREE.MeshBasicMaterial;
        const fadeInEnd = 0.23; // 0.3 / 1.3
        const holdEnd = 0.62; // (0.3 + 0.5) / 1.3

        let opacity: number;
        if (progress < fadeInEnd) {
          // Fade in
          const t = progress / fadeInEnd;
          opacity =
            pulse.baseOpacity + (pulse.peakOpacity - pulse.baseOpacity) * t;
        } else if (progress < holdEnd) {
          // Hold at peak
          opacity = pulse.peakOpacity;
        } else {
          // Fade out
          const t = (progress - holdEnd) / (1 - holdEnd);
          opacity =
            pulse.peakOpacity - (pulse.peakOpacity - pulse.baseOpacity) * t;
        }
        mat.opacity = opacity;
      }
    }
  }

  // ============================================================================
  // Floating Notifications (file changes, etc.)
  // ============================================================================

  /**
   * Show a floating notification above a zone
   * @param sessionId - Zone to show notification above
   * @param text - Text to display (e.g., "File.tsx +25, -2")
   * @param color - Text color (default: green for success)
   */
  showNotification(sessionId: string, text: string, color = "#4ade80"): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    // Create notification sprite
    const sprite = this.createNotificationSprite(text, color);

    // Position above zone center
    const zoneCenter = zone.floor.position.clone();
    const startY = 2.5;
    sprite.position.set(zoneCenter.x, startY, zoneCenter.z);
    this.scene.add(sprite);

    this.notifications.push({
      sprite,
      startY,
      age: 0,
      maxAge: 3, // 3 seconds
    });
  }

  /**
   * Create a notification sprite (smaller, more compact than labels)
   */
  private createNotificationSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    canvas.width = 512;
    canvas.height = 64;

    // Font
    const fontSize = 24;
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // Dark backdrop pill
    const textWidth = ctx.measureText(text).width;
    const padding = 20;
    const pillWidth = textWidth + padding * 2;
    const pillHeight = 40;
    const pillX = centerX - pillWidth / 2;
    const pillY = centerY - pillHeight / 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 8);
    ctx.fill();

    // Text with color
    ctx.fillStyle = color;
    ctx.fillText(text, centerX, centerY);

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
    sprite.scale.set(4, 0.5, 1);

    return sprite;
  }

  /**
   * Update floating notifications (called from render loop)
   */
  private updateNotifications(delta: number): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const notif = this.notifications[i];
      notif.age += delta;

      const progress = notif.age / notif.maxAge;

      if (progress >= 1) {
        // Remove finished notification
        this.scene.remove(notif.sprite);
        notif.sprite.material.map?.dispose();
        notif.sprite.material.dispose();
        this.notifications.splice(i, 1);
      } else {
        // Animate: float up and fade out
        const floatHeight = progress * 1.5; // Float up 1.5 units
        notif.sprite.position.y = notif.startY + floatHeight;

        // Fade: stay visible for first 60%, then fade out
        const fadeStart = 0.6;
        const opacity =
          progress < fadeStart
            ? 1
            : 1 - (progress - fadeStart) / (1 - fadeStart);
        notif.sprite.material.opacity = opacity;
      }
    }
  }

  // ===== DRAW MODE - HEX PAINTING =====

  /**
   * Paint a hex with a color (draw mode)
   * If hex is already painted with same color, increases height
   * Returns true if painted, false if skipped (e.g., zone occupied)
   */
  paintHex(hex: { q: number; r: number }, color: number): boolean {
    // If hex has a zone, raise the zone instead of painting
    if (this.hexGrid.isOccupied(hex)) {
      const sessionId = this.hexGrid.getOccupant(hex);
      if (sessionId && drawMode.is3DMode()) {
        return this.raiseZone(sessionId, 0.5);
      }
      return false; // Can't paint on zones when 3D mode is off
    }

    const key = `${hex.q},${hex.r}`;
    const existing = this.paintedHexes.get(key);

    // Determine new height
    let newHeight = 0.5; // Base height for new hex
    const maxHeight = 100; // Near-arbitrary cap for creative building

    if (existing) {
      if (existing.color === color && drawMode.is3DMode()) {
        // Same color + 3D mode - increase height
        newHeight = Math.min(existing.height + 0.5, maxHeight);
      }
      // Remove old mesh
      this.scene.remove(existing.mesh);
      existing.mesh.geometry.dispose();
      (existing.mesh.material as THREE.MeshStandardMaterial).dispose();
    }

    // Create filled hex mesh
    const { x, z } = this.hexGrid.axialToCartesian(hex);
    const hexRadius = this.hexGrid.hexRadius * 0.95; // Slightly smaller to show grid lines

    // Create hex shape (pointy-top)
    const shape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const px = hexRadius * Math.cos(angle);
      const py = hexRadius * Math.sin(angle);
      if (i === 0) {
        shape.moveTo(px, py);
      } else {
        shape.lineTo(px, py);
      }
    }
    shape.closePath();

    // Use ExtrudeGeometry for 3D height
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: newHeight,
      bevelEnabled: false,
    });

    const material = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.25,
      roughness: 0.4,
      metalness: 0.3,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // Lay flat (extrudes upward)
    mesh.position.set(x, 0.02, z); // Just above grid lines

    this.scene.add(mesh);
    this.paintedHexes.set(key, { mesh, height: newHeight, color });

    // Update any text tile at this position to match new height
    this.updateTextTileAtHex(hex);

    // Visual feedback when stacking (height increased in 3D mode)
    if (
      existing &&
      existing.color === color &&
      newHeight > existing.height &&
      drawMode.is3DMode()
    ) {
      this.spawnStackEffect(x, z, newHeight, color);
    }

    return true;
  }

  /**
   * Update text tile position at a hex (after height change)
   */
  private updateTextTileAtHex(hex: { q: number; r: number }): void {
    for (const [, entry] of this.textTileSprites) {
      if (entry.tile.position.q === hex.q && entry.tile.position.r === hex.r) {
        const { x, z } = this.hexGrid.axialToCartesian(hex);
        const height = this.getPaintedHexHeight(hex);
        entry.sprite.position.set(x, 0.5 + height, z);
        break;
      }
    }
  }

  /**
   * Spawn visual effect when hex height increases (stacking feedback)
   */
  private spawnStackEffect(
    x: number,
    z: number,
    height: number,
    color: number,
  ): void {
    // Create a quick pulse ring that expands and fades
    const ringGeometry = new THREE.RingGeometry(0.5, 1.5, 6);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, height + 0.1, z);
    this.scene.add(ring);

    // Animate: scale up and fade out
    const startTime = performance.now();
    const duration = 300; // ms
    const animate = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease out
      const eased = 1 - Math.pow(1 - progress, 3);

      ring.scale.setScalar(1 + eased * 2);
      ringMaterial.opacity = 0.8 * (1 - eased);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.scene.remove(ring);
        ringGeometry.dispose();
        ringMaterial.dispose();
      }
    };
    requestAnimationFrame(animate);
  }

  /**
   * Clear a painted hex (or lower a zone if hex is occupied)
   */
  clearPaintedHex(hex: { q: number; r: number }): void {
    // If hex has a zone, lower the zone instead of clearing
    if (this.hexGrid.isOccupied(hex)) {
      const sessionId = this.hexGrid.getOccupant(hex);
      if (sessionId && drawMode.is3DMode()) {
        this.lowerZone(sessionId, 0.5);
      }
      return;
    }

    const key = `${hex.q},${hex.r}`;
    const data = this.paintedHexes.get(key);
    if (data) {
      this.scene.remove(data.mesh);
      data.mesh.geometry.dispose();
      (data.mesh.material as THREE.MeshStandardMaterial).dispose();
      this.paintedHexes.delete(key);
      // Update any text tile at this position (back to floor level)
      this.updateTextTileAtHex(hex);
    }
  }

  /**
   * Check if a hex is painted
   */
  isPaintedHex(hex: { q: number; r: number }): boolean {
    return this.paintedHexes.has(`${hex.q},${hex.r}`);
  }

  /**
   * Clear all painted hexes
   */
  clearAllPaintedHexes(): void {
    // Only play sound if there's something to clear
    if (this.paintedHexes.size > 0) {
      soundManager.play("clear");
    }

    for (const [, data] of this.paintedHexes) {
      this.scene.remove(data.mesh);
      data.mesh.geometry.dispose();
      (data.mesh.material as THREE.MeshStandardMaterial).dispose();
    }
    this.paintedHexes.clear();
  }

  /**
   * Get all painted hex meshes (for raycasting)
   */
  getPaintedHexMeshes(): THREE.Mesh[] {
    return Array.from(this.paintedHexes.values()).map((data) => data.mesh);
  }

  /**
   * Get all painted hex data (for persistence)
   */
  getPaintedHexes(): Array<{
    q: number;
    r: number;
    color: number;
    height: number;
  }> {
    const result: Array<{
      q: number;
      r: number;
      color: number;
      height: number;
    }> = [];
    for (const [key, data] of this.paintedHexes) {
      const [q, r] = key.split(",").map(Number);
      result.push({ q, r, color: data.color, height: data.height });
    }
    return result;
  }

  /**
   * Load painted hexes (for persistence)
   */
  loadPaintedHexes(
    hexes: Array<{ q: number; r: number; color: number; height?: number }>,
  ): void {
    this.clearAllPaintedHexes();
    for (const hex of hexes) {
      // Paint hex repeatedly to build up height
      const targetHeight = hex.height ?? 0.5;
      const clicks = Math.round(targetHeight / 0.5);
      for (let i = 0; i < clicks; i++) {
        this.paintHex({ q: hex.q, r: hex.r }, hex.color);
      }
    }
  }

  /**
   * Get all zone elevations (for persistence)
   */
  getZoneElevations(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [sessionId, zone] of this.zones) {
      if (zone.elevation > 0) {
        result[sessionId] = zone.elevation;
      }
    }
    return result;
  }

  /**
   * Load zone elevations (for persistence)
   * Stores elevations for zones that don't exist yet - they'll be applied when created
   */
  loadZoneElevations(elevations: Record<string, number>): void {
    for (const [sessionId, elevation] of Object.entries(elevations)) {
      const zone = this.zones.get(sessionId);
      if (zone) {
        // Zone exists - apply elevation immediately (without animation)
        this.setZoneElevation(sessionId, elevation);
      } else {
        // Zone doesn't exist yet - store for later
        this.pendingZoneElevations.set(sessionId, elevation);
      }
    }
  }

  /**
   * Set a zone's elevation directly (no animation, for loading saved state)
   */
  private setZoneElevation(sessionId: string, elevation: number): void {
    const zone = this.zones.get(sessionId);
    if (!zone) return;

    zone.elevation = elevation;
    zone.group.position.y = elevation;
    this.updateZoneEdgeLines(zone);
    this.updateZoneSideMesh(zone);
    this.notifyZoneElevationChange(sessionId, elevation);
  }

  // ============================================================================
  // Zone Drag-and-Drop
  // ============================================================================

  /**
   * Move a zone to a new hex position with optional animation
   */
  moveZone(
    sessionId: string,
    targetHex: { q: number; r: number },
    animate = true,
  ): boolean {
    const zone = this.zones.get(sessionId);
    if (!zone) return false;

    // Release current hex, occupy new one
    this.hexGrid.release(sessionId);
    this.hexGrid.occupy(targetHex, sessionId);

    // Calculate new world position
    const { x, z } = this.hexGrid.axialToCartesian(targetHex);
    const newPosition = new THREE.Vector3(x, zone.elevation, z);

    if (animate) {
      const startPos = zone.group.position.clone();
      const startTime = performance.now();
      const duration = 300;

      const animateMove = () => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - progress, 3);

        zone.group.position.lerpVectors(startPos, newPosition, eased);

        if (progress < 1) {
          requestAnimationFrame(animateMove);
        } else {
          // Final position - update all related state
          zone.position.set(x, 0, z);
          this.updateStationPositions(sessionId);
          // Update edge lines and side mesh (added to scene, not group)
          if (zone.edgeLines) {
            zone.edgeLines.position.set(x, 0, z);
          }
          if (zone.sideMesh) {
            zone.sideMesh.position.set(x, 0, z);
          }
        }
      };
      requestAnimationFrame(animateMove);
    } else {
      zone.group.position.copy(newPosition);
      zone.position.set(x, 0, z);
      if (zone.edgeLines) {
        zone.edgeLines.position.set(x, 0, z);
      }
      if (zone.sideMesh) {
        zone.sideMesh.position.set(x, 0, z);
      }
      this.updateStationPositions(sessionId);
    }

    return true;
  }

  /**
   * Show a ghost hex preview at the target position during drag
   */
  showDragPreview(hex: { q: number; r: number }, color: number): void {
    const { x, z } = this.hexGrid.axialToCartesian(hex);

    if (!this.dragPreview) {
      // Create the preview group
      const group = new THREE.Group();

      // Hex outline
      const hexRadius = 10;
      const outlinePositions: number[] = [];
      for (let i = 0; i <= 6; i++) {
        const angle = (Math.PI / 3) * (i % 6) - Math.PI / 2;
        outlinePositions.push(
          hexRadius * Math.cos(angle),
          0.1,
          hexRadius * Math.sin(angle),
        );
      }
      const outlineGeom = new THREE.BufferGeometry();
      outlineGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(outlinePositions, 3),
      );
      const outlineMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
      });
      const outline = new THREE.Line(outlineGeom, outlineMat);
      group.add(outline);

      // Filled hex (semi-transparent)
      const fillShape = new THREE.Shape();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const px = hexRadius * Math.cos(angle);
        const pz = hexRadius * Math.sin(angle);
        if (i === 0) fillShape.moveTo(px, pz);
        else fillShape.lineTo(px, pz);
      }
      fillShape.closePath();
      const fillGeom = new THREE.ShapeGeometry(fillShape);
      fillGeom.rotateX(-Math.PI / 2);
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      fill.position.y = 0.05;
      group.add(fill);

      this.scene.add(group);
      this.dragPreview = group;
    }

    // Update position and color
    this.dragPreview.position.set(x, 0, z);

    // Update color if changed
    this.dragPreview.children.forEach((child) => {
      if (child instanceof THREE.Line) {
        (child.material as THREE.LineBasicMaterial).color.setHex(color);
      } else if (child instanceof THREE.Mesh) {
        (child.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    });

    this.dragPreview.visible = true;
  }

  /**
   * Hide and clean up the drag preview
   */
  hideDragPreview(): void {
    if (this.dragPreview) {
      this.dragPreview.visible = false;
    }
  }

  /**
   * Check if a hex position is valid for zone placement (not occupied by another zone)
   */
  isHexAvailable(
    hex: { q: number; r: number },
    excludeSessionId?: string,
  ): boolean {
    if (!this.hexGrid.isOccupied(hex)) return true;
    if (excludeSessionId && this.hexGrid.getOccupant(hex) === excludeSessionId)
      return true;
    return false;
  }

  /**
   * Get current grid range (number of hex rings)
   */
  getGridRange(): number {
    return this.gridRange;
  }

  /**
   * Set grid range and rebuild the world hex grid
   */
  setGridRange(range: number): void {
    // Clamp to reasonable values
    this.gridRange = Math.max(5, Math.min(80, range));

    // Remove old grid
    if (this.worldHexGrid) {
      this.scene.remove(this.worldHexGrid);
      if (this.worldHexGrid instanceof THREE.LineSegments) {
        this.worldHexGrid.geometry.dispose();
        (this.worldHexGrid.material as THREE.Material).dispose();
      }
      this.worldHexGrid = null;
    }

    // Create new grid with updated range
    this.createWorldHexGrid();
  }

  // ============================================================================
  // Zone Group Links (Civ6-style connecting lines)
  // ============================================================================

  /**
   * Update group links from server data.
   * Takes groups with managed session IDs and resolves to claude session IDs.
   * @param groups - Array of ZoneGroup from server
   * @param managedSessions - Array of ManagedSession for ID resolution
   */
  updateGroupLinks(
    groups: Array<{
      id: string;
      name?: string;
      memberSessionIds: string[];
    }>,
    managedSessions: Array<{
      id: string;
      claudeSessionId?: string;
    }>,
  ): void {
    // Build managed->claude lookup
    const managedToClaudeMap = new Map<string, string>();
    for (const ms of managedSessions) {
      if (ms.claudeSessionId) {
        managedToClaudeMap.set(ms.id, ms.claudeSessionId);
      }
    }

    // Track which group IDs are still active
    const activeGroupIds = new Set<string>();

    for (const group of groups) {
      // Resolve managed IDs to claude session IDs (which match zone IDs)
      const claudeIds = group.memberSessionIds
        .map((mid) => managedToClaudeMap.get(mid))
        .filter((id): id is string => !!id && this.zones.has(id));

      if (claudeIds.length < 2) {
        // Not enough visible zones to render a link
        continue;
      }

      activeGroupIds.add(group.id);
      const existing = this.groupLinks.get(group.id);

      if (existing) {
        // Update existing link positions
        this.updateGroupLinkPositions(group.id, claudeIds);
      } else {
        // Create new link
        this.createGroupLink(group.id, claudeIds, group.name);
      }
    }

    // Remove stale links
    for (const [groupId] of this.groupLinks) {
      if (!activeGroupIds.has(groupId)) {
        this.removeGroupLink(groupId);
      }
    }
  }

  /**
   * Create glowing connection lines between grouped zones
   */
  private createGroupLink(
    groupId: string,
    claudeSessionIds: string[],
    name?: string,
  ): void {
    // Get zone positions
    const positions: THREE.Vector3[] = [];
    for (const cid of claudeSessionIds) {
      const zone = this.zones.get(cid);
      if (zone) {
        positions.push(
          new THREE.Vector3(
            zone.group.position.x,
            zone.elevation + 0.3,
            zone.group.position.z,
          ),
        );
      }
    }

    if (positions.length < 2) return;

    // Build line geometry connecting all pairs
    const linePoints: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        linePoints.push(
          positions[i].x,
          positions[i].y,
          positions[i].z,
          positions[j].x,
          positions[j].y,
          positions[j].z,
        );
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(linePoints, 3),
    );

    // Solid thin line
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.4,
    });
    const line = new THREE.LineSegments(geom, lineMat);
    this.scene.add(line);

    // Wider glow line (pulsing)
    const glowGeom = geom.clone();
    const glowMat = new THREE.LineBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.15,
      linewidth: 1,
    });
    const glowLine = new THREE.LineSegments(glowGeom, glowMat);
    this.scene.add(glowLine);

    // Optional group label at midpoint
    let label: THREE.Sprite | undefined;
    if (name && positions.length >= 2) {
      const mid = new THREE.Vector3()
        .addVectors(positions[0], positions[1])
        .multiplyScalar(0.5);
      mid.y += 2;
      label = this.createGroupLabelSprite(name);
      label.position.copy(mid);
      this.scene.add(label);
    }

    this.groupLinks.set(groupId, {
      line: line as THREE.Line,
      glowLine: glowLine as THREE.Line,
      label,
      memberIds: claudeSessionIds,
    });
  }

  /**
   * Update positions of an existing group link
   */
  private updateGroupLinkPositions(
    groupId: string,
    claudeSessionIds: string[],
  ): void {
    const link = this.groupLinks.get(groupId);
    if (!link) return;

    const positions: THREE.Vector3[] = [];
    for (const cid of claudeSessionIds) {
      const zone = this.zones.get(cid);
      if (zone) {
        positions.push(
          new THREE.Vector3(
            zone.group.position.x,
            zone.elevation + 0.3,
            zone.group.position.z,
          ),
        );
      }
    }

    if (positions.length < 2) return;

    // Rebuild line geometry
    const linePoints: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        linePoints.push(
          positions[i].x,
          positions[i].y,
          positions[i].z,
          positions[j].x,
          positions[j].y,
          positions[j].z,
        );
      }
    }

    const posAttr = new THREE.Float32BufferAttribute(linePoints, 3);
    link.line.geometry.setAttribute("position", posAttr);
    link.line.geometry.attributes.position.needsUpdate = true;
    link.glowLine.geometry.setAttribute("position", posAttr.clone());
    link.glowLine.geometry.attributes.position.needsUpdate = true;

    // Update label position
    if (link.label && positions.length >= 2) {
      const mid = new THREE.Vector3()
        .addVectors(positions[0], positions[1])
        .multiplyScalar(0.5);
      mid.y += 2;
      link.label.position.copy(mid);
    }

    link.memberIds = claudeSessionIds;
  }

  /**
   * Remove a group link's visuals
   */
  removeGroupLink(groupId: string): void {
    const link = this.groupLinks.get(groupId);
    if (!link) return;

    this.scene.remove(link.line);
    link.line.geometry.dispose();
    (link.line.material as THREE.Material).dispose();

    this.scene.remove(link.glowLine);
    link.glowLine.geometry.dispose();
    (link.glowLine.material as THREE.Material).dispose();

    if (link.label) {
      this.scene.remove(link.label);
      link.label.material.map?.dispose();
      link.label.material.dispose();
    }

    this.groupLinks.delete(groupId);
  }

  /**
   * Remove all group links
   */
  clearGroupLinks(): void {
    for (const [groupId] of this.groupLinks) {
      this.removeGroupLink(groupId);
    }
  }

  /**
   * Create a small text sprite for group labels
   */
  private createGroupLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = 256;
    canvas.height = 64;

    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(96, 165, 250, 0.7)";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(6, 1.5, 1);
    return sprite;
  }

  dispose(): void {
    this.stop();
    this.clearAllContexts();
    // Clean up group links
    this.clearGroupLinks();
    // Clean up painted hexes (draw mode)
    this.clearAllPaintedHexes();
    // Clean up zone notifications (new system)
    this.zoneNotifications.dispose();
    // Clean up notifications (legacy)
    for (const notif of this.notifications) {
      this.scene.remove(notif.sprite);
      notif.sprite.material.map?.dispose();
      notif.sprite.material.dispose();
    }
    this.notifications = [];
    // Clean up click pulses
    for (const pulse of this.clickPulses) {
      this.scene.remove(pulse.mesh);
      pulse.mesh.geometry.dispose();
      (pulse.mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    this.clickPulses = [];
    // Clean up hover highlight
    this.renderer.domElement.removeEventListener("mousemove", this.handleHover);
    this.renderer.domElement.removeEventListener(
      "mouseleave",
      this.handleHoverLeave,
    );
    window.removeEventListener("resize", this.handleResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
