#!/bin/bash
# ─── Squarespace Helper — Start server + ngrok with auto-restart ───
#
# Usage:
#   ./scripts/start-with-ngrok.sh
#   ./scripts/start-with-ngrok.sh --domain your-static-domain.ngrok-free.dev
#
# This script:
# 1. Starts the Node.js server on port 3000
# 2. Starts ngrok tunneling to port 3000
# 3. Monitors both processes — restarts either if they die
# 4. Logs everything to logs/ directory
#
# To stop: Ctrl+C (kills both server and ngrok)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

SERVER_LOG="$LOG_DIR/server.log"
NGROK_LOG="$LOG_DIR/ngrok.log"
NGROK_DOMAIN=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      NGROK_DOMAIN="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

SERVER_PID=""
NGROK_PID=""

cleanup() {
  echo -e "\n${YELLOW}Shutting down...${NC}"
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && echo "Killed server (PID $SERVER_PID)"
  [[ -n "$NGROK_PID" ]] && kill "$NGROK_PID" 2>/dev/null && echo "Killed ngrok (PID $NGROK_PID)"
  exit 0
}

trap cleanup SIGINT SIGTERM

start_server() {
  echo -e "${GREEN}Starting server...${NC}"
  node dist/src/index.js >> "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  echo -e "${GREEN}Server started (PID $SERVER_PID)${NC}"
}

start_ngrok() {
  # Kill any existing ngrok first
  pkill -f "ngrok http" 2>/dev/null || true
  sleep 1

  echo -e "${GREEN}Starting ngrok...${NC}"
  if [[ -n "$NGROK_DOMAIN" ]]; then
    ngrok http 3000 --url="$NGROK_DOMAIN" --log=stdout >> "$NGROK_LOG" 2>&1 &
  else
    ngrok http 3000 --log=stdout >> "$NGROK_LOG" 2>&1 &
  fi
  NGROK_PID=$!
  echo -e "${GREEN}ngrok started (PID $NGROK_PID)${NC}"

  # Wait for tunnel to be ready
  sleep 3

  # Get the public URL
  local url
  url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null || echo "unknown")
  echo -e "${GREEN}ngrok URL: ${url}${NC}"

  if [[ -n "$NGROK_DOMAIN" ]]; then
    echo -e "${GREEN}Using static domain — webhook URL is stable across restarts${NC}"
  else
    echo -e "${YELLOW}⚠️  No static domain — URL changes on restart!${NC}"
    echo -e "${YELLOW}   Run with: --domain YOUR-DOMAIN.ngrok-free.dev${NC}"
    echo -e "${YELLOW}   Get a free static domain at: https://dashboard.ngrok.com/domains${NC}"
  fi
}

# ─── Initial start ───
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Squarespace Helper — Starting...${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"

start_server
start_ngrok

echo ""
echo -e "${GREEN}Both services running. Monitoring for crashes...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop both.${NC}"
echo ""

# ─── Monitor loop ───
NGROK_RESTARTS=0
SERVER_RESTARTS=0
MAX_RESTARTS=10

while true; do
  sleep 10

  # Check server
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    SERVER_RESTARTS=$((SERVER_RESTARTS + 1))
    echo -e "${RED}[$(date '+%H:%M:%S')] Server died! Restart #${SERVER_RESTARTS}${NC}"

    if [[ $SERVER_RESTARTS -ge $MAX_RESTARTS ]]; then
      echo -e "${RED}Server exceeded max restarts ($MAX_RESTARTS). Giving up.${NC}"
      cleanup
    fi

    sleep 2
    start_server
  fi

  # Check ngrok
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    NGROK_RESTARTS=$((NGROK_RESTARTS + 1))
    echo -e "${RED}[$(date '+%H:%M:%S')] ngrok died! Restart #${NGROK_RESTARTS}${NC}"

    if [[ $NGROK_RESTARTS -ge $MAX_RESTARTS ]]; then
      echo -e "${RED}ngrok exceeded max restarts ($MAX_RESTARTS). Giving up.${NC}"
      cleanup
    fi

    sleep 2
    start_ngrok
  fi
done
