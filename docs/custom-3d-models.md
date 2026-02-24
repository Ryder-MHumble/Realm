# Custom 3D Model Implementation Guide

## Current State

All models in Realm are procedurally generated with Three.js primitives (no external files):

- **Character (ClaudeMon)**: ~20 geometries in src/entities/ClaudeMon.ts (lines 155-451)
  - Head: SphereGeometry, visor: PlaneGeometry, eyes: ShapeGeometry
  - Body: CylinderGeometry, arms/legs: CylinderGeometry + SphereGeometry
  - Antenna: CylinderGeometry + SphereGeometry tip
  - Status ring, glow accents, thought bubbles
- **Character (Claude)**: Simpler version in src/entities/Claude.ts (lines 92-190)
  - Body: CapsuleGeometry, head: SphereGeometry, eyes: SphereGeometry, arms: CapsuleGeometry
- **Stations**: 8 types in src/scene/stations/ directory
  - BookshelfStation, DeskStation, WorkbenchStation, TerminalStation
  - ScannerStation, AntennaStation, PortalStation, TaskboardStation

## Architecture for Custom Models

The project already has a swappable character interface:

```typescript
// src/entities/ICharacter.ts
export interface ICharacter {
  readonly mesh: THREE.Group;
  state: CharacterState;            // "idle" | "walking" | "working" | "thinking"
  currentStation: StationType;
  readonly id: string;
  moveTo(station: StationType): void;
  moveToPosition(position: THREE.Vector3, station: StationType): void;
  setState(state: CharacterState): void;
  shiftTargetPosition(delta: THREE.Vector3): void;
  dispose(): void;
}

export type CharacterModel = "claude" | "claudemon";
```

Any new character model just needs to implement this interface.

## Implementation Steps

### 1. Add GLTFLoader (no extra npm dependency)

Three.js includes GLTFLoader in its addons. Import it:

```typescript
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// Optional: for compressed models
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
```

### 2. Create Asset Directory

```
public/
  models/
    characters/
      custom-robot.glb
      custom-robot-idle.glb     # Optional: separate animation files
    stations/
      custom-terminal.glb
```

Place .glb/.gltf files in public/models/. Vite serves them as static assets.

### 3. Create Model Loader Utility

```typescript
// src/utils/ModelLoader.ts
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

const loader = new GLTFLoader();
const modelCache = new Map<string, THREE.Group>();

export async function loadModel(path: string): Promise<THREE.Group> {
  const cached = modelCache.get(path);
  if (cached) return cached.clone();

  return new Promise((resolve, reject) => {
    loader.load(
      path,
      (gltf) => {
        modelCache.set(path, gltf.scene);
        resolve(gltf.scene.clone());
      },
      undefined,
      reject,
    );
  });
}
```

### 4. Create Custom Character Class

```typescript
// src/entities/CustomCharacter.ts
import * as THREE from "three";
import type { ICharacter, CharacterState, CharacterOptions } from "./ICharacter";
import type { StationType } from "../../shared/types";
import type { WorkshopScene } from "../scene/WorkshopScene";
import { loadModel } from "../utils/ModelLoader";

export class CustomCharacter implements ICharacter {
  public readonly mesh: THREE.Group;
  public state: CharacterState = "idle";
  public currentStation: StationType = "center";
  public readonly id: string;

  private scene: WorkshopScene;
  private targetPosition: THREE.Vector3 | null = null;
  private moveSpeed = 5;
  private mixer: THREE.AnimationMixer | null = null;  // For bone animations
  private animations: Map<string, THREE.AnimationAction> = new Map();

  constructor(scene: WorkshopScene, options: CharacterOptions = {}) {
    this.scene = scene;
    this.id = Math.random().toString(36).substring(2, 9);
    this.mesh = new THREE.Group();

    // Position at start station
    this.currentStation = options.startStation || "center";
    const startStation = scene.stations.get(this.currentStation);
    if (startStation) {
      this.mesh.position.copy(startStation.position);
    }

    scene.scene.add(this.mesh);
  }

  // Call this after construction to load the model asynchronously
  async loadModel(modelPath: string): Promise<void> {
    const model = await loadModel(modelPath);
    this.mesh.add(model);

    // If the model has animations, set up AnimationMixer
    // (animations come from the GLTF file)
    this.mixer = new THREE.AnimationMixer(model);
  }

  moveTo(station: StationType): void {
    const targetStation = this.scene.stations.get(station);
    if (!targetStation) return;
    this.targetPosition = targetStation.position.clone();
    this.currentStation = station;
    this.state = "walking";
  }

  moveToPosition(position: THREE.Vector3, station: StationType): void {
    this.targetPosition = position.clone();
    this.currentStation = station;
    this.state = "walking";
  }

  shiftTargetPosition(delta: THREE.Vector3): void {
    if (this.targetPosition) {
      this.targetPosition.add(delta);
    }
  }

  setState(state: CharacterState): void {
    this.state = state;
    // Switch animations based on state
    // e.g., play "idle" clip, "walking" clip, etc.
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mixer?.stopAllAction();
  }
}
```

### 5. Animation Adaptation

Current procedural animations directly manipulate mesh transforms:
- Walking: bob body, swing arms, move feet (ClaudeMon.ts lines 628-695)
- Idle: gentle breathing, antenna wobble (ClaudeMon.ts lines 698-780)
- Working: typing motion, head nod (via WorkingBehaviorManager)

For custom GLTF models, two approaches:

**Option A: Bone-based animations (recommended for complex models)**
- Export animations from Blender/Mixamo baked into the .glb file
- Use THREE.AnimationMixer to play clips by name
- Map character states to animation clip names

**Option B: Programmatic animation (simpler models)**
- Name specific parts in Blender (e.g., "Head", "LeftArm")
- Find them with model.getObjectByName("Head")
- Apply the same procedural animation code

### 6. Register the New Model Type

Update ICharacter.ts:
```typescript
export type CharacterModel = "claude" | "claudemon" | "custom";
```

Update the character creation logic in main.ts to support the new model type.

## Recommended 3D Model Sources

- **Mixamo** (mixamo.com): Free rigged/animated humanoid characters
- **Sketchfab**: Many free CC-licensed models in .glb format
- **Ready Player Me**: Customizable avatar system
- **Blender**: Create custom models and export as .glb

## Model Requirements

- Format: .glb (binary GLTF, single file, best for web)
- Size: Keep under 2MB for fast loading
- Polycount: < 10k triangles for smooth performance with multiple characters
- Scale: Adjust in Blender or via mesh.scale in code (current characters are ~1 unit tall)
- Origin: Set model origin at the base (feet) for correct ground placement
