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

# ---------------------------------------------------------------------------
# Recording configuration
# ---------------------------------------------------------------------------
RECORDING_FILE="/app/.recording.mp4"
RECORDING_RESOLUTION="${GENTYR_RECORDING_RESOLUTION:-1920x1080}"
RECORDING_FPS="${GENTYR_RECORDING_FPS:-25}"
XVFB_PID=""
FFMPEG_PID=""

# Ensure ffmpeg gets a graceful shutdown (SIGINT → moov atom) on any exit
cleanup_recording() {
  if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    local count=0
    while kill -0 "$FFMPEG_PID" 2>/dev/null && [[ $count -lt 20 ]]; do
      sleep 0.5; count=$((count + 1))
    done
    kill -9 "$FFMPEG_PID" 2>/dev/null || true
  fi
  if [[ -n "$XVFB_PID" ]]; then
    kill "$XVFB_PID" 2>/dev/null || true
  fi
}
trap cleanup_recording EXIT

log "Starting remote Playwright runner"
log "  GIT_REMOTE : $GIT_REMOTE"
log "  GIT_REF    : $GIT_REF"
log "  TEST_FILE  : $TEST_FILE"

# ---------------------------------------------------------------------------
# Configure git credential helper for private repos
# ---------------------------------------------------------------------------
if [[ -n "${GIT_AUTH_TOKEN:-}" ]]; then
  log "Configuring git credential helper (GIT_AUTH_TOKEN is set)"
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GIT_AUTH_TOKEN"; }; f'
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
NODE_ENV=development PNPM_STORE_DIR="${PNPM_STORE_DIR:-/cache/pnpm-store}" \
  pnpm install --frozen-lockfile 2>&1 | tee -a /app/.error.log
export NODE_ENV=production

# ---------------------------------------------------------------------------
# Execute prerequisites from GENTYR_PREREQUISITES JSON
# ---------------------------------------------------------------------------
if [[ -n "${GENTYR_PREREQUISITES:-}" ]]; then
  log "Executing prerequisites..."

  # Count prerequisites
  PREREQ_COUNT=$(echo "$GENTYR_PREREQUISITES" | jq 'length')
  log "  Found $PREREQ_COUNT prerequisite(s)"

  for i in $(seq 0 $((PREREQ_COUNT - 1))); do
    PREREQ_DESC=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].description")
    PREREQ_CMD=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].command")
    PREREQ_HEALTH=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].health_check // empty")
    PREREQ_HEALTH_TIMEOUT=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].health_check_timeout_ms // 5000")
    PREREQ_TIMEOUT=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].timeout_ms // 30000")
    PREREQ_BG=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].run_as_background // false")
    PREREQ_SCOPE=$(echo "$GENTYR_PREREQUISITES" | jq -r ".[$i].scope")

    log "  [$((i+1))/$PREREQ_COUNT] $PREREQ_DESC (scope: $PREREQ_SCOPE)"

    # Check health first — skip if already satisfied
    if [[ -n "$PREREQ_HEALTH" ]]; then
      HEALTH_TIMEOUT_SEC=$((PREREQ_HEALTH_TIMEOUT / 1000))
      [[ $HEALTH_TIMEOUT_SEC -lt 1 ]] && HEALTH_TIMEOUT_SEC=5
      if timeout "${HEALTH_TIMEOUT_SEC}s" bash -c "$PREREQ_HEALTH" >/dev/null 2>&1; then
        log "    Health check passed — skipping"
        continue
      fi
      log "    Health check failed — running setup"
    fi

    PREREQ_TIMEOUT_SEC=$((PREREQ_TIMEOUT / 1000))
    [[ $PREREQ_TIMEOUT_SEC -lt 1 ]] && PREREQ_TIMEOUT_SEC=30

    if [[ "$PREREQ_BG" == "1" || "$PREREQ_BG" == "true" ]]; then
      # Background: spawn and poll health check
      log "    Starting background: $PREREQ_CMD"
      bash -c "$PREREQ_CMD" >/dev/null 2>&1 &
      BG_PID=$!

      if [[ -n "$PREREQ_HEALTH" ]]; then
        ELAPSED=0
        while ! timeout "${HEALTH_TIMEOUT_SEC}s" bash -c "$PREREQ_HEALTH" >/dev/null 2>&1; do
          if [[ $ELAPSED -ge $PREREQ_TIMEOUT_SEC ]]; then
            log "    WARNING: Background prereq '$PREREQ_DESC' health check did not pass within ${PREREQ_TIMEOUT_SEC}s — continuing anyway"
            break
          fi
          sleep 2
          ELAPSED=$((ELAPSED + 2))
        done
        if [[ $ELAPSED -lt $PREREQ_TIMEOUT_SEC ]]; then
          log "    Background prerequisite healthy after ${ELAPSED}s"
        fi
      else
        sleep 2  # Brief settle time
      fi
    else
      # Foreground: run with timeout
      log "    Running: $PREREQ_CMD"
      if ! timeout "${PREREQ_TIMEOUT_SEC}s" bash -c "$PREREQ_CMD" 2>&1; then
        log "    WARNING: Prerequisite '$PREREQ_DESC' failed — continuing anyway"
      fi
    fi
  done

  log "Prerequisites complete"
fi

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
# Start virtual display for window-level recording (Xvfb + ffmpeg)
# ---------------------------------------------------------------------------
log "Starting Xvfb virtual display (${RECORDING_RESOLUTION})..."
Xvfb :99 -screen 0 "${RECORDING_RESOLUTION}x24" -ac -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  error "Xvfb failed to start — falling back to headless (no recording)"
  XVFB_PID=""
else
  # Run headed on virtual display for full-window recording
  export DEMO_HEADLESS=0
  export DEMO_MAXIMIZE=1

  log "Starting ffmpeg display recording (${RECORDING_RESOLUTION} @ ${RECORDING_FPS}fps)..."
  ffmpeg -f x11grab -video_size "${RECORDING_RESOLUTION}" \
    -framerate "${RECORDING_FPS}" -i :99 \
    -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p \
    -y "$RECORDING_FILE" \
    < /dev/null > /app/.ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
  sleep 0.5

  if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
    error "ffmpeg failed to start — continuing without recording"
    FFMPEG_PID=""
  else
    log "Recording started (PID: $FFMPEG_PID)"
  fi
fi

# ---------------------------------------------------------------------------
# Set up progress JSONL file
# ---------------------------------------------------------------------------
PROGRESS_FILE="/app/.progress.jsonl"
touch "$PROGRESS_FILE"
export DEMO_PROGRESS_FILE="$PROGRESS_FILE"
log "Progress file: $PROGRESS_FILE"

# ---------------------------------------------------------------------------
# Run Playwright tests (with stall-detection watchdog)
# ---------------------------------------------------------------------------
log "Running Playwright tests: $TEST_FILE"

PLAYWRIGHT_EXIT=0
STALL_TIMEOUT=${GENTYR_STALL_TIMEOUT_S:-120}
GRACE_PERIOD=${GENTYR_STALL_GRACE_S:-60}

# Launch Playwright in the background; tee stdout/stderr to log files while
# still streaming them to the terminal so container logs capture output.
npx playwright test "$TEST_FILE" \
  --reporter=json,line \
  --trace=on \
  > >(tee /app/.stdout.log) \
  2> >(tee /app/.stderr.log >&2) &
PLAYWRIGHT_PID=$!

# Start watchdog subshell: after the grace period, poll file sizes every 10s.
# If no file growth is observed for STALL_TIMEOUT seconds, kill Playwright.
(
  sleep "$GRACE_PERIOD"
  LAST_SIZE=0
  LAST_CHANGE=$(date +%s)
  while kill -0 "$PLAYWRIGHT_PID" 2>/dev/null; do
    CURRENT_SIZE=0
    for f in /app/.progress.jsonl /app/.stdout.log /app/.stderr.log; do
      if [[ -f "$f" ]]; then
        # Use stat to get file size (handle both GNU and BSD stat)
        S=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
        CURRENT_SIZE=$((CURRENT_SIZE + S))
      fi
    done

    if [[ "$CURRENT_SIZE" -ne "$LAST_SIZE" ]]; then
      LAST_SIZE=$CURRENT_SIZE
      LAST_CHANGE=$(date +%s)
    fi

    NOW=$(date +%s)
    SILENCE=$((NOW - LAST_CHANGE))
    if [[ "$SILENCE" -ge "$STALL_TIMEOUT" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] STALL DETECTED: no activity for ${SILENCE}s" >> /app/.stderr.log
      echo '{"type":"crash","stderr_snippet":"Stall detected: no output for '${SILENCE}'s after '${GRACE_PERIOD}'s grace"}' >> /app/.progress.jsonl
      kill "$PLAYWRIGHT_PID" 2>/dev/null
      sleep 2
      kill -9 "$PLAYWRIGHT_PID" 2>/dev/null
      break
    fi

    sleep 10
  done
) &
WATCHDOG_PID=$!

# Wait for Playwright to finish
wait "$PLAYWRIGHT_PID" || PLAYWRIGHT_EXIT=$?

# Kill the watchdog (it may already be done)
kill "$WATCHDOG_PID" 2>/dev/null
wait "$WATCHDOG_PID" 2>/dev/null || true

log "Playwright exited with code: $PLAYWRIGHT_EXIT"

# ---------------------------------------------------------------------------
# Stop recording
# ---------------------------------------------------------------------------
if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
  log "Stopping ffmpeg recording..."
  kill -INT "$FFMPEG_PID" 2>/dev/null || true
  # Wait up to 10s for ffmpeg to finalize (write moov atom)
  WAIT_COUNT=0
  while kill -0 "$FFMPEG_PID" 2>/dev/null && [[ $WAIT_COUNT -lt 20 ]]; do
    sleep 0.5
    WAIT_COUNT=$((WAIT_COUNT + 1))
  done
  kill -9 "$FFMPEG_PID" 2>/dev/null || true
  wait "$FFMPEG_PID" 2>/dev/null || true

  if [[ -f "$RECORDING_FILE" ]]; then
    REC_SIZE=$(stat -c%s "$RECORDING_FILE" 2>/dev/null || stat -f%z "$RECORDING_FILE" 2>/dev/null || echo 0)
    log "Recording saved: $RECORDING_FILE (${REC_SIZE} bytes)"
    if [[ "$REC_SIZE" -eq 0 ]]; then
      log "WARNING: Recording file is empty — ffmpeg may have failed. Check /app/.ffmpeg.log"
      rm -f "$RECORDING_FILE"
    fi
  else
    log "WARNING: Recording file not found after ffmpeg exit"
  fi
fi

if [[ -n "$XVFB_PID" ]]; then
  kill "$XVFB_PID" 2>/dev/null || true
  wait "$XVFB_PID" 2>/dev/null || true
fi

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

# Recording is pulled individually by fly-runner.ts (not via the tarball) to
# avoid doubling transfer size through base64-encoded JSON.

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
