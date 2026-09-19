#!/usr/bin/env bash
# BL26082601: local dev launcher for the iSpark Library -- a separate,
# dedicated vault instance holding the shared, always-growing track/course/
# module catalog every iSpark tenant (iScroll first) selects from.
#
# Deliberately its own store, NOT the main fleet's vault and NOT any one
# tenant's vault -- per Sconl's explicit 9 Sep 2026 call: a commercial,
# eventually-multi-creator product needs to stay off his personal data
# store, not coupled to it the way a filtered view would be.
#
# Same codebase as every other vault instance (no fork) -- isolation here
# is DATA and PORTS, same principle as dev-local-ispark-tenant.sh.
#
# Vault only, no spark/hub yet: today's catalog reads (vault/lib/
# library-sync.js) go straight at LIBRARY_MEMORY_DIR on disk from each
# tenant's own vault process, same-machine. A spark+hub pair for the
# Library becomes real scope once a creator-authoring web UI is built
# (someone editing catalog content through a browser, not this session's
# scope) -- flagged as a followup, not silently added here.
#
# Port: vault :8095 (main fleet :8081, iScroll tenant :8091 -- picked to
# stay clear of both with room for more tenants at :8101/:8111/... later).
#
# Data root: work/dev/Systems/iSconl/_tenant-data/library/ (sibling to
# every repo and to _tenant-data/ispark/, not inside any one repo).
#
# Usage: ./dev-local-library.sh [start|stop|status]

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"        # vault/
ROOT="$(cd "$HERE/.." && pwd)"                                  # iSconl/
LIB_DIR="$ROOT/_tenant-data/library"
LOG_DIR="$LIB_DIR"
PID_DIR="$LIB_DIR"
mkdir -p "$LIB_DIR/vault-memory" "$LIB_DIR/vault-logs"

if [ -f "$HOME/.bashrc.d/bitwarden.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc.d/bitwarden.sh"
fi
if [ -z "${BWS_ACCESS_TOKEN:-}" ] && [ -f "$HOME/.isconl/bws-access-token" ]; then
  BWS_ACCESS_TOKEN="$(cat "$HOME/.isconl/bws-access-token")"
  export BWS_ACCESS_TOKEN
fi
if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: BWS_ACCESS_TOKEN is not set. Cannot start the iSpark Library -- vault will boot without secrets." >&2
  exit 1
fi
export BWS_ORGANIZATION_ID="${BWS_ORGANIZATION_ID:-2d82abe1-cb42-45a0-b1cd-b438013b3f4b}"
export BWS_API_URL="${BWS_API_URL:-https://api.bitwarden.eu}"
export BWS_IDENTITY_URL="${BWS_IDENTITY_URL:-https://identity.bitwarden.eu}"
export BWS_PROJECT_ID="${BWS_PROJECT_ID:-ae96a9c3-5f66-48b7-96b2-b494009ff61b}"

VAULT_PORT=8095

start_vault() {
  local pidfile="$PID_DIR/vault.pid.txt"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile" | awk '{print $NF}')" 2>/dev/null; then
    echo "vault-library already running"
    return
  fi
  (
    cd "$ROOT/vault"
    export VAULT_BIND=127.0.0.1
    export VAULT_PORT="$VAULT_PORT"
    export VAULT_MEMORY_DIR="$LIB_DIR/vault-memory"
    export VAULT_DIFF_SYNC_STATE="$LIB_DIR/vault-logs/diff-sync-state.json"
    export EMAIL_SYNC_DISABLED=1
    if command -v setsid >/dev/null 2>&1; then
      setsid node src/server.js </dev/null >"$LOG_DIR/vault.log" 2>&1 &
    else
      nohup node src/server.js </dev/null >"$LOG_DIR/vault.log" 2>&1 &
    fi
    local p=$!
    disown "$p" 2>/dev/null || true
    echo "vault-library pid $p" > "$pidfile"
  )
  sleep 1
  echo "vault-library starting on :$VAULT_PORT, log: $LOG_DIR/vault.log"
}

stop_one() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid.txt"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(awk '{print $NF}' "$pidfile")"
    kill "$pid" 2>/dev/null && echo "$name-library stopped"
    rm -f "$pidfile"
  fi
}

status_one() {
  local name="$1" port="$2"
  local pidfile="$PID_DIR/$name.pid.txt"
  if [ -f "$pidfile" ] && kill -0 "$(awk '{print $NF}' "$pidfile")" 2>/dev/null; then
    echo "$name-library: running (port $port)"
  else
    echo "$name-library: stopped"
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start) start_vault ;;
  stop) stop_one vault ;;
  status) status_one vault "$VAULT_PORT" ;;
  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 1
    ;;
esac
