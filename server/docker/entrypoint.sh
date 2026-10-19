#!/bin/sh
set -e

DATA_DIR="${STDB_DATA_DIR:-/stdb/data}"
MODULE_WASM="${MODULE_WASM:-/module/server.wasm}"
DB_NAME="${STDB_DB_NAME:-selfbase}"

READY_FILE="${STDB_READY_FILE:-/tmp/selfbase-ready}"
STARTUP_TIMEOUT="${STDB_STARTUP_TIMEOUT:-120}"
PUBLISH_TIMEOUT="${STDB_PUBLISH_TIMEOUT:-120}"
MIGRATION_TIMEOUT="${STDB_MIGRATION_TIMEOUT:-120}"
for value in "$STARTUP_TIMEOUT" "$PUBLISH_TIMEOUT" "$MIGRATION_TIMEOUT"; do
  case "$value" in ''|*[!0-9]*|0*) echo "[selfbase] ERROR: timeouts must be positive integer seconds." >&2; exit 2 ;; esac
done
printf 'starting\n' > "$READY_FILE"
STDB_PID=
OP_PID=
cleanup() {
  printf 'stopped\n' > "$READY_FILE" || true
  if [ -n "$OP_PID" ]; then
    kill -TERM "$OP_PID" 2>/dev/null || true
    wait "$OP_PID" 2>/dev/null || true
  fi
  if [ -n "$STDB_PID" ]; then
    kill -TERM "$STDB_PID" 2>/dev/null || true
    wait "$STDB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Run bounded CLI operations in the background so PID 1 can handle shutdown
# while publish/migration is in progress. timeout forwards TERM to its child.
run_cli() {
  limit="$1"
  shift
  timeout --kill-after=5 "$limit" spacetime "$@" &
  OP_PID=$!
  if wait "$OP_PID"; then
    OP_PID=
    return 0
  else
    command_status=$?
    OP_PID=
    return "$command_status"
  fi
}

mkdir -p "$DATA_DIR"
echo "[selfbase] Starting SpacetimeDB..."
spacetime start --data-dir="$DATA_DIR" --listen-addr=0.0.0.0:3000 --non-interactive &
STDB_PID=$!

# Wait for SpacetimeDB HTTP API to be ready.
# Use /v1/ping which returns HTTP 200 — the root path returns 404 and wget
# treats any 4xx/5xx as failure (exit code 8), causing the loop to never exit.
echo "[selfbase] Waiting for SpacetimeDB to accept connections..."
deadline=$(( $(date +%s) + STARTUP_TIMEOUT ))
until wget --timeout=2 --tries=1 -qO- http://localhost:3000/v1/ping > /dev/null 2>&1; do
  if ! kill -0 "$STDB_PID" 2>/dev/null; then
    echo "[selfbase] ERROR: SpacetimeDB exited before becoming ready." >&2
    wait "$STDB_PID"
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[selfbase] ERROR: SpacetimeDB startup timed out." >&2
    exit 1
  fi
  sleep 1
done
echo "[selfbase] SpacetimeDB ready."

# Publish the pre-built module WASM
# Some deploy paths accidentally create /module/server.wasm as a directory
# containing server.wasm. Normalize to the nested file in that case.
if [ -d "$MODULE_WASM" ] && [ -f "$MODULE_WASM/server.wasm" ]; then
  echo "[selfbase] Detected directory at $MODULE_WASM; using $MODULE_WASM/server.wasm"
  MODULE_WASM="$MODULE_WASM/server.wasm"
fi

PUBLISH_OK=0

if [ -f "$MODULE_WASM" ]; then
  echo "[selfbase] Publishing module from $MODULE_WASM as '$DB_NAME'..."
  # SpacetimeDB 2.0.3 requires explicit client-ABI opt-in even for some
  # additive columns with defaults. Deploy the matching web/bindings build;
  # --break-clients does not clear data or permit incompatible table changes.
  if run_cli "$PUBLISH_TIMEOUT" publish \
    --no-config \
    --bin-path "$MODULE_WASM" \
    "$DB_NAME" \
    --server http://localhost:3000 \
    --break-clients \
    --yes; then
    echo "[selfbase] Module published."
    PUBLISH_OK=1
  else
    printf 'publish-failed\n' > "$READY_FILE"
    echo "[selfbase] ERROR: Module publish failed; no automatic retry." >&2
    echo "[selfbase] CLI credentials are preserved. Check the publish error and retry manually with the database owner's identity." >&2
    echo "[selfbase] SpacetimeDB will keep serving the existing database; post-publish migrations are skipped." >&2
  fi
else
  printf 'module-missing\n' > "$READY_FILE"
  echo "[selfbase] WARNING: $MODULE_WASM not found."
  echo "[selfbase] Run 'cd server && spacetime build' on the host first, then restart this container."
fi

if [ "$PUBLISH_OK" -eq 1 ]; then
  echo "[selfbase] Running pending migrations for '$DB_NAME'..."
  if run_cli "$MIGRATION_TIMEOUT" call \
    --no-config \
    --server http://localhost:3000 \
    --yes \
    "$DB_NAME" \
    run_pending_migrations; then
    printf 'ready\n' > "$READY_FILE"
    echo "[selfbase] Pending migrations complete."
  else
    printf 'migration-failed\n' > "$READY_FILE"
    echo "[selfbase] WARNING: run_pending_migrations failed."
    echo "[selfbase] Data migrations may remain pending; fix the error and call run_pending_migrations manually."
  fi
fi

# Hand off to the SpacetimeDB server process
wait "$STDB_PID"
