/**
 * KeybindConfig - Editable keyboard shortcuts configuration
 *
 * Manages user-customizable keybindings with localStorage persistence.
 * Only certain bindings are editable (focus, voice) - session keys are fixed.
 */

// ============================================================================
// Types
// ============================================================================

export interface Keybind {
  /** Key code (e.g., 'Tab', 'm', 'Escape') */
  key: string
  /** Modifier: ctrl, alt, shift, meta, or none */
  modifier: 'ctrl' | 'alt' | 'shift' | 'meta' | 'none'
}

export interface KeybindAction {
  /** Unique identifier for this action */
  id: string
  /** Human-readable name */
  name: string
  /** Description shown in settings */
  description: string
  /** Whether this keybind can be edited by users */
  editable: boolean
  /** Default keybindings (can have multiple) */
  defaults: Keybind[]
  /** Current keybindings (user-customized or defaults) */
  bindings: Keybind[]
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_KEYBIND_ACTIONS: KeybindAction[] = [
  {
    id: 'focus-toggle',
    name: 'Toggle Focus',
    description: 'Switch between Workshop (3D) and Activity Feed',
    editable: true,
    defaults: [
      { key: 'Tab', modifier: 'none' },
      { key: 'Escape', modifier: 'none' },
    ],
    bindings: [],
  },
  {
    id: 'voice-toggle',
    name: 'Voice Input',
    description: 'Start/stop voice recording',
    editable: true,
    defaults: [
      { key: 'm', modifier: 'ctrl' },
    ],
    bindings: [],
  },
]

// ============================================================================
// Storage
// ============================================================================

const STORAGE_KEY = 'realm-keybinds'

function loadFromStorage(): Record<string, Keybind[]> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.warn('Failed to load keybinds from localStorage:', e)
  }
  return {}
}

function saveToStorage(bindings: Record<string, Keybind[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
  } catch (e) {
    console.warn('Failed to save keybinds to localStorage:', e)
  }
}

// ============================================================================
// Keybind Manager
// ============================================================================

class KeybindManager {
  private actions: Map<string, KeybindAction> = new Map()
  private listeners: Set<() => void> = new Set()

  constructor() {
    this.loadDefaults()
    this.loadUserBindings()
  }

  private loadDefaults(): void {
    for (const action of DEFAULT_KEYBIND_ACTIONS) {
      this.actions.set(action.id, {
        ...action,
        bindings: [...action.defaults],
      })
    }
  }

  private loadUserBindings(): void {
    const stored = loadFromStorage()
    for (const [id, bindings] of Object.entries(stored)) {
      const action = this.actions.get(id)
      if (action && action.editable && bindings.length > 0) {
        action.bindings = bindings
      }
    }
  }

  /** Get all keybind actions */
  getActions(): KeybindAction[] {
    return Array.from(this.actions.values())
  }

  /** Get editable keybind actions only */
  getEditableActions(): KeybindAction[] {
    return this.getActions().filter(a => a.editable)
  }

  /** Get a specific action by ID */
  getAction(id: string): KeybindAction | undefined {
    return this.actions.get(id)
  }

  /** Get bindings for an action */
  getBindings(id: string): Keybind[] {
    return this.actions.get(id)?.bindings ?? []
  }

  /** Check if an event matches any binding for an action */
  matches(id: string, event: KeyboardEvent): boolean {
    const bindings = this.getBindings(id)
    return bindings.some(binding => this.eventMatchesBinding(event, binding))
  }

  /** Check if event matches a specific binding */
  private eventMatchesBinding(event: KeyboardEvent, binding: Keybind): boolean {
    // Check key (case-insensitive for letters)
    const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key

    if (eventKey !== bindingKey) return false

    // Check modifier
    switch (binding.modifier) {
      case 'ctrl':
        return event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
      case 'alt':
        return event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey
      case 'shift':
        return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      case 'meta':
        return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      case 'none':
        return !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    }
  }

  /** Update bindings for an action */
  setBindings(id: string, bindings: Keybind[]): void {
    const action = this.actions.get(id)
    if (!action || !action.editable) return

    action.bindings = bindings

    // Save all user bindings
    const toSave: Record<string, Keybind[]> = {}
    for (const [actionId, act] of this.actions) {
      if (act.editable) {
        toSave[actionId] = act.bindings
      }
    }
    saveToStorage(toSave)

    // Notify listeners
    this.notifyListeners()
  }

  /** Reset an action to defaults */
  resetToDefaults(id: string): void {
    const action = this.actions.get(id)
    if (!action || !action.editable) return

    action.bindings = [...action.defaults]

    // Save
    const toSave: Record<string, Keybind[]> = {}
    for (const [actionId, act] of this.actions) {
      if (act.editable) {
        toSave[actionId] = act.bindings
      }
    }
    saveToStorage(toSave)

    this.notifyListeners()
  }

  /** Reset all to defaults */
  resetAllToDefaults(): void {
    for (const action of this.actions.values()) {
      if (action.editable) {
        action.bindings = [...action.defaults]
      }
    }
    localStorage.removeItem(STORAGE_KEY)
    this.notifyListeners()
  }

  /** Add a change listener */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const keybindManager = new KeybindManager()

// ============================================================================
// Utility Functions
// ============================================================================

/** Format a keybind for display (e.g., "Ctrl+M") */
export function formatKeybind(binding: Keybind): string {
  const parts: string[] = []

  if (binding.modifier !== 'none') {
    const modifierDisplay = {
      ctrl: 'Ctrl',
      alt: 'Alt',
      shift: 'Shift',
      meta: navigator.platform.includes('Mac') ? '⌘' : 'Win',
    }
    parts.push(modifierDisplay[binding.modifier])
  }

  // Format key for display
  let keyDisplay = binding.key
  if (binding.key.length === 1) {
    keyDisplay = binding.key.toUpperCase()
  } else if (binding.key === 'Escape') {
    keyDisplay = 'Esc'
  }
  parts.push(keyDisplay)

  return parts.join('+')
}

/** Format multiple keybinds for display (e.g., "Tab / Esc") */
export function formatKeybinds(bindings: Keybind[]): string {
  return bindings.map(formatKeybind).join(' / ')
}

/** Parse a KeyboardEvent into a Keybind */
export function eventToKeybind(event: KeyboardEvent): Keybind {
  let modifier: Keybind['modifier'] = 'none'

  if (event.ctrlKey) modifier = 'ctrl'
  else if (event.altKey) modifier = 'alt'
  else if (event.shiftKey) modifier = 'shift'
  else if (event.metaKey) modifier = 'meta'

  return {
    key: event.key,
    modifier,
  }
}
