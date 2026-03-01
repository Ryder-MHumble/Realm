/**
 * AttentionSystem - Manages notifications when sessions need user attention
 *
 * Tracks sessions that have transitioned from working → idle and notifies
 * the user via tab title, sounds, and browser notifications.
 */

import { soundManager } from '../audio/SoundManager'
import type { ManagedSession } from '../../shared/types'

export interface AttentionCallbacks {
  onQueueChange: (queue: string[]) => void  // Called when queue changes (for UI updates)
  onFocusSession?: (sessionId: string, claudeSessionId: string) => void  // Called to focus a session
}

export class AttentionSystem {
  private queue: string[] = []
  private previousStatus = new Map<string, string>()
  private callbacks: AttentionCallbacks
  private soundEnabled = true
  private notificationsEnabled = true

  constructor(callbacks: AttentionCallbacks) {
    this.callbacks = callbacks
  }

  /** Get current attention queue */
  getQueue(): string[] {
    return [...this.queue]
  }

  /** Check if a session needs attention */
  needsAttention(sessionId: string): boolean {
    return this.queue.includes(sessionId)
  }

  /** Get count of sessions needing attention */
  get count(): number {
    return this.queue.length
  }

  /** Enable/disable sounds */
  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled
  }

  /** Enable/disable browser notifications */
  setNotificationsEnabled(enabled: boolean): void {
    this.notificationsEnabled = enabled
  }

  /** Add a session to the attention queue */
  add(sessionId: string): void {
    if (!this.queue.includes(sessionId)) {
      this.queue.push(sessionId)
      this.updateTabTitle()
      this.callbacks.onQueueChange(this.getQueue())
    }
  }

  /** Remove a session from the attention queue */
  remove(sessionId: string): void {
    const index = this.queue.indexOf(sessionId)
    if (index !== -1) {
      this.queue.splice(index, 1)
      this.updateTabTitle()
      this.callbacks.onQueueChange(this.getQueue())
    }
  }

  /** Get next session needing attention (and remove from queue) */
  getNext(sessions: ManagedSession[]): ManagedSession | null {
    while (this.queue.length > 0) {
      const sessionId = this.queue[0]
      const session = sessions.find(s => s.id === sessionId)

      if (session) {
        this.remove(sessionId)
        return session
      }

      // Session no longer exists, remove and try next
      this.queue.shift()
    }

    return null
  }

  /**
   * Process session status changes - detect working ↔ idle transitions
   * - working → idle: adds to attention queue (user should check)
   * - * → working: removes from attention queue (user engaged)
   * Returns sessions that just became idle (for auto-focus logic)
   */
  processStatusChanges(sessions: ManagedSession[]): ManagedSession[] {
    const newlyIdle: ManagedSession[] = []

    for (const session of sessions) {
      const prevStatus = this.previousStatus.get(session.id)
      const currStatus = session.status

      // Detect working → idle transition (needs attention)
      if (prevStatus === 'working' && currStatus === 'idle') {
        this.add(session.id)
        this.playNotificationSound()
        this.showBrowserNotification(session.name)
        newlyIdle.push(session)
      }

      // Detect transition to working (clear attention - user engaged)
      if (prevStatus && prevStatus !== 'working' && currStatus === 'working') {
        this.remove(session.id)
      }

      // Update tracking
      this.previousStatus.set(session.id, currStatus)
    }

    // Clean up old entries
    const currentIds = new Set(sessions.map(s => s.id))
    for (const id of this.previousStatus.keys()) {
      if (!currentIds.has(id)) {
        this.previousStatus.delete(id)
      }
    }

    return newlyIdle
  }

  /** Update browser tab title with attention count */
  private updateTabTitle(): void {
    if (this.queue.length > 0) {
      document.title = `(${this.queue.length}) Realm`
    } else {
      document.title = 'Realm'
    }
  }

  /** Play a notification sound */
  private playNotificationSound(): void {
    if (!this.soundEnabled) return
    soundManager.play('notification')
  }

  /** Show a browser notification */
  private showBrowserNotification(sessionName: string): void {
    if (!this.notificationsEnabled) return
    if (!('Notification' in window)) return

    if (Notification.permission === 'granted') {
      new Notification('Realm', {
        body: `${sessionName} needs attention`,
        icon: '/favicon.ico',
        tag: 'realm-attention', // Prevents duplicate notifications
      })
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission()
    }
  }

  /** Request notification permission (call on user interaction) */
  static requestPermission(): void {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }
}
