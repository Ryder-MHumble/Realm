/**
 * ICharacter - Interface for swappable character models
 *
 * Any character model (Claude, ClaudeMon, future models) should implement this
 * interface to be drop-in replaceable in the workshop scene.
 */

import * as THREE from "three";
import type { StationType, RealmRole } from "../../shared/types";

export type CharacterState = "idle" | "walking" | "working" | "thinking";

export interface CharacterOptions {
  scale?: number;
  color?: number;
  statusColor?: number;
  startStation?: StationType;
  /** Realm role - overrides color/statusColor with role-specific presets */
  role?: RealmRole;
  /** Custom display name (overrides role default) */
  displayName?: string;
  /** Current task label shown above character */
  taskLabel?: string;
}

export interface ICharacter {
  /** The Three.js group containing all character meshes */
  readonly mesh: THREE.Group;

  /** Current animation/behavior state */
  state: CharacterState;

  /** Current station the character is at or heading to */
  currentStation: StationType;

  /** Unique identifier for this character instance */
  readonly id: string;

  /** Move character to a named station */
  moveTo(station: StationType): void;

  /** Move character to a specific position */
  moveToPosition(position: THREE.Vector3, station: StationType): void;

  /** Set the character's state (affects animation and status indicators) */
  setState(state: CharacterState): void;

  /** Clean up resources when character is removed */
  dispose(): void;
}

/**
 * Available character models
 * Add new models here as they're created
 */
export type CharacterModel = "claude" | "claudemon";

/**
 * Default character model to use
 */
export const DEFAULT_CHARACTER_MODEL: CharacterModel = "claudemon";
