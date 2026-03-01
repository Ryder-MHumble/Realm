#!/bin/bash
# Realm Hook - Captures Claude Code events for 3D visualization
#
# This script is called by Claude Code hooks and:
# 1. Reads the hook input from stdin
# 2. Transforms it into our event format
# 3. Appends to the events JSONL file
# 4. Optionally notifies the WebSocket server
#
# Installed to: ~/.realm/hooks/realm-hook.sh
# Run `npx realm setup` to install/update this hook.

set -e

# =============================================================================
# Cross-Platform PATH Setup
# Hooks may run with a minimal PATH. Add common tool locations defensively.
# =============================================================================

KNOWN_PATHS=(
  "/opt/homebrew/bin"      # macOS Apple Silicon Homebrew
  "/usr/local/bin"         # macOS Intel Homebrew / Linux local
  "$HOME/.local/bin"       # User local bin
  "/usr/bin"               # System binaries
  "/bin"                   # Core binaries
)

for dir in "${KNOWN_PATHS[@]}"; do
  [ -d "$dir" ] && export PATH="$dir:$PATH"
done

# =============================================================================
# Tool Discovery
# Find required tools, searching known locations if not in PATH
# =============================================================================

find_tool() {
  local name="$1"

  # Check PATH first
  local found=$(command -v "$name" 2>/dev/null)
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi

  # Check known locations
  for dir in "${KNOWN_PATHS[@]}"; do
    if [ -x "$dir/$name" ]; then
      echo "$dir/$name"
      return 0
    fi
  done

  return 1
}

# Find required tools
JQ=$(find_tool "jq") || {
  echo "realm-hook: ERROR - jq not found. Install it:" >&2
  echo "  macOS: brew install jq" >&2
  echo "  Linux: apt install jq (or yum install jq)" >&2
  exit 1
}

CURL=$(find_tool "curl") || {
  # curl is optional - just disable notifications if not found
  CURL=""
}

# =============================================================================
# Configuration
# =============================================================================

# IMPORTANT: Use ~/.realm/ as the data directory to ensure consistent
# location regardless of how realm was installed (npx, global npm, local dev).
REALM_DATA_DIR="${REALM_DATA_DIR:-$HOME/.realm/data}"
EVENTS_FILE="${REALM_EVENTS_FILE:-$REALM_DATA_DIR/events.jsonl}"
WS_NOTIFY_URL="${REALM_WS_NOTIFY:-http://localhost:4003/event}"
ENABLE_WS_NOTIFY="${REALM_ENABLE_WS_NOTIFY:-true}"

# Ensure data directory exists
mkdir -p "$(dirname "$EVENTS_FILE")"

# =============================================================================
# Read and Parse Input
# =============================================================================

input=$(cat)

hook_event_name=$(echo "$input" | "$JQ" -r '.hook_event_name // "unknown"')
session_id=$(echo "$input" | "$JQ" -r '.session_id // "unknown"')
cwd=$(echo "$input" | "$JQ" -r '.cwd // ""')

# Generate unique event ID and timestamp
# macOS doesn't support date +%N, so we use different approaches
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: use perl or python for milliseconds, fall back to seconds + random
  if command -v perl &> /dev/null; then
    timestamp=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000')
  elif command -v python3 &> /dev/null; then
    timestamp=$(python3 -c 'import time; print(int(time.time() * 1000))')
  else
    timestamp=$(($(date +%s) * 1000 + RANDOM % 1000))
  fi
  event_id="${session_id}-${timestamp}-${RANDOM}"
else
  # Linux: use date +%N for nanoseconds
  ms_part=$(date +%N | cut -c1-3)
  timestamp=$(($(date +%s) * 1000 + 10#$ms_part))
  event_id="${session_id}-$(date +%s%N)"
fi

# =============================================================================
# Event Type Mapping
# =============================================================================

case "$hook_event_name" in
  PreToolUse)       event_type="pre_tool_use" ;;
  PostToolUse)      event_type="post_tool_use" ;;
  Stop)             event_type="stop" ;;
  SubagentStop)     event_type="subagent_stop" ;;
  SessionStart)     event_type="session_start" ;;
  SessionEnd)       event_type="session_end" ;;
  UserPromptSubmit) event_type="user_prompt_submit" ;;
  Notification)     event_type="notification" ;;
  PreCompact)       event_type="pre_compact" ;;
  *)                event_type="unknown" ;;
esac

# =============================================================================
# Build Event JSON
# =============================================================================

case "$event_type" in
  pre_tool_use)
    tool_name=$(echo "$input" | "$JQ" -r '.tool_name // "unknown"')
    tool_input=$(echo "$input" | "$JQ" -c '.tool_input // {}')
    tool_use_id=$(echo "$input" | "$JQ" -r '.tool_use_id // ""')
    transcript_path=$(echo "$input" | "$JQ" -r '.transcript_path // ""')

    # Try to extract assistant text that came just before this tool call
    assistant_text=""
    if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
      assistant_text=$(tail -30 "$transcript_path" | \
        "$JQ" -rs '
          (to_entries | map(select(.value.type == "user")) | last | .key) as $last_user |
          to_entries | map(select(.key > ($last_user // -1))) |
          map(.value) |
          map(select(.type == "assistant")) |
          map(.message.content | map(select(.type == "text")) | map(.text)) |
          flatten | join("\n")
        ' 2>/dev/null || echo "")
    fi

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg tool "$tool_name" \
      --argjson toolInput "$tool_input" \
      --arg toolUseId "$tool_use_id" \
      --arg assistantText "$assistant_text" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        tool: $tool,
        toolInput: $toolInput,
        toolUseId: $toolUseId,
        assistantText: $assistantText
      }')
    ;;

  post_tool_use)
    tool_name=$(echo "$input" | "$JQ" -r '.tool_name // "unknown"')
    tool_input=$(echo "$input" | "$JQ" -c '.tool_input // {}')
    tool_response=$(echo "$input" | "$JQ" -c '.tool_response // {}')
    tool_use_id=$(echo "$input" | "$JQ" -r '.tool_use_id // ""')
    success=$(echo "$input" | "$JQ" -r '.tool_response.success // true')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg tool "$tool_name" \
      --argjson toolInput "$tool_input" \
      --argjson toolResponse "$tool_response" \
      --arg toolUseId "$tool_use_id" \
      --argjson success "$success" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        tool: $tool,
        toolInput: $toolInput,
        toolResponse: $toolResponse,
        toolUseId: $toolUseId,
        success: $success
      }')
    ;;

  stop|subagent_stop)
    stop_hook_active=$(echo "$input" | "$JQ" -r '.stop_hook_active // false')
    transcript_path=$(echo "$input" | "$JQ" -r '.transcript_path // ""')

    # Try to extract latest assistant response from transcript
    assistant_response=""
    if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
      assistant_response=$(tail -200 "$transcript_path" | \
        "$JQ" -rs '[.[] | select(.type == "assistant") | select(.message.content | map(select(.type == "text")) | length > 0)] | last | .message.content | map(select(.type == "text")) | map(.text) | join("\n")' 2>/dev/null || echo "")
    fi

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --argjson stopHookActive "$stop_hook_active" \
      --arg response "$assistant_response" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        stopHookActive: $stopHookActive,
        response: $response
      }')
    ;;

  session_start)
    source_type=$(echo "$input" | "$JQ" -r '.source // "startup"')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg source "$source_type" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        source: $source
      }')
    ;;

  session_end)
    reason=$(echo "$input" | "$JQ" -r '.reason // "other"')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg reason "$reason" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        reason: $reason
      }')
    ;;

  user_prompt_submit)
    prompt=$(echo "$input" | "$JQ" -r '.prompt // ""')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg prompt "$prompt" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        prompt: $prompt
      }')
    ;;

  notification)
    message=$(echo "$input" | "$JQ" -r '.message // ""')
    notification_type=$(echo "$input" | "$JQ" -r '.notification_type // "unknown"')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg message "$message" \
      --arg notificationType "$notification_type" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        message: $message,
        notificationType: $notificationType
      }')
    ;;

  pre_compact)
    trigger=$(echo "$input" | "$JQ" -r '.trigger // "manual"')
    custom_instructions=$(echo "$input" | "$JQ" -r '.custom_instructions // ""')

    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "$event_type" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --arg trigger "$trigger" \
      --arg customInstructions "$custom_instructions" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        trigger: $trigger,
        customInstructions: $customInstructions
      }')
    ;;

  *)
    # Unknown event - store raw input
    event=$("$JQ" -n -c \
      --arg id "$event_id" \
      --argjson timestamp "$timestamp" \
      --arg type "unknown" \
      --arg sessionId "$session_id" \
      --arg cwd "$cwd" \
      --argjson raw "$input" \
      '{
        id: $id,
        timestamp: $timestamp,
        type: $type,
        sessionId: $sessionId,
        cwd: $cwd,
        raw: $raw
      }')
    ;;
esac

# =============================================================================
# Output Event
# =============================================================================

# Append event to JSONL file
echo "$event" >> "$EVENTS_FILE"

# Notify WebSocket server (fire and forget, don't block Claude)
if [ "$ENABLE_WS_NOTIFY" = "true" ] && [ -n "$CURL" ]; then
  "$CURL" -s -X POST "$WS_NOTIFY_URL" \
    -H "Content-Type: application/json" \
    -d "$event" \
    --connect-timeout 1 \
    --max-time 2 \
    >/dev/null 2>&1 &
fi

exit 0
