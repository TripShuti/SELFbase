#!/bin/sh
set -e

DATA_DIR="${STDB_DATA_DIR:-/stdb/data}"
MODULE_WASM="${MODULE_WASM:-/module/server.wasm}"
DB_NAME="${STDB_DB_NAME:-selfbase}"

mkdir -p "$DATA_DIR"
echo "[selfbase] Starting SpacetimeDB..."
spacetime start --data-dir="$DATA_DIR" --listen-addr=0.0.0.0:3000 --non-interactive &
STDB_PID=$!

# Wait for SpacetimeDB HTTP API to be ready.
# Use /v1/ping which returns HTTP 200 — the root path returns 404 and wget
# treats any 4xx/5xx as failure (exit code 8), causing the loop to never exit.
echo "[selfbase] Waiting for SpacetimeDB to accept connections..."
until wget -qO- http://localhost:3000/v1/ping > /dev/null 2>&1; do
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
  # --break-clients matches lifecycle's production migration policy (see
  # lifecycle/src/provisioner.rs publish_module). Without it, additive
  # schema changes like "new column with default value" are rejected by
  # SpacetimeDB 2.0.3's default `Compatible` policy with HTTP 400
  # ClientBreakingChangeDisallowed. Self-hosted dev environments rolling
  # forward the module version need the same opt-in lifecycle gets via
  # the 2-step pre-publish flow. Client bindings are regenerated separately
  # before this image is built, so client-side compatibility is already
  # handled by the time we publish.
  if spacetime publish \
    --bin-path "$MODULE_WASM" \
    "$DB_NAME" \
    --server http://localhost:3000 \
    --break-clients \
    --yes; then
    echo "[selfbase] Module published."
    PUBLISH_OK=1
  else
    echo "[selfbase] WARNING: Initial publish failed. Clearing stale spacetime CLI state and retrying..."
    rm -rf /root/.config/spacetime
    mkdir -p /root/.config/spacetime

    if spacetime publish \
      --bin-path "$MODULE_WASM" \
      "$DB_NAME" \
      --server http://localhost:3000 \
      --break-clients \
      --yes; then
      echo "[selfbase] Module published on retry."
      PUBLISH_OK=1
    else
      echo "[selfbase] ERROR: Module publish failed after retry."
      echo "[selfbase] SpacetimeDB will keep running, but clients may fail until publish succeeds."
    fi
  fi
else
  echo "[selfbase] WARNING: $MODULE_WASM not found."
  echo "[selfbase] Run 'cd server && spacetime build' on the host first, then restart this container."
fi

if [ "$PUBLISH_OK" -eq 1 ]; then
  echo "[selfbase] Running pending migrations for '$DB_NAME'..."
  if spacetime call \
    --server http://localhost:3000 \
    --yes \
    "$DB_NAME" \
    run_pending_migrations; then
    echo "[selfbase] Pending migrations complete."
  else
    echo "[selfbase] WARNING: run_pending_migrations failed."
    echo "[selfbase] Built-in registry rows may be stale until migrations are run manually."
  fi
fi

# Hand off to the SpacetimeDB server process
wait $STDB_PID
