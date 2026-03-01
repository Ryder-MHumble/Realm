# Realm

3D visualization of Claude Code activity. When Claude uses tools, an animated character moves to workstations in a Three.js scene. Supports multiple Claude instances in hex zones with real-time WebSocket sync.

Also serves as an **orchestration backend**: external agents (like OpenClaw) can POST tasks to `/dispatch`, Realm decomposes them with an LLM, routes them to matching sessions, and POSTs results back via a `callbackUrl` when complete.

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
  index.ts          # Server entry: wires all managers, WebSocket, REST
  config.ts         # ServerConfig, port, paths
  logger.ts         # log() / debug() helpers
  ProjectsManager.ts# Known project directories registry
  managers/
    SessionManager.ts     # Managed session lifecycle (create/delete/prompt)
    EventProcessor.ts     # Hook event ingestion (events.jsonl watcher)
    TilesManager.ts       # Tile/station state
    GroupsManager.ts      # Department grouping
    TokenTracker.ts       # Token usage tracking
    PermissionManager.ts  # Permission checks
    WebSocketManager.ts   # WS broadcast hub
    SettingsManager.ts    # Persistent settings (LLM providers, channels)
    AutoCompactManager.ts # Auto-compact idle sessions
    AutoContinueManager.ts# Auto-continue paused sessions
  agents/
    AgentRegistry.ts      # Agent type registry
    AgentAdapter.ts       # Base adapter for Claw agents
  bot/
    BotBridge.ts          # Platform-agnostic IM interface
    NotificationManager.ts# Manages IM bridges (DingTalk, Feishu, Telegram)
    DingTalkAdapter.ts    # DingTalk outbound webhook + optional Stream inbound
    FeishuAdapter.ts      # Feishu/Lark inbound (WSClient) + outbound
    TaskOrchestrator.ts   # LLM task decomposition + session dispatch + callbacks
  api/
    router.ts             # HTTP request dispatcher + ServerContext type
    dispatchHandler.ts    # POST /dispatch — OpenClaw integration endpoint
    sessionsHandler.ts    # /sessions CRUD
    eventsHandler.ts      # /events SSE stream
    agentsHandler.ts      # /agents
    projectsHandler.ts    # /projects
    groupsHandler.ts      # /groups
    tilesHandler.ts       # /tiles
    settingsHandler.ts    # /settings
    uploadHandler.ts      # /upload
    promptHandler.ts      # /prompt, /tmux-output, /cancel (legacy)
    staticHandler.ts      # Static file serving
    httpUtils.ts          # collectRequestBody, jsonResponse
shared/
  types.ts          # Shared types (events, stations, sessions, LLM config)
  defaults.ts       # Default config values
hooks/
  realm-hook.sh # Claude Code hook (captures events)
```

## Key Conventions

- EventBus pattern for decoupled event handling (`src/events/handlers/`)
- All sounds synthesized via Tone.js — no audio files
- CSS in `src/styles/`, imported via `index.css`
- Hex grid coordinate system for zone placement
- Sessions managed via server REST API, state synced via WebSocket
- localStorage for user preferences, server files for shared state
- i18n via `src/i18n/` — use `t('key')` for all user-facing strings
- Data directory: `~/.realm/data/` (shared between hook and server)
- Settings persisted in `~/.realm/data/settings.json` (LLM providers, IM channels)

## OpenClaw Integration (POST /dispatch)

Realm is a **pure orchestration backend**. It does not connect to DingTalk directly — external agents like OpenClaw handle IM and call Realm's REST API.

```
DingTalk → OpenClaw → POST /dispatch (Realm)
                          ↓
                   LLM decomposes task
                          ↓
               dispatch to matching sessions
                          ↓
              sessions work asynchronously
                          ↓
              POST callbackUrl → OpenClaw → DingTalk
```

**Request:**

```json
POST /dispatch
{ "message": "...", "callbackUrl": "http://openclaw/callback", "sessionId": "optional" }
```

**Response:**

```json
{ "ok": true, "taskGroupId": "abc123", "dispatched": [{"sessionId":"...","sessionName":"Frontend","prompt":"..."}] }
```

**Callback (when all sessions complete):**

```json
POST callbackUrl
{ "taskGroupId": "abc123", "originalMessage": "...", "results": [{"sessionName":"Frontend","response":"..."}], "durationMs": 12000 }
```

See [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) for full details.

## LLM Provider Configuration

TaskOrchestrator uses a configured LLM provider for task decomposition. Configure in Settings UI or directly in `~/.realm/data/settings.json`:

```json
{
  "llmProviders": {
    "openrouter": {
      "provider": "custom",
      "apiKey": "sk-or-v1-...",
      "model": "stepfun/step-3.5-flash:free",
      "baseUrl": "https://openrouter.ai/api/v1",
      "maxTokens": 1024
    }
  },
  "defaultProvider": "openrouter"
}
```

Supported provider types: `"anthropic"` (uses `/v1/messages` API), `"openai"` / `"custom"` (uses `/chat/completions` OpenAI-compatible API).

If no provider is configured, TaskOrchestrator falls back to routing the full message to any idle session.

## Terminology

- **Claw**: Refers to open-source AI agent projects like OpenClaw, NanoClaw, ZeroClaw. These are distinct from Claude Code — Claw agents require external LLM provider configuration (API keys, models, base URLs), while Claude Code uses its own built-in API key. The settings UI separates Claw config into its own tab.
- **TaskOrchestrator**: Server component that receives task dispatch requests, uses an LLM to break them into sub-tasks, routes each to the best matching session, and fires `callbackUrl` when all complete.
- **TaskGroup**: A group of sub-tasks that originated from the same dispatch request. Tracked until all sessions report `stop`.
