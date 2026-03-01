#!/bin/bash
# Realm Plugin Installer
# This script sets up Realm as a Claude Code plugin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

echo "Installing Realm..."

# Check dependencies
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Error: npm is required but not installed."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq is required but not installed."; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required but not installed."; exit 1; }

# Install npm dependencies
echo "Installing dependencies..."
cd "$PLUGIN_DIR"
npm install

# Create data directory
mkdir -p "$PLUGIN_DIR/data"

# Make hook script executable
chmod +x "$PLUGIN_DIR/hooks/realm-hook.sh"

# Check if Claude Code settings file exists
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

if [ -f "$CLAUDE_SETTINGS" ]; then
  echo ""
  echo "Found existing Claude Code settings at: $CLAUDE_SETTINGS"
  echo ""
  echo "To enable Realm hooks, add this to your settings.json hooks section:"
  echo ""
  cat << 'EOF'
{
  "hooks": {
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/realm/hooks/realm-hook.sh"}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/path/to/realm/hooks/realm-hook.sh"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "/path/to/realm/hooks/realm-hook.sh"}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/path/to/realm/hooks/realm-hook.sh"}]}]
  }
}
EOF
  echo ""
  echo "Replace /path/to/realm with: $PLUGIN_DIR"
else
  echo "Creating Claude Code settings directory..."
  mkdir -p "$HOME/.claude"
fi

echo ""
echo "Installation complete!"
echo ""
echo "To start Realm:"
echo "  cd $PLUGIN_DIR && npm run dev"
echo ""
echo "Then open http://localhost:4002 in your browser."
