#!/usr/bin/env bash
set -euo pipefail

# Timestamp-prefixed logging
log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

error() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: $*" | tee -a /app/.error.log >&2
}

# ---------------------------------------------------------------------------
# Validate required environment variables
# ---------------------------------------------------------------------------
MISSING=()
for VAR in GIT_REMOTE GIT_REF TEST_FILE; do
  if [[ -z "${!VAR:-}" ]]; then
    MISSING+=("$VAR")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing required environment variables: ${MISSING[*]}"
  exit 1
fi

log "Starting remote Playwright runner"
log "  GIT_REMOTE : $GIT_REMOTE"
log "  GIT_REF    : $GIT_REF"
log "  TEST_FILE  : $TEST_FILE"

# ---------------------------------------------------------------------------
# Configure git credential helper for private repos
# ---------------------------------------------------------------------------
if [[ -n "${GIT_AUTH_TOKEN:-}" ]]; then
  log "Configuring git credential helper (GIT_AUTH_TOKEN is set)"
  git config --global credential.helper '!f() { echo "password=$GIT_AUTH_TOKEN"; }; f'
fi

# ---------------------------------------------------------------------------
# Clone repository
# ---------------------------------------------------------------------------
log "Cloning $GIT_REMOTE at ref $GIT_REF ..."
git clone --depth=1 --branch "$GIT_REF" "$GIT_REMOTE" /app/project 2>&1 | tee -a /app/.error.log

cd /app/project

# ---------------------------------------------------------------------------
# Install dependencies
# ---------------------------------------------------------------------------
log "Running pnpm install (store: ${PNPM_STORE_DIR:-/cache/pnpm-store}) ..."
PNPM_STORE_DIR="${PNPM_STORE_DIR:-/cache/pnpm-store}" \
  pnpm install --frozen-lockfile 2>&1 | tee -a /app/.error.log

# ---------------------------------------------------------------------------
# Optional build step
# ---------------------------------------------------------------------------
if [[ -n "${WORKTREE_BUILD_CMD:-}" ]]; then
  RUN_BUILD=true

  if [[ -n "${WORKTREE_BUILD_HEALTH_CHECK:-}" ]]; then
    log "Running build health check: $WORKTREE_BUILD_HEALTH_CHECK"
    if eval "$WORKTREE_BUILD_HEALTH_CHECK" >/dev/null 2>&1; then
      log "Build health check passed — skipping build"
      RUN_BUILD=false
    else
      log "Build health check failed — running build"
    fi
  fi

  if [[ "$RUN_BUILD" == "true" ]]; then
    log "Running build: $WORKTREE_BUILD_CMD"
    eval "$WORKTREE_BUILD_CMD" 2>&1 | tee -a /app/.error.log
  fi
fi

# ---------------------------------------------------------------------------
# Optional dev server startup
# ---------------------------------------------------------------------------
DEV_SERVER_PID=""

if [[ -n "${DEV_SERVER_CMD:-}" ]]; then
  log "Starting dev server in background: $DEV_SERVER_CMD"
  eval "$DEV_SERVER_CMD" >/app/.devserver.log 2>&1 &
  DEV_SERVER_PID=$!
  log "Dev server PID: $DEV_SERVER_PID"

  HEALTH_CMD="${DEV_SERVER_HEALTH_CHECK:-curl -sf http://localhost:${DEV_SERVER_PORT:-3000}}"
  WAIT_SECS=60
  ELAPSED=0

  log "Waiting for dev server to be healthy (health check: $HEALTH_CMD) ..."
  until eval "$HEALTH_CMD" >/dev/null 2>&1; do
    if [[ $ELAPSED -ge $WAIT_SECS ]]; then
      error "Dev server did not become healthy within ${WAIT_SECS}s"
      if [[ -f /app/.devserver.log ]]; then
        error "Dev server log tail:"
        tail -20 /app/.devserver.log >&2
      fi
      exit 1
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
  done

  log "Dev server is healthy after ${ELAPSED}s"
  export PLAYWRIGHT_BASE_URL="http://localhost:${DEV_SERVER_PORT:-3000}"
  log "Set PLAYWRIGHT_BASE_URL=$PLAYWRIGHT_BASE_URL"
fi

# ---------------------------------------------------------------------------
# Set up progress JSONL file
# ---------------------------------------------------------------------------
PROGRESS_FILE="/app/.progress.jsonl"
touch "$PROGRESS_FILE"
export DEMO_PROGRESS_FILE="$PROGRESS_FILE"
log "Progress file: $PROGRESS_FILE"

# ---------------------------------------------------------------------------
# Run Playwright tests
# ---------------------------------------------------------------------------
log "Running Playwright tests: $TEST_FILE"

PLAYWRIGHT_EXIT=0
npx playwright test "$TEST_FILE" \
  --reporter=json,line \
  --trace=on \
  2> >(tee /app/.stderr.log >&2) \
  1> >(tee /app/.stdout.log) \
  || PLAYWRIGHT_EXIT=$?

log "Playwright exited with code: $PLAYWRIGHT_EXIT"

# ---------------------------------------------------------------------------
# Copy artifacts
# ---------------------------------------------------------------------------
log "Copying artifacts to /app/.artifacts/ ..."

for DIR in test-results playwright-report; do
  if [[ -d "/app/project/$DIR" ]]; then
    cp -r "/app/project/$DIR" "/app/.artifacts/$DIR"
    log "Copied $DIR"
  fi
done

# ---------------------------------------------------------------------------
# Write exit code for retrieval
# ---------------------------------------------------------------------------
echo "$PLAYWRIGHT_EXIT" > /app/.exit-code
log "Exit code written to /app/.exit-code"

# ---------------------------------------------------------------------------
# Grace period: allow artifact retrieval before the container exits
# ---------------------------------------------------------------------------
log "Sleeping 60s for artifact retrieval ..."
sleep 60

log "Remote runner complete (exit: $PLAYWRIGHT_EXIT)"
exit $PLAYWRIGHT_EXIT
