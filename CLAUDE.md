# Vibecraft

3D visualization of Claude Code activity. When Claude uses tools, an animated character moves to workstations in a Three.js scene. Supports multiple Claude instances in hex zones with real-time WebSocket sync.

## Tech Stack

- **Frontend**: TypeScript, Three.js, Tone.js, Vite
- **Server**: Node.js, WebSocket (ws), chokidar
- **No framework** — vanilla TypeScript, no React/Vue

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev (Vite + tsx watch) |
| `npm run build` | Build client + server |
| `npm run server` | Server only (tsx) |

## Directory Structure

```
src/
  main.ts           # Entry point, UI + event routing
  styles/           # Modular CSS (base, feed, prompt, hud, sessions, modals)
  i18n/             # Internationalization (en/zh translations)
  ui/               # UI modules (modals, feed, voice, draw mode)
  scene/            # Three.js scene, zones, station panels
  entities/         # Character (ClaudeMon), subagents, animations
  events/           # EventBus + handler modules
  audio/            # SoundManager (Tone.js synthesis), spatial audio
  api/              # SessionAPI client
  systems/          # AttentionSystem
server/
  index.ts          # WebSocket server, REST API, tmux integration
shared/
  types.ts          # Shared types (events, stations, sessions)
  defaults.ts       # Default config values
hooks/
  vibecraft-hook.sh # Claude Code hook (captures events)
```

## Key Conventions

- EventBus pattern for decoupled event handling (`src/events/handlers/`)
- All sounds synthesized via Tone.js — no audio files
- CSS in `src/styles/`, imported via `index.css`
- Hex grid coordinate system for zone placement
- Sessions managed via server REST API, state synced via WebSocket
- localStorage for user preferences, server files for shared state
- i18n via `src/i18n/` — use `t('key')` for all user-facing strings
- Data directory: `~/.vibecraft/data/` (shared between hook and server)

## Terminology

- **Claw**: Refers to open-source AI agent projects like OpenClaw, NanoClaw, ZeroClaw. These are distinct from Claude Code — Claw agents require external LLM provider configuration (API keys, models, base URLs), while Claude Code uses its own built-in API key. The settings UI separates Claw config into its own tab.
