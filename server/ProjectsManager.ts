/**
 * ProjectsManager - Track known project directories
 *
 * Stores directories the user has used, enabling quick project switching
 * and path autocomplete in the UI.
 *
 * Data stored in ~/.realm/projects.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { homedir } from 'os'

// ============================================================================
// Types
// ============================================================================

export interface KnownProject {
  /** Absolute path to the directory */
  path: string
  /** Display name (defaults to directory basename) */
  name: string
  /** Last time this project was used (unix ms) */
  lastUsed: number
  /** Number of times this project has been opened */
  useCount: number
}

export interface ProjectsData {
  projects: KnownProject[]
}

// ============================================================================
// ProjectsManager
// ============================================================================

export class ProjectsManager {
  private configDir: string
  private configFile: string
  private projects: KnownProject[] = []

  constructor() {
    this.configDir = resolve(homedir(), '.realm')
    this.configFile = join(this.configDir, 'projects.json')
    this.load()
  }

  /**
   * Get all known projects, sorted by recency
   */
  getProjects(): KnownProject[] {
    return [...this.projects].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /**
   * Add or update a project directory
   */
  addProject(path: string, name?: string): void {
    const absPath = resolve(path)
    const existing = this.projects.find(p => p.path === absPath)

    if (existing) {
      existing.lastUsed = Date.now()
      existing.useCount++
      if (name) existing.name = name
    } else {
      this.projects.push({
        path: absPath,
        name: name || basename(absPath),
        lastUsed: Date.now(),
        useCount: 1,
      })
    }

    this.save()
  }

  /**
   * Remove a project from the list
   */
  removeProject(path: string): void {
    const absPath = resolve(path)
    this.projects = this.projects.filter(p => p.path !== absPath)
    this.save()
  }

  /**
   * Autocomplete a partial path
   * Returns matching directories from:
   * 1. Filesystem (if actively browsing - path ends with /)
   * 2. Known projects (fuzzy match)
   * 3. Filesystem completion (partial path)
   */
  autocomplete(partial: string, limit = 15): string[] {
    const results: string[] = []
    const seen = new Set<string>()

    // Normalize the partial path
    const normalizedPartial = partial.startsWith('~')
      ? resolve(homedir(), partial.slice(1))  // ~/foo → /home/user/foo, ~ → /home/user
      : partial

    // Check if user is actively browsing (path ends with /)
    const isBrowsing = partial.endsWith('/') || partial === '~'
    const isPathLike = partial.startsWith('/') || partial.startsWith('~') || partial.startsWith('.')

    // 1. Filesystem results first when actively browsing
    if (isPathLike) {
      try {
        const fsResults = this.filesystemAutocomplete(normalizedPartial)
        for (const path of fsResults) {
          if (!seen.has(path)) {
            results.push(path)
            seen.add(path)
          }
        }
      } catch {
        // Ignore filesystem errors
      }
    }

    // 2. Add known projects (but deprioritize when browsing)
    const lowerPartial = partial.toLowerCase()
    const matchingProjects: string[] = []
    for (const project of this.projects) {
      if (
        project.path.toLowerCase().includes(lowerPartial) ||
        project.name.toLowerCase().includes(lowerPartial)
      ) {
        if (!seen.has(project.path)) {
          matchingProjects.push(project.path)
          seen.add(project.path)
        }
      }
    }

    // When browsing, put filesystem first; otherwise put known projects first
    if (isBrowsing) {
      // Filesystem results are already first, add projects after
      results.push(...matchingProjects)
    } else {
      // Not browsing - known projects first, then filesystem
      // Re-sort: projects at front
      const knownPaths = new Set(this.projects.map(p => p.path))
      const fsOnly = results.filter(r => !knownPaths.has(r))
      results.length = 0
      results.push(...matchingProjects, ...fsOnly)
    }

    // Sort filesystem results alphabetically within their section
    // (known projects stay sorted by recency from getProjects())

    return results.slice(0, limit)
  }

  /**
   * Filesystem-based autocomplete
   */
  private filesystemAutocomplete(partial: string): string[] {
    const results: string[] = []

    // If the partial is an existing directory, list its contents
    if (existsSync(partial) && statSync(partial).isDirectory()) {
      try {
        const entries = readdirSync(partial)
        for (const entry of entries) {
          // Skip hidden files unless partial ends with /.
          if (entry.startsWith('.') && !partial.endsWith('/.')) continue

          const fullPath = join(partial, entry)
          try {
            if (statSync(fullPath).isDirectory()) {
              results.push(fullPath)
            }
          } catch {
            // Skip entries we can't stat
          }
        }
      } catch {
        // Can't read directory
      }
    } else {
      // Partial path - complete the last segment
      const dir = dirname(partial)
      const prefix = basename(partial).toLowerCase()

      if (existsSync(dir) && statSync(dir).isDirectory()) {
        try {
          const entries = readdirSync(dir)
          for (const entry of entries) {
            if (entry.toLowerCase().startsWith(prefix)) {
              const fullPath = join(dir, entry)
              try {
                if (statSync(fullPath).isDirectory()) {
                  results.push(fullPath)
                }
              } catch {
                // Skip
              }
            }
          }
        } catch {
          // Can't read directory
        }
      }
    }

    return results
  }

  /**
   * Load projects from disk
   */
  private load(): void {
    if (!existsSync(this.configFile)) {
      this.projects = []
      return
    }

    try {
      const content = readFileSync(this.configFile, 'utf-8')
      const data: ProjectsData = JSON.parse(content)
      this.projects = data.projects || []
    } catch (e) {
      console.error('Failed to load projects:', e)
      this.projects = []
    }
  }

  /**
   * Save projects to disk
   */
  private save(): void {
    // Ensure config dir exists
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }

    const data: ProjectsData = { projects: this.projects }
    writeFileSync(this.configFile, JSON.stringify(data, null, 2))
  }
}
