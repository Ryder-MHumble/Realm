/**
 * SoundManager - Synthesized sound effects for Vibecraft
 *
 * Uses Tone.js to generate all sounds programmatically.
 * No audio files needed - pure Web Audio synthesis.
 *
 * Sound Design: "Digital" theme
 * - Clean synth tones
 * - Quick, responsive feedback
 * - Non-intrusive during coding sessions
 *
 * Architecture:
 * - Synth pooling to reduce GC pressure
 * - Automatic disposal after sounds complete
 * - Normalized volume levels for consistency
 * - Spatial audio support for positional sounds
 */

import * as Tone from "tone";
import {
  spatialAudioContext,
  type SpatialSource,
  type SpatialMode,
} from "./SpatialAudioContext";

// ============================================
// Volume Levels (dB)
// ============================================
// Use these constants for consistent loudness across sounds
const VOL = {
  QUIET: -20, // Background/ambient sounds
  SOFT: -16, // Subtle feedback (walking, typing)
  NORMAL: -12, // Standard UI feedback
  PROMINENT: -10, // Important events (success, notifications)
  LOUD: -8, // Major events (zone create, errors)
} as const;

export type SoundName =
  // Tools
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "glob"
  | "webfetch"
  | "websearch"
  | "task"
  | "todo"
  // Special commands
  | "git_commit"
  // Draw mode
  | "clear"
  // Tool states
  | "success"
  | "error"
  // Movement
  | "walking"
  // Camera/workspace
  | "focus"
  // UI interactions
  | "click"
  | "modal_open"
  | "modal_cancel"
  | "modal_confirm"
  | "hover" // Subtle tick for hex grid hover
  // Subagents
  | "spawn"
  | "despawn"
  // Zones
  | "zone_create"
  | "zone_delete"
  // Session events
  | "prompt"
  | "stop"
  | "notification"
  | "thinking"
  // Voice input
  | "voice_start"
  | "voice_stop"
  // App startup
  | "intro";

// Map tool names to sound names (handles aliases)
const TOOL_SOUND_MAP: Record<string, SoundName> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob", // shares grep sound
  WebFetch: "webfetch",
  WebSearch: "websearch", // shares webfetch sound
  Task: "task",
  TodoWrite: "todo",
  NotebookEdit: "write", // shares write sound
  AskUserQuestion: "notification", // uses notification sound
};

// Spatial mode for each sound
// 'positional' = affected by distance/pan from camera
// 'global' = always centered, full volume (celebrations, system sounds)
const SOUND_SPATIAL_MODE: Record<SoundName, SpatialMode> = {
  // Tools - positional (zone-specific activity)
  read: "positional",
  write: "positional",
  edit: "positional",
  bash: "positional",
  grep: "positional",
  glob: "positional",
  webfetch: "positional",
  websearch: "positional",
  task: "positional",
  todo: "positional",

  // Special commands - global (want full impact)
  git_commit: "global",

  // Draw mode - global (user is directly interacting)
  clear: "global",

  // Tool states - positional (result of zone activity)
  success: "positional",
  error: "positional",

  // Movement - positional (zone character)
  walking: "positional",

  // Camera/workspace - global (user action)
  focus: "global",

  // UI interactions - global (direct user interaction)
  click: "global",
  modal_open: "global",
  modal_cancel: "global",
  modal_confirm: "global",
  hover: "global",

  // Subagents - positional (zone spawns)
  spawn: "positional",
  despawn: "positional",

  // Zones - positional (zone-specific events)
  zone_create: "positional",
  zone_delete: "positional",

  // Session events - positional (zone-specific)
  prompt: "positional",
  stop: "positional",
  thinking: "positional",

  // Notification - global (system-level alert)
  notification: "global",

  // Voice input - global (user action)
  voice_start: "global",
  voice_stop: "global",

  // App startup - global
  intro: "global",
};

// Options for playing a sound with spatial positioning
export interface SoundPlayOptions extends SpatialSource {
  // zoneId?: string      // inherited from SpatialSource
  // position?: Position2D // inherited from SpatialSource
}

// Synth configuration types
type OscType = "sine" | "square" | "triangle" | "sawtooth";

interface SynthConfig {
  type: OscType;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

class SoundManager {
  private initialized = false;
  private enabled = true;
  private volume = 0.7; // 0-1 (maps to master gain)

  // Synth pools by oscillator type (reduces GC)
  private synthPools: Map<OscType, Tone.Synth[]> = new Map([
    ["sine", []],
    ["square", []],
    ["triangle", []],
    ["sawtooth", []],
  ]);

  // Track active synths for cleanup
  private activeSynths: Set<Tone.Synth | Tone.FMSynth | Tone.PolySynth> =
    new Set();

  // Pool size limits
  private readonly MAX_POOL_SIZE = 5;

  // Current spatial params (applied to next sound)
  private currentSpatialVolume = 1;

  /**
   * Initialize audio context. Must be called from a user gesture (click/keypress).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await Tone.start();
    Tone.Destination.volume.value = Tone.gainToDb(this.volume);

    // Initialize spatial audio
    spatialAudioContext.init();

    this.initialized = true;
    console.log("[SoundManager] Audio initialized (with spatial support)");
  }

  /**
   * Check if audio is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Enable/disable all sounds
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if sounds are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set master volume (0-1)
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.initialized) {
      Tone.Destination.volume.value = Tone.gainToDb(this.volume);
    }
  }

  /**
   * Get current volume (0-1)
   */
  getVolume(): number {
    return this.volume;
  }

  // ============================================
  // Spatial Audio Configuration
  // ============================================

  /**
   * Set the zone position resolver for spatial audio
   */
  setZonePositionResolver(
    resolver: (zoneId: string) => { x: number; z: number } | null,
  ): void {
    spatialAudioContext.setZonePositionResolver(resolver);
  }

  /**
   * Set the focused zone resolver for spatial audio
   */
  setFocusedZoneResolver(resolver: () => string | null): void {
    spatialAudioContext.setFocusedZoneResolver(resolver);
  }

  /**
   * Update the listener position for spatial audio (call from camera updates)
   */
  updateListener(x: number, z: number, rotation: number): void {
    spatialAudioContext.updateListener(x, z, rotation);
  }

  /**
   * Enable/disable spatial audio
   */
  setSpatialEnabled(enabled: boolean): void {
    spatialAudioContext.setEnabled(enabled);
  }

  /**
   * Check if spatial audio is enabled
   */
  isSpatialEnabled(): boolean {
    return spatialAudioContext.isEnabled();
  }

  // ============================================
  // Sound Playback
  // ============================================

  /**
   * Play a sound by name with optional spatial positioning
   * @param name - The sound to play
   * @param options - Optional spatial source (zoneId or position)
   */
  play(name: SoundName, options?: SoundPlayOptions): void {
    if (!this.initialized || !this.enabled) return;

    const soundFn = this.sounds[name];
    if (!soundFn) {
      console.warn(`[SoundManager] Unknown sound: ${name}`);
      return;
    }

    // Determine spatial mode for this sound
    const spatialMode = SOUND_SPATIAL_MODE[name] || "global";

    // Calculate spatial params if positional and source provided
    if (
      spatialMode === "positional" &&
      options &&
      (options.zoneId || options.position)
    ) {
      const params = spatialAudioContext.applyToSound(options);
      this.currentSpatialVolume = params.volume;
    } else {
      // Global sound or no source - reset to center, full volume
      spatialAudioContext.resetPanner();
      this.currentSpatialVolume = 1;
    }

    // Play the sound
    soundFn();

    // Reset for next sound
    this.currentSpatialVolume = 1;
  }

  /**
   * Play sound for a tool by tool name (e.g., "Read", "Bash")
   * @param toolName - The tool name
   * @param options - Optional spatial source
   */
  playTool(toolName: string, options?: SoundPlayOptions): void {
    const soundName = TOOL_SOUND_MAP[toolName];
    if (soundName) {
      this.play(soundName, options);
    }
    // Unknown tools play no sound (silent fallback)
  }

  /**
   * Play success or error based on result
   * @param success - Whether the operation succeeded
   * @param options - Optional spatial source
   */
  playResult(success: boolean, options?: SoundPlayOptions): void {
    this.play(success ? "success" : "error", options);
  }

  /**
   * Play hover sound with pitch based on distance from center
   * @param normalizedDistance - 0 = center, 1 = edge (will be clamped)
   *
   * Tuning constants (easy to adjust):
   * - BASE_NOTE: Starting pitch at center (in MIDI note number, C5 = 72)
   * - SEMITONE_RANGE: How many semitones to add at max distance
   */
  playHover(normalizedDistance: number): void {
    if (!this.initialized || !this.enabled) return;

    // === TUNING CONSTANTS ===
    const BASE_NOTE = 72; // C5 in MIDI (center pitch)
    const SEMITONE_RANGE = 12; // One octave higher at max distance

    // Clamp to 0-1 range
    const t = Math.max(0, Math.min(1, normalizedDistance));

    // Calculate pitch: base + (distance * range)
    const midiNote = BASE_NOTE + t * SEMITONE_RANGE;
    const frequency = 440 * Math.pow(2, (midiNote - 69) / 12); // A4 = 440Hz = MIDI 69

    // Crystalline tick: triangle wave with slightly longer decay for a soft "tink" feel
    const synth = this.getSynth({
      type: "triangle",
      attack: 0.001,
      decay: 0.06,
      sustain: 0,
      release: 0.04,
    });
    synth.volume.value = VOL.QUIET; // Audible but not intrusive (-20dB)
    synth.triggerAttackRelease(frequency, "32n");
    this.releaseSynth(synth, 120);
  }

  /**
   * Play zone hover sound — warmer chime when entering a zone area.
   * Uses a sine wave with a softer attack than hex hover for a gentler feel.
   */
  playZoneHover(): void {
    if (!this.initialized || !this.enabled) return;

    const synth = this.getSynth({
      type: "sine",
      attack: 0.005,
      decay: 0.1,
      sustain: 0,
      release: 0.06,
    });
    synth.volume.value = VOL.QUIET;
    synth.triggerAttackRelease("E5", "32n");
    this.releaseSynth(synth, 180);
  }

  /**
   * Play slider tick sound with pitch based on value
   * @param normalizedValue - 0 = low pitch, 1 = high pitch
   */
  playSliderTick(normalizedValue: number): void {
    if (!this.initialized || !this.enabled) return;

    // === TUNING CONSTANTS ===
    const BASE_NOTE = 60; // C4 in MIDI (low pitch at 0%)
    const SEMITONE_RANGE = 24; // Two octaves higher at 100%

    // Clamp to 0-1 range
    const t = Math.max(0, Math.min(1, normalizedValue));

    // Calculate pitch: base + (value * range)
    const midiNote = BASE_NOTE + t * SEMITONE_RANGE;
    const frequency = 440 * Math.pow(2, (midiNote - 69) / 12); // A4 = 440Hz = MIDI 69

    const synth = this.getSynth({
      type: "triangle",
      attack: 0.001,
      decay: 0.05,
      sustain: 0,
      release: 0.03,
    });
    synth.volume.value = VOL.SOFT;
    synth.triggerAttackRelease(frequency, "32n");
    this.releaseSynth(synth, 100);
  }

  /**
   * Play a chord when selecting a draw mode color
   * Each color has its own characteristic chord
   * @param colorIndex - 0-5 for colors, -1 for eraser
   */
  playColorSelect(colorIndex: number): void {
    if (!this.initialized || !this.enabled) return;

    // Color chords - cool, crystalline feel to match the cool color palette
    // Each chord is an array of frequencies
    const COLOR_CHORDS: number[][] = [
      [523.25, 659.25, 783.99], // 0: Cyan - C5 major (C5, E5, G5)
      [493.88, 622.25, 739.99], // 1: Sky - B4 major (B4, D#5, F#5)
      [440.0, 554.37, 659.25], // 2: Blue - A4 major (A4, C#5, E5)
      [392.0, 493.88, 587.33], // 3: Indigo - G4 major (G4, B4, D5)
      [349.23, 440.0, 523.25], // 4: Purple - F4 major (F4, A4, C5)
      [329.63, 415.3, 493.88], // 5: Teal - E4 major (E4, G#4, B4)
    ];

    // Eraser gets a soft descending tone
    if (colorIndex < 0 || colorIndex >= COLOR_CHORDS.length) {
      const synth = this.getSynth({
        type: "triangle",
        attack: 0.01,
        decay: 0.15,
        sustain: 0,
        release: 0.1,
      });
      synth.volume.value = VOL.SOFT;
      synth.triggerAttackRelease(349.23, "16n");
      this.releaseSynth(synth, 200);
      return;
    }

    const chord = COLOR_CHORDS[colorIndex];
    const synth = this.createDisposablePolySynth(
      { type: "sine", attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.3 },
      VOL.SOFT,
      800,
    );
    synth.triggerAttackRelease(chord, "8n");
  }

  /**
   * Get the output node (panner if available, otherwise destination)
   * This routes audio through spatial processing
   */
  private getOutputNode(): Tone.ToneAudioNode {
    const panner = spatialAudioContext.getPanner();
    return panner || Tone.Destination;
  }

  /**
   * Apply spatial volume to a dB value
   */
  private applySpatialVolume(volumeDb: number): number {
    // Convert spatial multiplier (0.3-1.0) to dB adjustment
    // At 1.0 = no change, at 0.3 = about -10dB
    const spatialDb = Tone.gainToDb(this.currentSpatialVolume);
    return volumeDb + spatialDb;
  }

  /**
   * Get a synth from pool or create new one
   */
  private getSynth(config: SynthConfig): Tone.Synth {
    const pool = this.synthPools.get(config.type)!;
    let synth = pool.pop();
    const output = this.getOutputNode();

    if (!synth) {
      synth = new Tone.Synth({
        oscillator: { type: config.type },
        envelope: {
          attack: config.attack,
          decay: config.decay,
          sustain: config.sustain,
          release: config.release,
        },
      });
      synth.connect(output);
    } else {
      // Reconfigure existing synth
      synth.oscillator.type = config.type;
      synth.envelope.attack = config.attack;
      synth.envelope.decay = config.decay;
      synth.envelope.sustain = config.sustain;
      synth.envelope.release = config.release;
      // Reconnect in case output changed
      synth.disconnect();
      synth.connect(output);
    }

    this.activeSynths.add(synth);
    return synth;
  }

  /**
   * Return synth to pool after use (with delay for sound to finish)
   */
  private releaseSynth(synth: Tone.Synth, delayMs: number = 500): void {
    setTimeout(() => {
      this.activeSynths.delete(synth);
      const type = synth.oscillator.type as OscType;
      const pool = this.synthPools.get(type);
      if (pool && pool.length < this.MAX_POOL_SIZE) {
        pool.push(synth);
      } else {
        // Pool full, dispose
        synth.dispose();
      }
    }, delayMs);
  }

  /**
   * Create and auto-dispose a one-shot synth (for complex sounds)
   */
  private createDisposableSynth(
    config: SynthConfig,
    volume: number,
  ): Tone.Synth {
    const output = this.getOutputNode();
    const synth = new Tone.Synth({
      oscillator: { type: config.type },
      envelope: {
        attack: config.attack,
        decay: config.decay,
        sustain: config.sustain,
        release: config.release,
      },
    });
    synth.connect(output);
    synth.volume.value = this.applySpatialVolume(volume);
    this.activeSynths.add(synth);

    // Auto-dispose after envelope completes
    const totalTime =
      (config.attack + config.decay + config.release) * 1000 + 200;
    setTimeout(() => {
      this.activeSynths.delete(synth);
      synth.dispose();
    }, totalTime);

    return synth;
  }

  /**
   * Create and auto-dispose an FM synth
   */
  private createDisposableFMSynth(
    volume: number,
    disposeAfterMs: number,
  ): Tone.FMSynth {
    const output = this.getOutputNode();
    const synth = new Tone.FMSynth({
      modulationIndex: 5,
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 0.4 },
    });
    synth.connect(output);
    synth.volume.value = this.applySpatialVolume(volume);
    this.activeSynths.add(synth);

    setTimeout(() => {
      this.activeSynths.delete(synth);
      synth.dispose();
    }, disposeAfterMs);

    return synth;
  }

  /**
   * Create and auto-dispose a poly synth
   */
  private createDisposablePolySynth(
    config: SynthConfig,
    volume: number,
    disposeAfterMs: number,
  ): Tone.PolySynth {
    const output = this.getOutputNode();
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: config.type },
      envelope: {
        attack: config.attack,
        decay: config.decay,
        sustain: config.sustain,
        release: config.release,
      },
    });
    synth.connect(output);
    synth.volume.value = this.applySpatialVolume(volume);
    this.activeSynths.add(synth);

    setTimeout(() => {
      this.activeSynths.delete(synth);
      synth.dispose();
    }, disposeAfterMs);

    return synth;
  }

  /**
   * Dispose all active synths (cleanup)
   */
  dispose(): void {
    for (const synth of this.activeSynths) {
      synth.dispose();
    }
    this.activeSynths.clear();

    for (const pool of this.synthPools.values()) {
      for (const synth of pool) {
        synth.dispose();
      }
      pool.length = 0;
    }
  }

  // ============================================
  // Sound Definitions
  // ============================================

  private sounds: Record<SoundName, () => void> = {
    // === TOOLS ===

    read: () => {
      // Page turn - two soft tones
      const synth = this.getSynth({
        type: "sine",
        attack: 0.005,
        decay: 0.1,
        sustain: 0,
        release: 0.1,
      });
      synth.volume.value = this.applySpatialVolume(VOL.NORMAL);
      synth.triggerAttackRelease("A4", "32n");
      setTimeout(() => synth.triggerAttackRelease("C5", "32n"), 50);
      this.releaseSynth(synth, 300);
    },

    write: () => {
      // Keyboard typing - quick triple blip
      const synth = this.getSynth({
        type: "square",
        attack: 0.001,
        decay: 0.05,
        sustain: 0,
        release: 0.05,
      });
      synth.volume.value = this.applySpatialVolume(VOL.QUIET);
      synth.triggerAttackRelease("E5", "64n");
      setTimeout(() => synth.triggerAttackRelease("E5", "64n"), 40);
      setTimeout(() => synth.triggerAttackRelease("G5", "64n"), 80);
      this.releaseSynth(synth, 300);
    },

    edit: () => {
      // Pencil scratch - two quick taps
      const synth = this.getSynth({
        type: "triangle",
        attack: 0.001,
        decay: 0.06,
        sustain: 0,
        release: 0.04,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("E4", "32n");
      setTimeout(() => synth.triggerAttackRelease("G4", "32n"), 60);
      this.releaseSynth(synth, 250);
    },

    bash: () => {
      // DataBurst - rapid blips like data transmission
      const synth = this.getSynth({
        type: "sawtooth",
        attack: 0.001,
        decay: 0.02,
        sustain: 0,
        release: 0.02,
      });
      synth.volume.value = this.applySpatialVolume(VOL.SOFT);
      for (let i = 0; i < 5; i++) {
        setTimeout(() => synth.triggerAttackRelease("C5", "64n"), i * 25);
      }
      this.releaseSynth(synth, 300);
    },

    grep: () => {
      // Scanning/searching - sweep with "found it" blip
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.01, decay: 0.15, sustain: 0, release: 0.1 },
        VOL.NORMAL,
      );
      synth.triggerAttackRelease("E4", "16n");
      synth.frequency.rampTo("A4", 0.12);

      // Secondary "found it" blip
      const blip = this.createDisposableSynth(
        {
          type: "triangle",
          attack: 0.005,
          decay: 0.06,
          sustain: 0,
          release: 0.05,
        },
        VOL.SOFT,
      );
      setTimeout(() => blip.triggerAttackRelease("C5", "32n"), 130);
    },

    glob: () => {
      // Alias for grep - same searching sound
      this.sounds.grep();
    },

    webfetch: () => {
      // Network request - ascending arpeggio
      const synth = this.getSynth({
        type: "sine",
        attack: 0.001,
        decay: 0.03,
        sustain: 0,
        release: 0.02,
      });
      synth.volume.value = this.applySpatialVolume(VOL.NORMAL);
      const notes = ["C5", "E5", "G5", "C6"];
      notes.forEach((note, i) => {
        setTimeout(() => synth.triggerAttackRelease(note, "64n"), i * 40);
      });
      this.releaseSynth(synth, 400);
    },

    websearch: () => {
      // Alias for webfetch
      this.sounds.webfetch();
    },

    task: () => {
      // Subagent launch - FM sweep upward
      const synth = this.createDisposableFMSynth(VOL.PROMINENT, 1000);
      synth.triggerAttackRelease("C3", "4n");
      synth.frequency.rampTo("C4", 0.3);
    },

    todo: () => {
      // Checklist update - triple checkbox tick
      const synth = this.getSynth({
        type: "square",
        attack: 0.003,
        decay: 0.06,
        sustain: 0,
        release: 0.04,
      });
      synth.volume.value = this.applySpatialVolume(VOL.SOFT);
      synth.triggerAttackRelease("E4", "32n");
      setTimeout(() => synth.triggerAttackRelease("E4", "32n"), 70);
      setTimeout(() => synth.triggerAttackRelease("G4", "32n"), 140);
      this.releaseSynth(synth, 350);
    },

    // === SPECIAL COMMANDS ===

    git_commit: () => {
      // Git commit - satisfying "saved" fanfare with harmonic resolution
      // Major chord arpeggio ascending then resolving (G→B→D→G)
      const synth = this.createDisposablePolySynth(
        {
          type: "triangle",
          attack: 0.02,
          decay: 0.25,
          sustain: 0.15,
          release: 0.4,
        },
        VOL.PROMINENT,
        1200,
      );
      const now = Tone.now();
      synth.triggerAttackRelease("G3", "8n", now);
      synth.triggerAttackRelease("B3", "8n", now + 0.08);
      synth.triggerAttackRelease("D4", "8n", now + 0.16);
      synth.triggerAttackRelease("G4", "4n", now + 0.24); // Hold the resolution

      // Subtle shimmer on top
      const shimmer = this.createDisposableSynth(
        { type: "sine", attack: 0.1, decay: 0.3, sustain: 0, release: 0.3 },
        VOL.QUIET,
      );
      setTimeout(() => shimmer.triggerAttackRelease("D5", "8n"), 300);
    },

    // === DRAW MODE ===

    clear: () => {
      // Descending sweep - satisfying "wipe" sound
      const synth = this.createDisposablePolySynth(
        {
          type: "triangle",
          attack: 0.01,
          decay: 0.2,
          sustain: 0,
          release: 0.3,
        },
        VOL.NORMAL,
        800,
      );
      const now = Tone.now();
      synth.triggerAttackRelease("G4", "16n", now);
      synth.triggerAttackRelease("E4", "16n", now + 0.06);
      synth.triggerAttackRelease("C4", "16n", now + 0.12);
    },

    // === TOOL STATES ===

    success: () => {
      // Positive resolution - rising fifth
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.01, decay: 0.15, sustain: 0, release: 0.2 },
        VOL.LOUD,
      );
      synth.triggerAttackRelease("C5", "16n");
      setTimeout(() => synth.triggerAttackRelease("G5", "8n"), 100);
    },

    error: () => {
      // Negative/warning - descending buzz
      const synth = this.createDisposableSynth(
        {
          type: "sawtooth",
          attack: 0.01,
          decay: 0.15,
          sustain: 0,
          release: 0.15,
        },
        VOL.PROMINENT,
      );
      synth.triggerAttackRelease("A2", "8n");
      synth.frequency.rampTo("F2", 0.1);
    },

    // === MOVEMENT ===

    walking: () => {
      // Soft footsteps - double tap
      const synth = this.getSynth({
        type: "sine",
        attack: 0.001,
        decay: 0.03,
        sustain: 0,
        release: 0.02,
      });
      synth.volume.value = this.applySpatialVolume(VOL.QUIET);
      synth.triggerAttackRelease("D4", "64n");
      setTimeout(() => synth.triggerAttackRelease("D4", "64n"), 180);
      this.releaseSynth(synth, 400);
    },

    // === CAMERA/WORKSPACE ===

    focus: () => {
      // Quick whoosh/zoom - workspace transition
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.01, decay: 0.12, sustain: 0, release: 0.08 },
        VOL.NORMAL,
      );
      synth.triggerAttackRelease("E4", "16n");
      synth.frequency.exponentialRampTo("A4", 0.08);
    },

    // === UI INTERACTIONS ===

    click: () => {
      // Soft pop/tap - floor interaction
      const synth = this.getSynth({
        type: "sine",
        attack: 0.001,
        decay: 0.08,
        sustain: 0,
        release: 0.06,
      });
      synth.volume.value = this.applySpatialVolume(VOL.NORMAL);
      synth.triggerAttackRelease("G4", "32n");

      // Subtle harmonic
      const harm = this.createDisposableSynth(
        {
          type: "triangle",
          attack: 0.001,
          decay: 0.05,
          sustain: 0,
          release: 0.04,
        },
        VOL.QUIET,
      );
      setTimeout(() => harm.triggerAttackRelease("D5", "64n"), 20);
      this.releaseSynth(synth, 200);
    },

    modal_open: () => {
      // Soft whoosh up - modal appearing
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.02, decay: 0.15, sustain: 0, release: 0.1 },
        VOL.NORMAL,
      );
      synth.triggerAttackRelease("C4", "16n");
      synth.frequency.exponentialRampTo("E4", 0.1);

      // Soft chime
      const chime = this.createDisposableSynth(
        {
          type: "triangle",
          attack: 0.005,
          decay: 0.1,
          sustain: 0,
          release: 0.08,
        },
        VOL.SOFT,
      );
      setTimeout(() => chime.triggerAttackRelease("G4", "32n"), 80);
    },

    modal_cancel: () => {
      // Soft descending tone - dismissal
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.01, decay: 0.12, sustain: 0, release: 0.08 },
        VOL.NORMAL,
      );
      synth.triggerAttackRelease("E4", "16n");
      synth.frequency.exponentialRampTo("C4", 0.08);
    },

    modal_confirm: () => {
      // Positive confirmation - ascending triad
      const synth = this.getSynth({
        type: "sine",
        attack: 0.01,
        decay: 0.1,
        sustain: 0.05,
        release: 0.15,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("E4", "16n");
      setTimeout(() => synth.triggerAttackRelease("G4", "16n"), 60);
      setTimeout(() => synth.triggerAttackRelease("C5", "8n"), 120);
      this.releaseSynth(synth, 500);
    },

    hover: () => {
      // Default hover - use playHover() for distance-based pitch
      this.playHover(0);
    },

    // === SUBAGENTS ===

    spawn: () => {
      // Ethereal rise - ascending sweep
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.02, decay: 0.2, sustain: 0, release: 0.2 },
        VOL.LOUD,
      );
      synth.triggerAttackRelease("C4", "16n");
      synth.frequency.exponentialRampTo("G5", 0.15);
    },

    despawn: () => {
      // Ethereal vanish - descending sweep
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.01, decay: 0.25, sustain: 0, release: 0.2 },
        VOL.PROMINENT,
      );
      synth.triggerAttackRelease("G4", "16n");
      synth.frequency.exponentialRampTo("C3", 0.2);
    },

    // === ZONES ===

    zone_create: () => {
      // Grand expansion - rising staggered chord
      const synth = this.createDisposablePolySynth(
        { type: "sine", attack: 0.05, decay: 0.4, sustain: 0.1, release: 0.3 },
        VOL.LOUD,
        1000,
      );
      const now = Tone.now();
      synth.triggerAttackRelease("C4", "8n", now);
      synth.triggerAttackRelease("E4", "8n", now + 0.05);
      synth.triggerAttackRelease("G4", "8n", now + 0.1);
      synth.triggerAttackRelease("C5", "8n", now + 0.15);
    },

    zone_delete: () => {
      // Collapse/fade - descending minor
      const synth = this.createDisposablePolySynth(
        {
          type: "triangle",
          attack: 0.01,
          decay: 0.3,
          sustain: 0,
          release: 0.4,
        },
        VOL.PROMINENT,
        800,
      );
      const now = Tone.now();
      synth.triggerAttackRelease("G4", "16n", now);
      synth.triggerAttackRelease("Eb4", "16n", now + 0.08);
      synth.triggerAttackRelease("C4", "16n", now + 0.16);
      synth.triggerAttackRelease("G3", "8n", now + 0.24);
    },

    // === SESSION EVENTS ===

    prompt: () => {
      // User submitted - gentle acknowledgment
      const synth = this.getSynth({
        type: "sine",
        attack: 0.01,
        decay: 0.1,
        sustain: 0,
        release: 0.1,
      });
      synth.volume.value = this.applySpatialVolume(VOL.NORMAL);
      synth.triggerAttackRelease("G4", "32n");
      setTimeout(() => synth.triggerAttackRelease("D5", "32n"), 60);
      this.releaseSynth(synth, 300);
    },

    stop: () => {
      // Claude finished - satisfying completion chord
      const synth = this.getSynth({
        type: "sine",
        attack: 0.01,
        decay: 0.2,
        sustain: 0,
        release: 0.25,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("E4", "16n");
      setTimeout(() => synth.triggerAttackRelease("G4", "16n"), 80);
      setTimeout(() => synth.triggerAttackRelease("C5", "8n"), 160);
      this.releaseSynth(synth, 600);
    },

    notification: () => {
      // Attention ping - double tap
      const synth = this.getSynth({
        type: "triangle",
        attack: 0.005,
        decay: 0.12,
        sustain: 0,
        release: 0.1,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("A4", "16n");
      setTimeout(() => synth.triggerAttackRelease("A4", "16n"), 120);
      this.releaseSynth(synth, 400);
    },

    thinking: () => {
      // Claude processing - subtle ambient
      const synth = this.createDisposableSynth(
        { type: "sine", attack: 0.05, decay: 0.15, sustain: 0.1, release: 0.2 },
        VOL.QUIET,
      );
      synth.triggerAttackRelease("D4", "8n");

      const synth2 = this.createDisposableSynth(
        { type: "sine", attack: 0.08, decay: 0.2, sustain: 0, release: 0.15 },
        VOL.QUIET - 2,
      );
      setTimeout(() => synth2.triggerAttackRelease("F4", "8n"), 100);
    },

    // === VOICE INPUT ===

    voice_start: () => {
      // Recording started - ascending ready beep
      const synth = this.getSynth({
        type: "sine",
        attack: 0.005,
        decay: 0.08,
        sustain: 0,
        release: 0.08,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("C5", "32n");
      setTimeout(() => synth.triggerAttackRelease("E5", "32n"), 60);
      this.releaseSynth(synth, 250);
    },

    voice_stop: () => {
      // Recording stopped - descending done beep
      const synth = this.getSynth({
        type: "sine",
        attack: 0.005,
        decay: 0.08,
        sustain: 0,
        release: 0.08,
      });
      synth.volume.value = this.applySpatialVolume(VOL.PROMINENT);
      synth.triggerAttackRelease("E5", "32n");
      setTimeout(() => synth.triggerAttackRelease("C5", "32n"), 60);
      this.releaseSynth(synth, 250);
    },

    // === APP STARTUP ===

    intro: () => {
      // Jazz welcome - Cmaj9 (Drop 2 voicing)
      // Relaxed, inviting bloom that says "time to build"
      const synth = this.createDisposablePolySynth(
        {
          type: "triangle",
          attack: 0.08,
          decay: 0.4,
          sustain: 0.3,
          release: 0.8,
        },
        VOL.PROMINENT,
        2000,
      );

      const now = Tone.now();

      // Cmaj9 (Drop 2): C3, B3, E4, G4, D5
      synth.triggerAttackRelease("C3", "2n", now);
      synth.triggerAttackRelease("B3", "2n", now + 0.05);
      synth.triggerAttackRelease("E4", "2n", now + 0.1);
      synth.triggerAttackRelease("G4", "2n", now + 0.15);
      synth.triggerAttackRelease("D5", "2n", now + 0.2);
    },
  };
}

// Export singleton instance
export const soundManager = new SoundManager();

// Also export the class for testing or multiple instances
export { SoundManager };
