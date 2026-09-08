#!/usr/bin/env bash
# BL26082601 (E): local dev launcher for iSpark's dedicated tenant stack --
# a separate `vault`+`spark` pair, own ports, own on-disk memory dir, from
# the main isconl fleet's own vault (:8081)/spark (:8085) started by
# hub/scripts/dev-local.sh. This is the "second set of ports, run locally"
# instance the row's tenant-isolation decision calls for -- NOT deployed to
# the shared production OCI VM (that stays a flagged follow-up; see
# BL26082601's status note in _next/backlog/build.md).
#
# Same codebase as the main fleet's vault/spark (no fork, no duplicated
# source) -- isolation here is about DATA and PORTS, not code. Same
# BWS_* secrets bootstrap as hub/scripts/dev-local.sh (both instances read
# the same Bitwarden project; a tenant vault does not need its own secret
# store to be data-isolated -- it needs its own VAULT_MEMORY_DIR, which is
# what actually holds the tenant's data).
#
# Ports: vault :8091, spark :8092 (main fleet uses :8081/:8085 -- +10 offset,
# picked to avoid any collision with a main-fleet instance running at the
# same time on the same machine).
#
# Data root: work/dev/Systems/iSconl/_tenant-data/ispark/ (sibling to every
# repo, not inside any one repo -- matches the manual run this same
# directory already shows evidence of, 27 Aug 2026: vault-memory/,
# vault-logs/, spark-logs/, vault.log, spark.log, vault.pid.txt).
#
# OneDrive: NOT wired up yet for this tenant (no Graph/OAuth app
# registration done for "iSpark" specifically) -- VAULT_SYNC_INTERVAL_MS
# is left unset here (sync disabled) until that's set up; see
# vault/src/server.js's own comment on the /profile/photo route for the
# same open item. Flagged, not silently built.
#
# Usage: ./dev-local-ispark-tenant.sh [start|stop|status]

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"        # vault/
ROOT="$(cd "$HERE/.." && pwd)"                                  # iSconl/
TENANT_DIR="$ROOT/_tenant-data/ispark"
LOG_DIR="$TENANT_DIR"
PID_DIR="$TENANT_DIR"
mkdir -p "$TENANT_DIR/vault-memory" "$TENANT_DIR/vault-logs" "$TENANT_DIR/spark-logs" "$TENANT_DIR/spark-learning" "$TENANT_DIR/spark-articles"

# Secrets -- identical bootstrap to hub/scripts/dev-local.sh (see that
# file's own comment for the incident this guards against).
if [ -f "$HOME/.bashrc.d/bitwarden.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc.d/bitwarden.sh"
fi
if [ -z "${BWS_ACCESS_TOKEN:-}" ] && [ -f "$HOME/.isconl/bws-access-token" ]; then
  BWS_ACCESS_TOKEN="$(cat "$HOME/.isconl/bws-access-token")"
  export BWS_ACCESS_TOKEN
fi
if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: BWS_ACCESS_TOKEN is not set. Cannot start the iSpark tenant stack -- vault will boot without secrets." >&2
  exit 1
fi
export BWS_ORGANIZATION_ID="${BWS_ORGANIZATION_ID:-2d82abe1-cb42-45a0-b1cd-b438013b3f4b}"
export BWS_API_URL="${BWS_API_URL:-https://api.bitwarden.eu}"
export BWS_IDENTITY_URL="${BWS_IDENTITY_URL:-https://identity.bitwarden.eu}"
export BWS_PROJECT_ID="${BWS_PROJECT_ID:-ae96a9c3-5f66-48b7-96b2-b494009ff61b}"

VAULT_PORT=8091
SPARK_PORT=8092

start_vault() {
  local pidfile="$PID_DIR/vault.pid.txt"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile" | awk '{print $NF}')" 2>/dev/null; then
    echo "vault-ispark already running"
    return
  fi
  (
    cd "$ROOT/vault"
    export VAULT_BIND=127.0.0.1
    export VAULT_PORT="$VAULT_PORT"
    export VAULT_MEMORY_DIR="$TENANT_DIR/vault-memory"
    export VAULT_DIFF_SYNC_STATE="$TENANT_DIR/vault-logs/diff-sync-state.json"
    # OneDrive/Gmail sync intentionally left off -- see header comment. Gmail
    # sync in particular must stay off here: this tenant has no OAuth
    # identity of its own, so an enabled sync would pull the SAME Bitwarden-
    # sourced Gmail token the main fleet uses into a tenant store that is
    # supposed to be isolated, which is not what "own VAULT_MEMORY_DIR" is
    # for.
    export EMAIL_SYNC_DISABLED=1
    if command -v setsid >/dev/null 2>&1; then
      setsid node src/server.js </dev/null >"$LOG_DIR/vault.log" 2>&1 &
    else
      nohup node src/server.js </dev/null >"$LOG_DIR/vault.log" 2>&1 &
    fi
    local p=$!
    disown "$p" 2>/dev/null || true
    echo "vault-ispark pid $p" > "$pidfile"
  )
  sleep 1
  echo "vault-ispark starting on :$VAULT_PORT, log: $LOG_DIR/vault.log"
}

start_spark() {
  local pidfile="$PID_DIR/spark.pid.txt"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile" | awk '{print $NF}')" 2>/dev/null; then
    echo "spark-ispark already running"
    return
  fi
  (
    cd "$ROOT/spark"
    export SPARK_BIND=127.0.0.1
    export SPARK_PORT="$SPARK_PORT"
    export VAULT_URL="http://127.0.0.1:$VAULT_PORT"
    if command -v setsid >/dev/null 2>&1; then
      setsid node src/server.js </dev/null >"$LOG_DIR/spark.log" 2>&1 &
    else
      nohup node src/server.js </dev/null >"$LOG_DIR/spark.log" 2>&1 &
    fi
    local p=$!
    disown "$p" 2>/dev/null || true
    echo "spark-ispark pid $p" > "$pidfile"
  )
  sleep 1
  echo "spark-ispark starting on :$SPARK_PORT, log: $LOG_DIR/spark.log"
}

stop_one() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid.txt"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(awk '{print $NF}' "$pidfile")"
    kill "$pid" 2>/dev/null && echo "$name-ispark stopped"
    rm -f "$pidfile"
  fi
}

status_one() {
  local name="$1" port="$2"
  local pidfile="$PID_DIR/$name.pid.txt"
  if [ -f "$pidfile" ] && kill -0 "$(awk '{print $NF}' "$pidfile")" 2>/dev/null; then
    echo "$name-ispark: running (port $port)"
  else
    echo "$name-ispark: stopped"
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start)
    start_vault
    start_spark
    ;;
  stop)
    stop_one vault
    stop_one spark
    ;;
  status)
    status_one vault "$VAULT_PORT"
    status_one spark "$SPARK_PORT"
    ;;
  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 1
    ;;
esac
