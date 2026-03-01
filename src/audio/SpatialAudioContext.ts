/**
 * SpatialAudioContext - Manages 3D audio positioning for Realm
 *
 * Provides distance-based volume attenuation and stereo panning
 * based on sound source position relative to the camera/listener.
 *
 * Design principles:
 * - Always audible: distant sounds are quieter, never silent
 * - Subtle panning: ±0.7 max to avoid jarring hard left/right
 * - Focused zone boost: selected zone gets priority
 * - Optional: can be disabled entirely via settings
 */

import * as Tone from 'tone'

// Types for spatial positioning
export interface Position2D {
  x: number
  z: number
}

export interface ListenerState {
  position: Position2D
  rotation: number  // Y-axis rotation in radians (yaw)
}

export interface SpatialParams {
  volume: number   // 0.3 - 1.0 (multiplier, never silent)
  pan: number      // -0.7 to 0.7 (stereo position)
}

export interface SpatialSource {
  zoneId?: string
  position?: Position2D
}

// Spatial modes for sound definitions
export type SpatialMode = 'positional' | 'global'

// Configuration constants (easy to tune)
const SPATIAL_CONFIG = {
  // Volume falloff
  MIN_VOLUME: 0.3,           // Minimum volume at max distance
  DISTANCE_FACTOR: 0.025,    // How quickly volume falls off (lower = slower falloff)

  // Panning
  MAX_PAN: 0.7,              // Maximum left/right pan (1.0 = hard pan)

  // Focus boost
  FOCUS_BOOST: 1.25,         // Multiplier for focused zone (25% louder)
}

// Type for zone position resolver function
export type ZonePositionResolver = (zoneId: string) => Position2D | null
export type FocusedZoneResolver = () => string | null

class SpatialAudioContext {
  private enabled = true
  private listener: ListenerState = {
    position: { x: 0, z: 0 },
    rotation: 0,
  }

  // External resolvers (set by main app)
  private getZonePosition: ZonePositionResolver | null = null
  private getFocusedZoneId: FocusedZoneResolver | null = null

  // Panner node for stereo positioning (reused)
  private panner: Tone.Panner | null = null

  /**
   * Initialize the panner node
   * Must be called after Tone.start()
   */
  init(): void {
    if (this.panner) return
    this.panner = new Tone.Panner(0).toDestination()
  }

  /**
   * Set the zone position resolver function
   * This allows SpatialAudioContext to look up zone positions without
   * directly depending on WorkshopScene
   */
  setZonePositionResolver(resolver: ZonePositionResolver): void {
    this.getZonePosition = resolver
  }

  /**
   * Set the focused zone resolver function
   */
  setFocusedZoneResolver(resolver: FocusedZoneResolver): void {
    this.getFocusedZoneId = resolver
  }

  /**
   * Enable/disable spatial audio
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    // Reset panner when disabled
    if (!enabled && this.panner) {
      this.panner.pan.value = 0
    }
  }

  /**
   * Check if spatial audio is enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Update listener position from camera
   * @param x - Camera X position in world space
   * @param z - Camera Z position in world space
   * @param rotation - Camera Y rotation in radians (looking direction)
   */
  updateListener(x: number, z: number, rotation: number): void {
    this.listener.position.x = x
    this.listener.position.z = z
    this.listener.rotation = rotation
  }

  /**
   * Update listener from a Three.js camera
   */
  updateListenerFromCamera(camera: { position: { x: number; z: number }; rotation: { y: number } }): void {
    this.updateListener(
      camera.position.x,
      camera.position.z,
      camera.rotation.y
    )
  }

  /**
   * Get the panner node for routing audio through
   * Returns null if not initialized or disabled
   */
  getPanner(): Tone.Panner | null {
    return this.panner
  }

  /**
   * Resolve a spatial source to a position
   * Returns null if position cannot be determined
   */
  resolvePosition(source: SpatialSource): Position2D | null {
    // Explicit position takes priority
    if (source.position) {
      return source.position
    }

    // Try to resolve from zoneId
    if (source.zoneId && this.getZonePosition) {
      return this.getZonePosition(source.zoneId)
    }

    return null
  }

  /**
   * Calculate spatial parameters for a sound source
   * Returns default (centered, full volume) if spatial is disabled or position unknown
   */
  calculate(source: SpatialSource): SpatialParams {
    const defaultParams: SpatialParams = { volume: 1, pan: 0 }

    // Return defaults if disabled
    if (!this.enabled) {
      return defaultParams
    }

    // Resolve position
    const position = this.resolvePosition(source)
    if (!position) {
      return defaultParams
    }

    // Calculate distance
    const dx = position.x - this.listener.position.x
    const dz = position.z - this.listener.position.z
    const distance = Math.sqrt(dx * dx + dz * dz)

    // Volume: inverse falloff with minimum
    // Formula: 1 / (1 + distance * factor), clamped to MIN_VOLUME
    let volume = 1 / (1 + distance * SPATIAL_CONFIG.DISTANCE_FACTOR)
    volume = Math.max(SPATIAL_CONFIG.MIN_VOLUME, volume)

    // Apply focus boost if this is the focused zone
    if (source.zoneId && this.getFocusedZoneId) {
      const focusedId = this.getFocusedZoneId()
      if (focusedId === source.zoneId) {
        volume = Math.min(1, volume * SPATIAL_CONFIG.FOCUS_BOOST)
      }
    }

    // Pan: based on angle relative to listener facing direction
    // atan2 gives angle from listener to source
    // Subtract listener rotation to get relative angle
    const angleToSource = Math.atan2(dx, dz)
    const relativeAngle = angleToSource - this.listener.rotation

    // sin of relative angle gives left/right position
    // Normalize to -1 to 1 range, then clamp to MAX_PAN
    let pan = Math.sin(relativeAngle)
    pan = Math.max(-SPATIAL_CONFIG.MAX_PAN, Math.min(SPATIAL_CONFIG.MAX_PAN, pan))

    return { volume, pan }
  }

  /**
   * Apply spatial parameters to the panner
   * Call this just before playing a sound
   */
  applyToSound(source: SpatialSource): SpatialParams {
    const params = this.calculate(source)

    if (this.panner && this.enabled) {
      this.panner.pan.value = params.pan
    }

    return params
  }

  /**
   * Reset panner to center (for global sounds)
   */
  resetPanner(): void {
    if (this.panner) {
      this.panner.pan.value = 0
    }
  }

  /**
   * Get current listener state (for debugging)
   */
  getListenerState(): ListenerState {
    return { ...this.listener }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.panner) {
      this.panner.dispose()
      this.panner = null
    }
  }
}

// Export singleton instance
export const spatialAudioContext = new SpatialAudioContext()

// Also export class for testing
export { SpatialAudioContext }
