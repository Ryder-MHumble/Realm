#!/usr/bin/env node

/**
 * Vibeshop CLI - 3D visualization for Claude Code
 *
 * Usage:
 *   npx realm          # Start the server
 *   npx realm --help   # Show help
 */

// Check if cwd exists (common issue when running from deleted directory)
try {
  process.cwd()
} catch (e) {
  console.error('Error: Current directory no longer exists.')
  console.error('This happens when the directory you ran the command from was deleted.')
  console.error('\nFix: cd to a valid directory first:')
  console.error('  cd ~')
  console.error('  npx realm setup')
  process.exit(1)
}

import { spawn, execSync } from 'child_process'
import { dirname, resolve, join, basename } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ============================================================================
// Health Checks
// ============================================================================

function checkJq() {
  try {
    execSync('which jq', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function checkTmux() {
  try {
    execSync('which tmux', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function checkHooksConfigured() {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    return { configured: false, reason: 'no settings file' }
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = settings.hooks || {}
    const hasPreToolUse = hooks.PreToolUse?.some(h =>
      h.hooks?.some(hh => hh.command?.includes('realm-hook'))
    )
    const hasPostToolUse = hooks.PostToolUse?.some(h =>
      h.hooks?.some(hh => hh.command?.includes('realm-hook'))
    )

    if (hasPreToolUse && hasPostToolUse) {
      return { configured: true }
    }
    return { configured: false, reason: 'hooks not found in settings' }
  } catch (e) {
    return { configured: false, reason: 'failed to parse settings' }
  }
}

function printHealthCheck() {
  const jqOk = checkJq()
  const tmuxOk = checkTmux()
  const hooksResult = checkHooksConfigured()

  let warnings = []

  if (!jqOk) {
    warnings.push(`  [!] jq not found - hooks won't work without it
      Install: brew install jq (macOS) or apt install jq (Linux)`)
  }

  if (!tmuxOk) {
    warnings.push(`  [!] tmux not found - session management won't work
      Install: brew install tmux (macOS) or apt install tmux (Linux)`)
  }

  if (!hooksResult.configured) {
    warnings.push(`  [!] Hooks not configured - events won't be captured
      Run: npx realm setup
      Then restart Claude Code`)
  }

  if (warnings.length > 0) {
    console.log('\n  Warnings:')
    warnings.forEach(w => console.log(w))
    console.log()
  }
}

// Parse arguments
const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
realm - 3D visualization for Claude Code

Usage:
  realm [options]
  realm setup         Configure Claude Code hooks automatically
  realm uninstall     Remove realm hooks (keeps your data)
  realm doctor        Diagnose common issues

Options:
  --port, -p <port>    WebSocket server port (default: 4003)
  --help, -h           Show this help message
  --version, -v        Show version
  --hook-path          Print path to hook script (for manual setup)

Environment Variables:
  REALM_PORT       WebSocket server port (default: 4003)
  REALM_DEBUG      Enable debug logging (true/false)

Setup:
  1. Run: realm setup
  2. Start server: realm
  3. Open frontend in browser

Website: https://realm.sh
GitHub:  https://github.com/nearcyan/realm
`)
  process.exit(0)
}

// Hook path command
if (args.includes('--hook-path')) {
  console.log(resolve(ROOT, 'hooks/realm-hook.sh'))
  process.exit(0)
}

// Setup command
if (args[0] === 'setup') {
  const { writeFileSync, copyFileSync, chmodSync } = await import('fs')

  console.log('Setting up realm hooks...\n')

  // ==========================================================================
  // Step 1: Find Claude Code settings
  // ==========================================================================

  // Possible locations for Claude settings (in order of preference)
  const possibleSettingsPaths = [
    join(homedir(), '.claude', 'settings.json'),           // Standard location
    join(homedir(), '.config', 'claude', 'settings.json'), // XDG config
  ]

  let settingsPath = null
  let settingsDir = null

  // Find existing settings file
  for (const path of possibleSettingsPaths) {
    if (existsSync(path)) {
      settingsPath = path
      settingsDir = dirname(path)
      break
    }
  }

  // If no settings file found, use default location
  if (!settingsPath) {
    settingsPath = possibleSettingsPaths[0]
    settingsDir = dirname(settingsPath)
  }

  console.log(`Claude settings: ${settingsPath}`)

  // ==========================================================================
  // Step 2: Install hook script to ~/.realm/hooks/
  // ==========================================================================

  const realmHooksDir = join(homedir(), '.realm', 'hooks')
  const installedHookPath = join(realmHooksDir, 'realm-hook.sh')
  const sourceHookPath = resolve(ROOT, 'hooks/realm-hook.sh')

  // Ensure hooks directory exists
  if (!existsSync(realmHooksDir)) {
    mkdirSync(realmHooksDir, { recursive: true })
    console.log(`Created ${realmHooksDir}`)
  }

  // Copy hook script
  if (!existsSync(sourceHookPath)) {
    console.error(`ERROR: Hook script not found at ${sourceHookPath}`)
    console.error('This is a bug - please report it.')
    process.exit(1)
  }

  try {
    copyFileSync(sourceHookPath, installedHookPath)
    chmodSync(installedHookPath, 0o755) // Make executable
    console.log(`Installed hook: ${installedHookPath}`)
  } catch (e) {
    console.error(`ERROR: Failed to install hook script: ${e.message}`)
    process.exit(1)
  }

  // ==========================================================================
  // Step 3: Ensure data directory exists
  // ==========================================================================

  const dataDir = join(homedir(), '.realm', 'data')
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
    console.log(`Created ${dataDir}`)
  }

  // ==========================================================================
  // Step 4: Configure Claude Code settings
  // ==========================================================================

  // Ensure settings directory exists
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true })
    console.log(`Created ${settingsDir}`)
  }

  // Load or create settings
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      // Backup existing settings
      const backupPath = `${settingsPath}.backup-${Date.now()}`
      writeFileSync(backupPath, JSON.stringify(settings, null, 2))
      console.log(`Backed up settings: ${backupPath}`)
    } catch (e) {
      console.error(`ERROR: Failed to parse ${settingsPath}: ${e.message}`)
      console.error('Please fix the JSON syntax and try again.')
      process.exit(1)
    }
  }

  // Hook configurations - use installed path (stable location)
  const toolHookEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: installedHookPath, timeout: 5 }]
  }
  const genericHookEntry = {
    hooks: [{ type: 'command', command: installedHookPath, timeout: 5 }]
  }

  // Initialize hooks object
  settings.hooks = settings.hooks || {}

  // Helper to add/update hooks (removes old realm hooks first)
  const addHook = (eventType, entry) => {
    settings.hooks[eventType] = settings.hooks[eventType] || []
    // Remove any existing realm hooks (from any location)
    settings.hooks[eventType] = settings.hooks[eventType].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('realm-hook'))
    )
    // Add new hook
    settings.hooks[eventType].push(entry)
  }

  // Configure ALL hooks
  addHook('PreToolUse', toolHookEntry)
  addHook('PostToolUse', toolHookEntry)
  addHook('Stop', genericHookEntry)
  addHook('SubagentStop', genericHookEntry)
  addHook('SessionStart', genericHookEntry)
  addHook('SessionEnd', genericHookEntry)
  addHook('UserPromptSubmit', genericHookEntry)
  addHook('Notification', genericHookEntry)

  // Write settings
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    console.log(`Updated settings: ${settingsPath}`)
  } catch (e) {
    console.error(`ERROR: Failed to write settings: ${e.message}`)
    process.exit(1)
  }

  // ==========================================================================
  // Step 5: Verify and report
  // ==========================================================================

  console.log('\n' + '='.repeat(50))
  console.log('Setup complete!')
  console.log('='.repeat(50))

  console.log('\nHooks configured:')
  console.log('  - PreToolUse')
  console.log('  - PostToolUse')
  console.log('  - Stop')
  console.log('  - SubagentStop')
  console.log('  - SessionStart')
  console.log('  - SessionEnd')
  console.log('  - UserPromptSubmit')
  console.log('  - Notification')

  // Check dependencies
  let hasWarnings = false

  if (!checkJq()) {
    hasWarnings = true
    console.log('\n[!] Warning: jq not found')
    console.log('    Install: brew install jq (macOS) or apt install jq (Linux)')
  }

  if (!checkTmux()) {
    hasWarnings = true
    console.log('\n[!] Warning: tmux not found')
    console.log('    Install: brew install tmux (macOS) or apt install tmux (Linux)')
  }

  if (!hasWarnings) {
    console.log('\nAll dependencies found!')
  }

  // Check if server is already running (likely an update)
  let serverRunning = false
  try {
    const res = execSync('curl -s http://localhost:4003/health', { timeout: 2000 })
    if (res.toString().includes('"ok":true')) {
      serverRunning = true
    }
  } catch {}

  if (serverRunning) {
    // Update scenario
    console.log('\nTo complete the update:')
    console.log('  1. Restart realm server (Ctrl+C, then run: npx realm)')
    console.log('  2. Restart Claude Code (for hook changes to take effect)')
    console.log('  3. Refresh browser\n')
  } else {
    // Fresh install scenario
    console.log('\nNext steps:')
    console.log('  1. Restart Claude Code (required for hooks to take effect)')
    console.log('  2. Run: npx realm')
    console.log('  3. Open http://localhost:4003 in your browser\n')
  }

  process.exit(0)
}

// Uninstall command
if (args[0] === 'uninstall') {
  const { writeFileSync, rmSync } = await import('fs')

  console.log('Uninstalling realm hooks...\n')

  // ==========================================================================
  // Step 1: Find Claude Code settings
  // ==========================================================================

  const possibleSettingsPaths = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.config', 'claude', 'settings.json'),
  ]

  let settingsPath = null
  for (const path of possibleSettingsPaths) {
    if (existsSync(path)) {
      settingsPath = path
      break
    }
  }

  if (!settingsPath) {
    console.log('No Claude settings file found - nothing to uninstall.')
    process.exit(0)
  }

  console.log(`Claude settings: ${settingsPath}`)

  // ==========================================================================
  // Step 2: Remove realm hooks from settings
  // ==========================================================================

  let settings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch (e) {
    console.error(`ERROR: Failed to parse ${settingsPath}: ${e.message}`)
    process.exit(1)
  }

  if (!settings.hooks) {
    console.log('No hooks configured - nothing to uninstall.')
    process.exit(0)
  }

  // Backup before modifying
  const backupPath = `${settingsPath}.backup-${Date.now()}`
  writeFileSync(backupPath, JSON.stringify(settings, null, 2))
  console.log(`Backed up settings: ${backupPath}`)

  // Remove realm hooks from each event type
  const hookTypes = [
    'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification'
  ]

  let removedCount = 0
  for (const hookType of hookTypes) {
    if (!settings.hooks[hookType]) continue

    const before = settings.hooks[hookType].length
    settings.hooks[hookType] = settings.hooks[hookType].filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('realm-hook'))
    )
    const after = settings.hooks[hookType].length

    if (before !== after) {
      removedCount += (before - after)
      console.log(`  Removed realm hook from ${hookType}`)
    }

    // Clean up empty arrays
    if (settings.hooks[hookType].length === 0) {
      delete settings.hooks[hookType]
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks
  }

  if (removedCount === 0) {
    console.log('No realm hooks found - nothing to remove.')
  } else {
    // Write updated settings
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    console.log(`\nRemoved ${removedCount} hook(s) from settings.`)
  }

  // ==========================================================================
  // Step 3: Remove hook script (but keep data)
  // ==========================================================================

  const hookScript = join(homedir(), '.realm', 'hooks', 'realm-hook.sh')
  if (existsSync(hookScript)) {
    rmSync(hookScript)
    console.log(`Removed: ${hookScript}`)
  }

  // Remove hooks directory if empty
  const hooksDir = join(homedir(), '.realm', 'hooks')
  if (existsSync(hooksDir)) {
    try {
      const { readdirSync } = await import('fs')
      if (readdirSync(hooksDir).length === 0) {
        rmSync(hooksDir, { recursive: true })
        console.log(`Removed empty directory: ${hooksDir}`)
      }
    } catch {}
  }

  // ==========================================================================
  // Done
  // ==========================================================================

  console.log('\n' + '='.repeat(50))
  console.log('Uninstall complete!')
  console.log('='.repeat(50))

  console.log('\nRealm hooks have been removed.')
  console.log('Your data is preserved in ~/.realm/data/')
  console.log('\nTo remove all data:')
  console.log('  rm -rf ~/.realm')
  console.log('\nRestart Claude Code for changes to take effect.\n')

  process.exit(0)
}

// Doctor command - diagnose common issues
if (args[0] === 'doctor') {
  console.log('='.repeat(50))
  console.log('Realm Doctor - Diagnosing your setup...')
  console.log('='.repeat(50))
  console.log()

  let issues = []
  let warnings = []

  // -------------------------------------------------------------------------
  // 1. Check dependencies
  // -------------------------------------------------------------------------
  console.log('[1/6] Checking dependencies...')

  // Node version
  const nodeVersion = process.version
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0])
  if (nodeMajor >= 18) {
    console.log(`  ✓ Node.js ${nodeVersion}`)
  } else {
    console.log(`  ✗ Node.js ${nodeVersion} (need 18+)`)
    issues.push('Node.js 18+ required')
  }

  // jq
  if (checkJq()) {
    try {
      const jqVersion = execSync('jq --version 2>&1', { encoding: 'utf-8' }).trim()
      console.log(`  ✓ jq (${jqVersion})`)
    } catch {
      console.log('  ✓ jq')
    }
  } else {
    console.log('  ✗ jq not found')
    issues.push('jq not installed - hooks will not work')
  }

  // tmux
  if (checkTmux()) {
    try {
      const tmuxVersion = execSync('tmux -V 2>&1', { encoding: 'utf-8' }).trim()
      console.log(`  ✓ tmux (${tmuxVersion})`)
    } catch {
      console.log('  ✓ tmux')
    }
  } else {
    console.log('  ⚠ tmux not found (optional - needed for browser prompts)')
    warnings.push('tmux not installed - browser prompt feature won\'t work')
  }

  // curl
  try {
    execSync('which curl', { stdio: 'ignore' })
    console.log('  ✓ curl')
  } catch {
    console.log('  ✗ curl not found')
    issues.push('curl not installed - hooks cannot send events to server')
  }

  // -------------------------------------------------------------------------
  // 2. Check hook script
  // -------------------------------------------------------------------------
  console.log('\n[2/6] Checking hook script...')

  const hookScript = join(homedir(), '.realm', 'hooks', 'realm-hook.sh')
  if (existsSync(hookScript)) {
    console.log(`  ✓ Hook script exists: ${hookScript}`)

    // Check if executable
    try {
      const { accessSync, constants } = await import('fs')
      accessSync(hookScript, constants.X_OK)
      console.log('  ✓ Hook script is executable')
    } catch {
      console.log('  ✗ Hook script is not executable')
      issues.push(`Hook script not executable. Run: chmod +x ${hookScript}`)
    }
  } else {
    console.log(`  ✗ Hook script not found: ${hookScript}`)
    issues.push('Hook script not installed. Run: npx realm setup')
  }

  // -------------------------------------------------------------------------
  // 3. Check Claude settings
  // -------------------------------------------------------------------------
  console.log('\n[3/6] Checking Claude Code settings...')

  const settingsPaths = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.config', 'claude', 'settings.json'),
  ]

  let settingsPath = null
  for (const p of settingsPaths) {
    if (existsSync(p)) {
      settingsPath = p
      break
    }
  }

  if (!settingsPath) {
    console.log('  ✗ No Claude settings file found')
    issues.push('Claude settings not found. Run: npx realm setup')
  } else {
    console.log(`  ✓ Settings file: ${settingsPath}`)

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const hooks = settings.hooks || {}

      const hookTypes = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
                         'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification']

      let configuredHooks = []
      let missingHooks = []

      for (const hookType of hookTypes) {
        const hasRealm = hooks[hookType]?.some(h =>
          h.hooks?.some(hh => hh.command?.includes('realm-hook'))
        )
        if (hasRealm) {
          configuredHooks.push(hookType)
        } else {
          missingHooks.push(hookType)
        }
      }

      if (configuredHooks.length === hookTypes.length) {
        console.log(`  ✓ All ${hookTypes.length} hooks configured`)
      } else if (configuredHooks.length > 0) {
        console.log(`  ⚠ ${configuredHooks.length}/${hookTypes.length} hooks configured`)
        console.log(`    Missing: ${missingHooks.join(', ')}`)
        warnings.push(`Some hooks not configured: ${missingHooks.join(', ')}`)
      } else {
        console.log('  ✗ No realm hooks configured')
        issues.push('Hooks not configured. Run: npx realm setup')
      }
    } catch (e) {
      console.log(`  ✗ Failed to parse settings: ${e.message}`)
      issues.push('Claude settings file has invalid JSON')
    }
  }

  // -------------------------------------------------------------------------
  // 4. Check data directory
  // -------------------------------------------------------------------------
  console.log('\n[4/6] Checking data directory...')

  const dataDir = join(homedir(), '.realm', 'data')
  if (existsSync(dataDir)) {
    console.log(`  ✓ Data directory exists: ${dataDir}`)

    // Check events file
    const eventsFile = join(dataDir, 'events.jsonl')
    if (existsSync(eventsFile)) {
      const { statSync } = await import('fs')
      const stats = statSync(eventsFile)
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2)
      const modifiedAgo = Math.round((Date.now() - stats.mtimeMs) / 1000)

      let timeAgo
      if (modifiedAgo < 60) timeAgo = `${modifiedAgo}s ago`
      else if (modifiedAgo < 3600) timeAgo = `${Math.round(modifiedAgo/60)}m ago`
      else if (modifiedAgo < 86400) timeAgo = `${Math.round(modifiedAgo/3600)}h ago`
      else timeAgo = `${Math.round(modifiedAgo/86400)}d ago`

      console.log(`  ✓ Events file: ${sizeMB} MB, last modified ${timeAgo}`)

      if (modifiedAgo > 86400) {
        warnings.push('No events in 24+ hours - hooks may not be firing')
      }
    } else {
      console.log('  ⚠ No events file yet (will be created when hooks fire)')
    }
  } else {
    console.log(`  ✗ Data directory not found: ${dataDir}`)
    issues.push('Data directory not created. Run: npx realm setup')
  }

  // -------------------------------------------------------------------------
  // 5. Check server status
  // -------------------------------------------------------------------------
  console.log('\n[5/6] Checking server status...')

  try {
    const healthRes = execSync('curl -s http://localhost:4003/health', {
      timeout: 3000,
      encoding: 'utf-8'
    })
    const health = JSON.parse(healthRes)
    if (health.ok) {
      console.log(`  ✓ Server running on port 4003`)
      console.log(`    Version: ${health.version || 'unknown'}`)
      console.log(`    Clients: ${health.clients || 0}`)
      console.log(`    Events: ${health.events || 0}`)
    }
  } catch {
    console.log('  ⚠ Server not running on port 4003')
    warnings.push('Server not running. Start with: npx realm')
  }

  // -------------------------------------------------------------------------
  // 6. Check tmux sessions
  // -------------------------------------------------------------------------
  console.log('\n[6/6] Checking tmux sessions...')

  if (checkTmux()) {
    try {
      const sessions = execSync('tmux list-sessions 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 2000
      }).trim()

      if (sessions) {
        const sessionList = sessions.split('\n')
        console.log(`  ✓ ${sessionList.length} tmux session(s) found:`)
        sessionList.forEach(s => console.log(`    - ${s.split(':')[0]}`))

        const hasClaude = sessionList.some(s => s.startsWith('claude:'))
        if (!hasClaude) {
          console.log('  ⚠ No "claude" session (browser prompts target this by default)')
        }
      } else {
        console.log('  ⚠ No tmux sessions running')
      }
    } catch {
      console.log('  ⚠ No tmux sessions running')
    }
  } else {
    console.log('  - Skipped (tmux not installed)')
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n' + '='.repeat(50))

  if (issues.length === 0 && warnings.length === 0) {
    console.log('✓ All checks passed! Realm should be working.')
  } else {
    if (issues.length > 0) {
      console.log(`✗ ${issues.length} issue(s) found:\n`)
      issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`))
    }
    if (warnings.length > 0) {
      console.log(`\n⚠ ${warnings.length} warning(s):\n`)
      warnings.forEach((warning, i) => console.log(`  ${i + 1}. ${warning}`))
    }
  }

  console.log('\n' + '='.repeat(50))
  console.log()

  process.exit(issues.length > 0 ? 1 : 0)
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  console.log(`realm v${pkg.version}`)
  process.exit(0)
}

// Parse port from args
let port = process.env.REALM_PORT || '4003'
const portIdx = args.findIndex(a => a === '--port' || a === '-p')
if (portIdx !== -1 && args[portIdx + 1]) {
  port = args[portIdx + 1]
}

// Ensure data directory exists
const dataDir = resolve(ROOT, 'data')
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}

// Banner
console.log(`
  ╭─────────────────────────────────────╮
  │                                     │
  │   realm                          │
  │   3D visualization for Claude Code  │
  │                                     │
  ╰─────────────────────────────────────╯
`)

// Run health checks
printHealthCheck()

console.log(`Starting server on port ${port}...`)
console.log(`Open http://localhost:${port} in your browser`)
console.log()

// Check for compiled JS (npm package) or fall back to tsx (dev)
const compiledPath = resolve(ROOT, 'dist/server/server/index.js')
const sourcePath = resolve(ROOT, 'server/index.ts')

let server
if (existsSync(compiledPath)) {
  // Use compiled JS (production/npm install)
  server = spawn('node', [compiledPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      REALM_PORT: port,
    },
    stdio: 'inherit',
  })
} else {
  // Fall back to tsx (development)
  console.log('(dev mode - using tsx)')
  server = spawn('npx', ['tsx', sourcePath], {
    cwd: ROOT,
    env: {
      ...process.env,
      REALM_PORT: port,
    },
    stdio: 'inherit',
  })
}

server.on('error', (err) => {
  console.error('Failed to start server:', err.message)
  process.exit(1)
})

server.on('close', (code) => {
  process.exit(code || 0)
})

// Handle signals
process.on('SIGINT', () => {
  server.kill('SIGINT')
})

process.on('SIGTERM', () => {
  server.kill('SIGTERM')
})
