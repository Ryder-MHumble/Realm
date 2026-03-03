# Realm
<div align="center">
  <img src="public/Realm-Logo.png" alt="Real-Logo" width="600" />
</div>

> **See your AI agents work.** Realm visualizes Claude Code activity in real-time 3D, orchestrates multi-agent tasks, and connects external systems via REST API.

Every tool call animates a character moving through a living workshop. Each session gets its own hexagonal zone. Tasks decompose automatically and route to the right agent. Watch it all unfold in real-time.

## What Realm Does

**Visualize** — Every tool call (read, write, bash, grep) triggers a context-aware animation. Reading files? Walk to the bookshelf. Running tests? The terminal glows. Committing code? Celebrate. Errors? Shake your head.

**Orchestrate** — Dispatch tasks to multiple Claude Code instances or Claw agents in parallel. An LLM-powered router decomposes natural language into sub-tasks and routes each to the best-fit session automatically.

**Connect** — External systems (OpenClaw, DingTalk, Feishu, Telegram) push tasks via REST API. Realm routes them, collects results, and fires webhooks when complete.

![Realm-Slogan](public/Realm-Slogan.png)

## Requirements

- **macOS or Linux** (Windows not supported — hooks require bash)
- **Node.js** 18+
- **jq** (`brew install jq` / `apt install jq`)
- **tmux** (`brew install tmux` / `apt install tmux`)

## Quick Start

```bash
# 1. Install dependencies
brew install jq tmux

# 2. Configure hooks (once)
npx realm setup

# 3. Start
npx realm
```

Open `http://localhost:4003` and use Claude Code normally. Watch it move through the workshop as it works.

**From source:**

```bash
git clone <this-repo>
cd Realm && npm install && npm run dev
```

## Stations

| Station   | Tools               | Description               |
|-----------|---------------------|---------------------------|
| Bookshelf | Read                | Character browses files   |
| Desk      | Write               | Pencil, ink pot, paper    |
| Workbench | Edit                | Wrench, gears, bolts      |
| Terminal  | Bash                | Glowing green screen      |
| Scanner   | Grep, Glob          | Telescope sweeps the room |
| Antenna   | WebFetch, WebSearch | Satellite dish spins      |
| Portal    | Task (subagents)    | Glowing ring, mini-clones |
| Taskboard | TodoWrite           | Sticky-note board         |

## Features

- **Multi-agent zones** — Each session gets a hex zone with its own character and workstations
- **Real-time 3D animations** — Context-aware reactions: celebrates commits, shakes on errors
- **Subagent visualization** — Mini-characters spawn at the Portal for parallel sub-tasks
- **Spatial audio** — Synthesized sounds positioned in 3D space (Tone.js, no audio files)
- **Activity feed** — Live stream of tool calls, responses, and thinking
- **Voice input** — Speak prompts with real-time transcription (Deepgram API key required)
- **Draw mode** — Paint hex tiles with colors, 3D stacking, and labels
- **Department grouping** — Organize zones into departments (Civ-6-style)
- **Station panels** — Per-workstation history and details
- **Attention system** — Zones pulse when waiting for input or finishing
- **Auto-compact / Auto-continue** — Keeps long-running sessions alive
- **IM integration** — Receive tasks from DingTalk, Feishu, Telegram; send results back

## Multi-Agent Orchestration

Dispatch tasks to multiple agents and watch them work in parallel:

1. Click **"+ New"** (or `Alt+N`) to create a zone
2. Configure name, directory, agent type, and flags
3. Select a zone (`1–6`) to target it with prompts
4. Or use **POST /dispatch** to let the LLM router decide

Each session runs in its own tmux with status tracking (`idle` / `working` / `offline`).

See [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) for the full API.

## POST /dispatch — External Agent Integration

Realm accepts tasks from external systems and routes them intelligently:

```text
IM Platform → Agent → POST /dispatch (Realm)
                              ↓
                       LLM decomposes task
                              ↓
                   dispatch to matching zones
                              ↓
                  zones work asynchronously
                              ↓
               POST callbackUrl → Agent → IM
```

**Request:**

```json
POST /dispatch
{ "message": "...", "callbackUrl": "http://agent/callback", "sessionId": "optional" }
```

**Callback (when all zones complete):**

```json
POST callbackUrl
{ "taskGroupId": "abc123", "results": [...], "durationMs": 12000 }
```

## LLM Provider Configuration

Configure in the Settings UI or in `~/.realm/data/settings.json`:

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

Supported: `"anthropic"`, `"openai"`, `"custom"` (OpenAI-compatible, e.g. OpenRouter, Ollama).

## Keyboard Shortcuts

| Key          | Action                                |
|--------------|---------------------------------------|
| `Tab` / `Esc`| Switch focus: Workshop ↔ Feed         |
| `1–6`        | Switch to zone (extended: QWERTY row) |
| `0` / `` ` ``| All zones / overview                  |
| `Alt+N`      | New zone                              |
| `Alt+R`      | Toggle voice input                    |
| `F`          | Toggle follow mode                    |
| `P`          | Toggle station panels                 |
| `D`          | Toggle draw mode                      |

**Draw mode:** `1–6` colors · `0` eraser · `Q/E` brush size · `R` 3D stack · `X` clear

## CLI

```bash
realm [options]
realm setup       # Configure Claude Code hooks
realm uninstall   # Remove hooks (keeps data)
realm doctor      # Diagnose issues

Options:
  --port, -p <port>   Server port (default: 4003)
  --help, -h          Show help
  --version, -v       Show version
```

## Data Directory

Realm stores persistent data in `~/.realm/data/`:

| File              | Contents                             |
|-------------------|--------------------------------------|
| `events.jsonl`    | Hook events from Claude Code         |
| `sessions.json`   | Managed zone/session state           |
| `settings.json`   | LLM providers, IM channels           |
| `tiles.json`      | Draw mode tile state                 |
| `groups.json`     | Department groupings                 |

## Setup Guide

See [docs/SETUP.md](docs/SETUP.md) for detailed installation instructions.

## Technical Documentation

See [CLAUDE.md](CLAUDE.md) for architecture and developer reference.

## License

MIT
