#!/bin/bash
# Realm — start / stop / status
# Usage: ./scripts/Realm.sh [start|stop|status]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLIENT_PORT=${REALM_CLIENT_PORT:-4002}
SERVER_PORT=${REALM_PORT:-4003}
TMUX_SESSION="realm-dev"

# ═══════════════════════════════════════════════
#  start
# ═══════════════════════════════════════════════
cmd_start() {
  cd "$PROJECT_DIR"

  echo ""
  echo -e "${CYAN}  Realm Start${NC}"
  echo -e "${DIM}  ───────────────${NC}"
  echo ""

  # 1. Check dependencies
  check_dep() {
    if ! command -v "$1" &>/dev/null; then
      echo -e "${RED}  ✗ $1 not found.${NC} $2"
      exit 1
    fi
  }
  check_dep node  "Install: https://nodejs.org"
  check_dep npm   "Comes with Node.js"
  check_dep jq    "Install: brew install jq"
  check_dep tmux  "Install: brew install tmux"

  # 2. Install node_modules if missing
  if [ ! -d "node_modules" ]; then
    echo -e "  Installing dependencies..."
    npm install --silent
    echo ""
  fi

  # 3. Kill stale processes on our ports
  kill_port() {
    local port=$1
    local pids=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo -e "  ${DIM}Killing stale process on port $port (PID: $pids)${NC}"
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 0.3
    fi
  }
  kill_port $CLIENT_PORT
  kill_port $SERVER_PORT

  # 4. Ensure data directory
  mkdir -p ~/.realm/data

  # 5. Start in tmux
  DEV_CMD="npm"
  DEV_CMD="$DEV_CMD run"
  DEV_CMD="$DEV_CMD dev"

  tmux kill-session -t $TMUX_SESSION 2>/dev/null || true
  tmux new-session -d -s $TMUX_SESSION -c "$PROJECT_DIR" "$DEV_CMD"

  # 6. Wait for server ready
  echo -e "  Starting servers..."
  for i in $(seq 1 30); do
    if curl -s -m 1 "http://localhost:$SERVER_PORT/health" 2>/dev/null | grep -q ok; then
      break
    fi
    sleep 0.5
  done

  # 7. Report
  if curl -s -m 1 "http://localhost:$SERVER_PORT/health" 2>/dev/null | grep -q ok; then
    echo ""
    echo -e "  ${GREEN}✓ Realm is running${NC}"
    echo ""
    echo -e "    Frontend   ${CYAN}http://localhost:$CLIENT_PORT${NC}"
    echo -e "    API        ${CYAN}http://localhost:$SERVER_PORT${NC}"
    echo -e "    tmux       ${DIM}tmux attach -t $TMUX_SESSION${NC}"
    echo ""
    echo -e "  ${DIM}Stop with: ./scripts/Realm.sh stop${NC}"
  else
    echo ""
    echo -e "  ${RED}✗ Server did not start in time.${NC}"
    echo -e "    Check logs: tmux attach -t $TMUX_SESSION"
    exit 1
  fi
  echo ""
}

# ═══════════════════════════════════════════════
#  stop
# ═══════════════════════════════════════════════
cmd_stop() {
  echo ""
  echo -e "${CYAN}  Realm Stop${NC}"
  echo -e "${DIM}  ──────────────${NC}"
  echo ""

  KILLED=0

  # 1. Kill realm dev tmux session
  if tmux has-session -t $TMUX_SESSION 2>/dev/null; then
    tmux kill-session -t $TMUX_SESSION
    echo -e "  ${DIM}✓ Killed tmux session: $TMUX_SESSION${NC}"
    ((KILLED++)) || true
  fi

  # 2. Kill managed realm tmux sessions
  REALM_SESSIONS=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^realm-' || true)
  if [ -n "$REALM_SESSIONS" ]; then
    while IFS= read -r sess; do
      tmux kill-session -t "$sess" 2>/dev/null || true
      echo -e "  ${DIM}✓ Killed tmux session: $sess${NC}"
      ((KILLED++)) || true
    done <<< "$REALM_SESSIONS"
  fi

  # 3. Kill processes on realm ports
  kill_port() {
    local port=$1
    local pids=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
      echo -e "  ${DIM}✓ Freed port $port (PID: $pids)${NC}"
      ((KILLED++)) || true
    fi
  }
  kill_port $CLIENT_PORT
  kill_port $SERVER_PORT

  # 4. Kill remaining realm node processes
  VIBE_PIDS=$(pgrep -f "realm.*server|vite.*realm" 2>/dev/null || true)
  if [ -n "$VIBE_PIDS" ]; then
    echo "$VIBE_PIDS" | xargs kill -9 2>/dev/null || true
    echo -e "  ${DIM}✓ Killed remaining node processes${NC}"
    ((KILLED++)) || true
  fi

  # 5. Report
  echo ""
  if [ $KILLED -gt 0 ]; then
    echo -e "  ${GREEN}✓ Cleaned up $KILLED item(s)${NC}"
  else
    echo -e "  ${DIM}  Nothing to clean up — Realm wasn't running${NC}"
  fi

  # 6. Verify ports are free
  echo ""
  STILL_BUSY=0
  for port in $CLIENT_PORT $SERVER_PORT; do
    if lsof -ti :$port &>/dev/null; then
      echo -e "  ${RED}✗ Port $port still in use${NC}"
      STILL_BUSY=1
    fi
  done

  if [ $STILL_BUSY -eq 0 ]; then
    echo -e "  ${GREEN}✓ Ports $CLIENT_PORT and $SERVER_PORT are free${NC}"
  fi
  echo ""
}

# ═══════════════════════════════════════════════
#  status
# ═══════════════════════════════════════════════
cmd_status() {
  echo ""
  echo -e "${CYAN}  Realm Status${NC}"
  echo -e "${DIM}  ────────────────${NC}"
  echo ""

  # Server health
  if curl -s -m 1 "http://localhost:$SERVER_PORT/health" 2>/dev/null | grep -q ok; then
    echo -e "  ${GREEN}●${NC} Server    ${CYAN}http://localhost:$SERVER_PORT${NC}"
  else
    echo -e "  ${RED}●${NC} Server    offline"
  fi

  # Client
  if curl -s -m 1 "http://localhost:$CLIENT_PORT" &>/dev/null; then
    echo -e "  ${GREEN}●${NC} Frontend  ${CYAN}http://localhost:$CLIENT_PORT${NC}"
  else
    echo -e "  ${RED}●${NC} Frontend  offline"
  fi

  # tmux session
  if tmux has-session -t $TMUX_SESSION 2>/dev/null; then
    echo -e "  ${GREEN}●${NC} tmux      ${DIM}$TMUX_SESSION${NC}"
  else
    echo -e "  ${RED}●${NC} tmux      no session"
  fi

  echo ""
}

# ═══════════════════════════════════════════════
#  main — route subcommand
# ═══════════════════════════════════════════════
case "${1:-start}" in
  start)  cmd_start  ;;
  stop)   cmd_stop   ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    echo ""
    echo "  start   Start Realm dev servers (default)"
    echo "  stop    Stop all Realm processes"
    echo "  status  Check if Realm is running"
    exit 1
    ;;
esac
