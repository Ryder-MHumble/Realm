#!/bin/bash
# Realm Hooks Installer
#
# This script helps integrate Realm hooks with your Claude Code settings.
# It generates the hook configuration that you can add to your settings.json.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/realm-hook.sh"

echo "Realm Hooks Configuration Generator"
echo "======================================="
echo ""
echo "Hook script location: $HOOK_SCRIPT"
echo ""
echo "Add the following to your ~/.claude/settings.json:"
echo ""
echo "------- COPY BELOW THIS LINE -------"
cat << EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "Stop": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ],
    "Notification": [
      {
        "hooks": [{"type": "command", "command": "$HOOK_SCRIPT", "timeout": 5}]
      }
    ]
  }
}
EOF
echo ""
echo "------- COPY ABOVE THIS LINE -------"
echo ""
echo "If you already have hooks configured, merge the above with your existing config."
echo ""
echo "Environment variables you can set:"
echo "  REALM_DIR           - Base directory (default: ~/realm)"
echo "  REALM_EVENTS_FILE   - Events file path (default: \$REALM_DIR/data/events.jsonl)"
echo "  REALM_WS_NOTIFY     - WebSocket notify URL (default: http://localhost:4003/event)"
echo "  REALM_ENABLE_WS_NOTIFY - Enable WebSocket notifications (default: true)"
