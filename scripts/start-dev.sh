#!/bin/bash
# Start claude-code-proxy + tsx watch for development (no ngrok)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
PROXY_LOG="$LOG_DIR/proxy.log"

PROXY_PID=""
SERVER_PID=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

cleanup() {
  echo -e "\n${YELLOW}Shutting down...${NC}"
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null && echo "Killed proxy (PID $PROXY_PID)"
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && echo "Killed dev server (PID $SERVER_PID)"
  exit 0
}

trap cleanup SIGINT SIGTERM

start_proxy() {
  if lsof -i :42069 -sTCP:LISTEN -t &>/dev/null; then
    echo -e "${YELLOW}Proxy already running on :42069 — skipping${NC}"
    return
  fi
  echo -e "${GREEN}Starting claude-code-proxy...${NC}"
  node "$HOME/claude-code-proxy/server/server.js" >> "$PROXY_LOG" 2>&1 &
  PROXY_PID=$!
  local attempts=0
  while [[ $attempts -lt 20 ]]; do
    if curl -sf http://localhost:42069/health &>/dev/null; then
      echo -e "${GREEN}Proxy ready (PID $PROXY_PID)${NC}"
      return
    fi
    sleep 0.5
    attempts=$((attempts + 1))
  done
  echo -e "${RED}Proxy didn't become ready in 10s — check $PROXY_LOG${NC}"
}

start_server() {
  echo -e "${GREEN}Starting dev server (tsx watch)...${NC}"
  npx tsx watch src/index.ts &
  SERVER_PID=$!
  echo -e "${GREEN}Dev server started (PID $SERVER_PID)${NC}"
}

echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Squarespace Helper — Dev mode${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"

start_proxy
start_server

echo ""
echo -e "${GREEN}Dev environment running. Ctrl+C to stop.${NC}"
echo ""

while true; do
  sleep 10
  if [[ -n "$PROXY_PID" ]] && ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo -e "${RED}[$(date '+%H:%M:%S')] Proxy died — restarting${NC}"
    start_proxy
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${RED}[$(date '+%H:%M:%S')] Dev server died — restarting${NC}"
    start_server
  fi
done
