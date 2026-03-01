#!/bin/bash
#
# Realm macOS Diagnostic Script
# Run this to identify why Realm isn't working on macOS
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
ERRORS=0
WARNINGS=0

error() {
  echo -e "${RED}[ERROR]${NC} $1"
  ((ERRORS++)) || true
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
  ((WARNINGS++)) || true
}

ok() {
  echo -e "${GREEN}[OK]${NC} $1"
}

info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

section() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║         REALM macOS DIAGNOSTIC SCRIPT                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# ==============================================================================
section "1. SYSTEM INFORMATION"
# ==============================================================================

info "Hostname: $(hostname)"
info "User: $(whoami)"
info "Home: $HOME"
info "Shell: $SHELL"
info "Date: $(date)"

echo ""
info "OS Details:"
sw_vers 2>/dev/null || uname -a

echo ""
info "Architecture:"
uname -m

echo ""
info "OSTYPE variable: $OSTYPE"

# ==============================================================================
section "2. REQUIRED DEPENDENCIES"
# ==============================================================================

# Check jq
echo ""
echo "Checking jq (CRITICAL - required for hook)..."
if command -v jq &> /dev/null; then
  JQ_PATH=$(which jq)
  JQ_VERSION=$(jq --version 2>&1)
  ok "jq found: $JQ_PATH ($JQ_VERSION)"
else
  error "jq NOT FOUND - hook will completely fail!"
  echo "  Install with: brew install jq"
fi

# Check tmux
echo ""
echo "Checking tmux (CRITICAL - required for sessions)..."
if command -v tmux &> /dev/null; then
  TMUX_PATH=$(which tmux)
  TMUX_VERSION=$(tmux -V 2>&1)
  ok "tmux found: $TMUX_PATH ($TMUX_VERSION)"

  # List tmux sessions
  echo "  Active tmux sessions:"
  tmux list-sessions 2>/dev/null | sed 's/^/    /' || echo "    (no sessions running)"
else
  error "tmux NOT FOUND - session management won't work!"
  echo "  Install with: brew install tmux"
fi

# Check curl
echo ""
echo "Checking curl..."
if command -v curl &> /dev/null; then
  CURL_PATH=$(which curl)
  ok "curl found: $CURL_PATH"
else
  error "curl NOT FOUND - hook won't be able to notify server"
fi

# Check node
echo ""
echo "Checking Node.js..."
if command -v node &> /dev/null; then
  NODE_PATH=$(which node)
  NODE_VERSION=$(node --version 2>&1)
  ok "node found: $NODE_PATH ($NODE_VERSION)"
else
  error "node NOT FOUND - server won't run"
fi

# Check npm
echo ""
echo "Checking npm..."
if command -v npm &> /dev/null; then
  NPM_PATH=$(which npm)
  NPM_VERSION=$(npm --version 2>&1)
  ok "npm found: $NPM_PATH ($NPM_VERSION)"
else
  warn "npm NOT FOUND"
fi

# ==============================================================================
section "3. TIMESTAMP GENERATION (macOS-specific)"
# ==============================================================================

echo ""
echo "Testing timestamp methods..."

# Method 1: perl (preferred on macOS)
echo ""
echo "Method 1: Perl Time::HiRes"
if command -v perl &> /dev/null; then
  PERL_TS=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000' 2>&1)
  if [[ "$PERL_TS" =~ ^[0-9]+$ ]]; then
    ok "Perl timestamp works: $PERL_TS"
  else
    warn "Perl timestamp failed: $PERL_TS"
  fi
else
  warn "perl not found"
fi

# Method 2: python3
echo ""
echo "Method 2: Python3"
if command -v python3 &> /dev/null; then
  PY_TS=$(python3 -c 'import time; print(int(time.time() * 1000))' 2>&1)
  if [[ "$PY_TS" =~ ^[0-9]+$ ]]; then
    ok "Python3 timestamp works: $PY_TS"
  else
    warn "Python3 timestamp failed: $PY_TS"
  fi
else
  warn "python3 not found"
fi

# Method 3: date +%N (should fail on macOS)
echo ""
echo "Method 3: date +%N (expected to fail on macOS)"
DATE_N=$(date +%N 2>&1)
if [[ "$DATE_N" == "N" || "$DATE_N" == "%N" ]]; then
  info "date +%N not supported (expected on macOS): '$DATE_N'"
else
  info "date +%N output: $DATE_N"
fi

# ==============================================================================
section "4. PATH CONFIGURATION"
# ==============================================================================

echo ""
info "Current PATH:"
echo "$PATH" | tr ':' '\n' | head -20 | sed 's/^/  /'
if [ $(echo "$PATH" | tr ':' '\n' | wc -l) -gt 20 ]; then
  echo "  ... (truncated)"
fi

echo ""
echo "Checking important directories in PATH..."

# Homebrew (Apple Silicon)
if [ -d "/opt/homebrew/bin" ]; then
  ok "/opt/homebrew/bin exists (Apple Silicon Homebrew)"
  if echo "$PATH" | grep -q "/opt/homebrew/bin"; then
    ok "  └── In PATH"
  else
    warn "  └── NOT in PATH"
  fi
else
  info "/opt/homebrew/bin not present (Intel Mac or no Homebrew)"
fi

# Homebrew (Intel)
if [ -d "/usr/local/bin" ]; then
  ok "/usr/local/bin exists"
  if echo "$PATH" | grep -q "/usr/local/bin"; then
    ok "  └── In PATH"
  else
    warn "  └── NOT in PATH"
  fi
fi

# User local bin
if [ -d "$HOME/.local/bin" ]; then
  ok "$HOME/.local/bin exists"
  if echo "$PATH" | grep -q "$HOME/.local/bin"; then
    ok "  └── In PATH"
  else
    warn "  └── NOT in PATH (Claude CLI might not be found)"
  fi
else
  info "$HOME/.local/bin not present"
fi

# ==============================================================================
section "5. CLAUDE CODE"
# ==============================================================================

echo ""
echo "Checking Claude CLI..."
if command -v claude &> /dev/null; then
  CLAUDE_PATH=$(which claude)
  ok "claude found: $CLAUDE_PATH"

  # Try to get version
  echo "  Attempting to get version..."
  CLAUDE_VERSION=$(timeout 5 claude --version 2>&1 || echo "timeout/error")
  echo "  Version output: $CLAUDE_VERSION"
else
  error "claude NOT FOUND in PATH"
  echo "  Searching common locations..."
  for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude"; do
    if [ -f "$loc" ]; then
      warn "  Found at $loc but not in PATH"
    fi
  done
fi

# Check Claude settings
echo ""
echo "Checking Claude settings..."
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  ok "Settings file exists: $CLAUDE_SETTINGS"

  echo ""
  info "Settings file contents:"
  cat "$CLAUDE_SETTINGS" | head -50

  # Check for hooks
  echo ""
  echo "Checking for Realm hooks in settings..."
  if grep -q "realm" "$CLAUDE_SETTINGS" 2>/dev/null; then
    ok "Realm hooks found in settings"
    echo ""
    info "Hook configuration:"
    grep -A5 -B2 "realm" "$CLAUDE_SETTINGS" | head -30
  else
    warn "No Realm hooks found in settings"
    echo "  Run 'realm setup' to configure hooks"
  fi
else
  warn "Claude settings file not found: $CLAUDE_SETTINGS"
fi

# ==============================================================================
section "6. REALM DATA DIRECTORY"
# ==============================================================================

REALM_DATA="$HOME/.realm/data"

echo ""
echo "Checking Realm data directory..."
if [ -d "$REALM_DATA" ]; then
  ok "Data directory exists: $REALM_DATA"

  echo ""
  info "Directory contents:"
  ls -la "$REALM_DATA" 2>/dev/null | sed 's/^/  /'

  echo ""
  info "Directory permissions:"
  # macOS uses different stat flags
  if [[ "$OSTYPE" == "darwin"* ]]; then
    stat -f "  Mode: %Sp  Owner: %Su  Group: %Sg" "$REALM_DATA" 2>/dev/null || ls -ld "$REALM_DATA"
  else
    stat -c "  Mode: %A  Owner: %U  Group: %G" "$REALM_DATA" 2>/dev/null || ls -ld "$REALM_DATA"
  fi

  # Check events.jsonl
  echo ""
  EVENTS_FILE="$REALM_DATA/events.jsonl"
  if [ -f "$EVENTS_FILE" ]; then
    EVENT_COUNT=$(wc -l < "$EVENTS_FILE" | tr -d ' ')
    EVENT_SIZE=$(ls -lh "$EVENTS_FILE" | awk '{print $5}')
    ok "events.jsonl exists ($EVENT_COUNT lines, $EVENT_SIZE)"

    echo ""
    info "Last 5 events:"
    tail -5 "$EVENTS_FILE" 2>/dev/null | while read line; do
      echo "  $line" | cut -c1-100
      if [ ${#line} -gt 100 ]; then echo "    ..."; fi
    done

    # Check if events are recent
    if [ -f "$EVENTS_FILE" ]; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        LAST_MOD=$(stat -f %m "$EVENTS_FILE" 2>/dev/null)
      else
        LAST_MOD=$(stat -c %Y "$EVENTS_FILE" 2>/dev/null)
      fi
      NOW=$(date +%s)
      AGE=$((NOW - LAST_MOD))
      if [ $AGE -lt 300 ]; then
        ok "Events file modified recently (${AGE}s ago)"
      elif [ $AGE -lt 3600 ]; then
        info "Events file modified $(($AGE / 60)) minutes ago"
      else
        warn "Events file last modified $(($AGE / 3600)) hours ago"
      fi
    fi
  else
    warn "events.jsonl not found (no events recorded yet)"
  fi

  # Check sessions.json
  echo ""
  SESSIONS_FILE="$REALM_DATA/sessions.json"
  if [ -f "$SESSIONS_FILE" ]; then
    ok "sessions.json exists"
    info "Contents:"
    cat "$SESSIONS_FILE" | head -30 | sed 's/^/  /'
  else
    info "sessions.json not found (no managed sessions yet)"
  fi

else
  warn "Data directory not found: $REALM_DATA"
  echo "  Will be created when hook first runs"

  # Check parent directory
  if [ -d "$HOME/.realm" ]; then
    info "Parent .realm directory exists"
    ls -la "$HOME/.realm" | sed 's/^/  /'
  fi
fi

# ==============================================================================
section "7. HOOK SCRIPT TEST"
# ==============================================================================

echo ""
echo "Looking for hook script..."

# Common locations
HOOK_LOCATIONS=(
  "$HOME/.realm/hooks/realm-hook.sh"
  "/usr/local/share/realm/hooks/realm-hook.sh"
  "/opt/homebrew/share/realm/hooks/realm-hook.sh"
)

# Also check from Claude settings
if [ -f "$CLAUDE_SETTINGS" ]; then
  SETTINGS_HOOK=$(grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*realm[^"]*"' "$CLAUDE_SETTINGS" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"/\1/')
  if [ -n "$SETTINGS_HOOK" ]; then
    HOOK_LOCATIONS+=("$SETTINGS_HOOK")
  fi
fi

HOOK_FOUND=""
for loc in "${HOOK_LOCATIONS[@]}"; do
  if [ -f "$loc" ]; then
    HOOK_FOUND="$loc"
    ok "Hook script found: $loc"
    break
  fi
done

if [ -z "$HOOK_FOUND" ]; then
  # Try to find it anywhere
  echo "  Searching for hook script..."
  FOUND_HOOKS=$(find /usr /opt "$HOME" -name "realm-hook.sh" 2>/dev/null | head -5)
  if [ -n "$FOUND_HOOKS" ]; then
    warn "Hook script found in unexpected location(s):"
    echo "$FOUND_HOOKS" | sed 's/^/    /'
    HOOK_FOUND=$(echo "$FOUND_HOOKS" | head -1)
  else
    error "Hook script not found anywhere!"
  fi
fi

if [ -n "$HOOK_FOUND" ]; then
  echo ""
  info "Hook script details:"
  ls -la "$HOOK_FOUND" | sed 's/^/  /'

  # Check if executable
  if [ -x "$HOOK_FOUND" ]; then
    ok "Hook is executable"
  else
    error "Hook is NOT executable!"
    echo "  Fix with: chmod +x '$HOOK_FOUND'"
  fi

  # Test the hook with mock input
  echo ""
  echo "Testing hook with mock event..."
  MOCK_EVENT='{"hook_event_name":"PreToolUse","session_id":"test-diag","tool_name":"Read","tool_input":{"file_path":"/tmp/test"},"tool_use_id":"test-123","cwd":"/tmp","transcript_path":""}'

  echo "  Input: $MOCK_EVENT"
  echo ""

  # Ensure data dir exists for test
  mkdir -p "$REALM_DATA"

  # Run the hook (use gtimeout on macOS if available, otherwise skip timeout)
  if command -v gtimeout &> /dev/null; then
    HOOK_OUTPUT=$(echo "$MOCK_EVENT" | gtimeout 10 "$HOOK_FOUND" 2>&1)
    HOOK_EXIT=$?
  elif command -v timeout &> /dev/null; then
    HOOK_OUTPUT=$(echo "$MOCK_EVENT" | timeout 10 "$HOOK_FOUND" 2>&1)
    HOOK_EXIT=$?
  else
    HOOK_OUTPUT=$(echo "$MOCK_EVENT" | "$HOOK_FOUND" 2>&1)
    HOOK_EXIT=$?
  fi

  if [ $HOOK_EXIT -eq 0 ]; then
    ok "Hook executed successfully (exit code 0)"
  else
    error "Hook failed with exit code $HOOK_EXIT"
    if [ -n "$HOOK_OUTPUT" ]; then
      echo "  Output: $HOOK_OUTPUT"
    fi
  fi

  # Check if event was written
  if [ -f "$REALM_DATA/events.jsonl" ]; then
    LAST_EVENT=$(tail -1 "$REALM_DATA/events.jsonl")
    if echo "$LAST_EVENT" | grep -q "test-diag"; then
      ok "Test event was written to events.jsonl"
      info "Event: $(echo "$LAST_EVENT" | cut -c1-100)..."
    else
      warn "Test event not found in events.jsonl (last event has different session_id)"
    fi
  fi
fi

# ==============================================================================
section "8. SERVER CONNECTIVITY"
# ==============================================================================

echo ""
echo "Checking if Realm server is running..."

SERVER_PORT="${REALM_PORT:-4003}"

# Check health endpoint
HEALTH_RESPONSE=$(curl -s -m 5 "http://localhost:$SERVER_PORT/health" 2>&1)
CURL_EXIT=$?

if [ $CURL_EXIT -eq 0 ] && echo "$HEALTH_RESPONSE" | grep -q '"ok"'; then
  ok "Server is running on port $SERVER_PORT"
  info "Health response: $HEALTH_RESPONSE"

  # Get stats
  echo ""
  STATS_RESPONSE=$(curl -s -m 5 "http://localhost:$SERVER_PORT/stats" 2>&1)
  if [ -n "$STATS_RESPONSE" ]; then
    info "Server stats: $STATS_RESPONSE"
  fi

  # Get sessions
  echo ""
  SESSIONS_RESPONSE=$(curl -s -m 5 "http://localhost:$SERVER_PORT/sessions" 2>&1)
  if [ -n "$SESSIONS_RESPONSE" ]; then
    info "Sessions: $SESSIONS_RESPONSE"
  fi
else
  warn "Server not responding on port $SERVER_PORT"
  echo "  curl exit code: $CURL_EXIT"
  echo "  response: $HEALTH_RESPONSE"

  # Check if port is in use
  echo ""
  echo "  Checking what's on port $SERVER_PORT..."
  lsof -i :$SERVER_PORT 2>/dev/null | head -5 | sed 's/^/    /' || echo "    (nothing or no permission)"
fi

# ==============================================================================
section "9. NETWORK & FIREWALL"
# ==============================================================================

echo ""
echo "Checking localhost connectivity..."

# Test localhost
if ping -c 1 -W 1 localhost &> /dev/null; then
  ok "localhost is reachable"
else
  warn "localhost ping failed (might be normal)"
fi

# Test 127.0.0.1
if ping -c 1 -W 1 127.0.0.1 &> /dev/null; then
  ok "127.0.0.1 is reachable"
else
  warn "127.0.0.1 ping failed"
fi

# Check /etc/hosts
echo ""
info "/etc/hosts localhost entries:"
grep -E "localhost|127.0.0.1" /etc/hosts 2>/dev/null | sed 's/^/  /'

# ==============================================================================
section "10. PROCESS CHECK"
# ==============================================================================

echo ""
echo "Looking for Realm-related processes..."

echo ""
info "Node processes:"
ps aux | grep -E "[n]ode.*realm|[t]sx.*realm" | sed 's/^/  /' || echo "  (none found)"

echo ""
info "tmux processes:"
ps aux | grep "[t]mux" | sed 's/^/  /' || echo "  (none found)"

echo ""
info "Claude processes:"
ps aux | grep "[c]laude" | head -10 | sed 's/^/  /' || echo "  (none found)"

# ==============================================================================
section "11. ENVIRONMENT VARIABLES"
# ==============================================================================

echo ""
info "Realm-related environment variables:"

for var in REALM_PORT REALM_EVENTS_FILE REALM_SESSIONS_FILE REALM_DATA_DIR REALM_DEBUG REALM_TMUX_SESSION REALM_ENABLE_WS_NOTIFY; do
  val="${!var}"
  if [ -n "$val" ]; then
    echo "  $var=$val"
  else
    echo "  $var=(not set)"
  fi
done

# ==============================================================================
section "12. FILE PERMISSIONS"
# ==============================================================================

echo ""
echo "Checking file permissions..."

check_perms() {
  local path="$1"
  local desc="$2"
  if [ -e "$path" ]; then
    perms=$(ls -la "$path" | head -1)
    echo "  $desc: $perms"

    # Check if writable
    if [ -w "$path" ]; then
      echo "    └── Writable: YES"
    else
      warn "    └── Writable: NO"
    fi
  else
    echo "  $desc: (not found)"
  fi
}

check_perms "$HOME/.realm" ".realm directory"
check_perms "$HOME/.realm/data" "data directory"
check_perms "$HOME/.realm/data/events.jsonl" "events.jsonl"
check_perms "$HOME/.claude" ".claude directory"
check_perms "$HOME/.claude/settings.json" "Claude settings"

# ==============================================================================
section "13. WRITE TEST"
# ==============================================================================

echo ""
echo "Testing write capabilities..."

TEST_DIR="$HOME/.realm/data"
TEST_FILE="$TEST_DIR/.diag-test-$$"

mkdir -p "$TEST_DIR" 2>/dev/null

if echo "test write $(date)" > "$TEST_FILE" 2>/dev/null; then
  ok "Can write to data directory"
  rm -f "$TEST_FILE"
else
  error "Cannot write to data directory!"
fi

# ==============================================================================
section "14. NPX/NPM REALM CHECK"
# ==============================================================================

echo ""
echo "Checking npx realm installation..."

# Check if realm is installed globally
if command -v realm &> /dev/null; then
  REALM_PATH=$(which realm)
  ok "realm command found: $REALM_PATH"
else
  info "realm not installed globally"
fi

# Check npm cache for npx
echo ""
info "npm cache location:"
npm config get cache 2>/dev/null | sed 's/^/  /'

# Check if there's a local package.json with realm
if [ -f "package.json" ]; then
  if grep -q "realm" package.json 2>/dev/null; then
    ok "realm found in local package.json"
  fi
fi

# ==============================================================================
section "15. CURL POST TEST TO SERVER"
# ==============================================================================

echo ""
echo "Testing event POST to server..."

if [ $CURL_EXIT -eq 0 ]; then
  TEST_POST_EVENT='{"id":"diag-post-test","timestamp":'$(date +%s)'000,"type":"notification","sessionId":"diag","cwd":"/tmp","message":"diagnostic test"}'

  POST_RESPONSE=$(curl -s -m 5 -X POST "http://localhost:$SERVER_PORT/event" \
    -H "Content-Type: application/json" \
    -d "$TEST_POST_EVENT" 2>&1)

  if echo "$POST_RESPONSE" | grep -q '"ok"'; then
    ok "POST to /event succeeded"
    info "Response: $POST_RESPONSE"
  else
    warn "POST to /event failed"
    echo "  Response: $POST_RESPONSE"
  fi
else
  info "Skipping POST test (server not running)"
fi

# ==============================================================================
section "SUMMARY"
# ==============================================================================

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                      DIAGNOSTIC SUMMARY                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}ERRORS: $ERRORS${NC}"
else
  echo -e "${GREEN}ERRORS: 0${NC}"
fi

if [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}WARNINGS: $WARNINGS${NC}"
else
  echo -e "${GREEN}WARNINGS: 0${NC}"
fi

echo ""

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}⚠️  There are critical errors that need to be fixed!${NC}"
  echo ""
  echo "Common fixes:"
  echo "  • Install jq:    brew install jq"
  echo "  • Install tmux:  brew install tmux"
  echo "  • Setup hooks:   npx realm setup"
  echo "  • Start server:  npx realm (or npm run dev)"
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚡ There are some warnings to review.${NC}"
else
  echo -e "${GREEN}✅ Everything looks good!${NC}"
fi

echo ""
echo "Diagnostic completed at $(date)"
echo ""
