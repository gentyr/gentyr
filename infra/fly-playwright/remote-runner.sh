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
UNCLUTTER_PID=""

# Create progress file early so setup phases can write to it
PROGRESS_FILE="/app/.progress.jsonl"
touch "$PROGRESS_FILE"
export DEMO_PROGRESS_FILE="$PROGRESS_FILE"

# Ensure exit code is always written and artifacts are retrievable on ANY exit
cleanup() {
  local exit_code=$?
  log "Exit trap fired (exit code: $exit_code)"

  # 1. Stop ffmpeg recording gracefully (SIGINT → moov atom)
  # Pick up FFMPEG_PID from file (set by the Chrome-detection subshell)
  if [[ -z "$FFMPEG_PID" && -f /tmp/.ffmpeg_pid ]]; then
    FFMPEG_PID=$(cat /tmp/.ffmpeg_pid 2>/dev/null || echo "")
  fi
  if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    local count=0
    while kill -0 "$FFMPEG_PID" 2>/dev/null && [[ $count -lt 20 ]]; do
      sleep 0.5; count=$((count + 1))
    done
    kill -9 "$FFMPEG_PID" 2>/dev/null || true
  fi

  # 2. Stop unclutter and Xvfb
  if [[ -n "$UNCLUTTER_PID" ]]; then
    kill "$UNCLUTTER_PID" 2>/dev/null || true
  fi
  if [[ -n "$XVFB_PID" ]]; then
    kill "$XVFB_PID" 2>/dev/null || true
  fi

  # 2b. Stop system metrics poller
  if [[ -n "${METRICS_PID:-}" ]]; then
    kill "$METRICS_PID" 2>/dev/null || true
  fi

  # 3. Copy whatever artifacts exist (even partial logs from early failures)
  log "Copying available artifacts..."
  for DIR in test-results playwright-report; do
    if [[ -d "/app/project/$DIR" ]]; then
      cp -r "/app/project/$DIR" "/app/.artifacts/$DIR" 2>/dev/null || true
    fi
  done
  if [[ -f "/app/.recording.mp4" ]]; then
    cp "/app/.recording.mp4" /app/.artifacts/recording.mp4 2>/dev/null || true
  fi
  # Copy any Playwright CDP .webm videos not already inside test-results/
  find /app/project -name "*.webm" -not -path "*/node_modules/*" -exec cp {} /app/.artifacts/ \; 2>/dev/null || true
  # Copy telemetry JSONL files if telemetry was enabled
  if [[ -d "/app/project/.claude/recordings/demos" ]]; then
    find /app/project/.claude/recordings/demos -path "*/telemetry/*.jsonl" -exec sh -c 'mkdir -p /app/.artifacts/telemetry && cp "$1" /app/.artifacts/telemetry/' _ {} \; 2>/dev/null || true
  fi

  # 4. Write exit code AFTER artifacts are fully copied — the MCP polling loop
  #    uses .artifacts-ready as the pull trigger, but .exit-code is still needed
  #    for backward compatibility with older MCP server versions.
  echo "$exit_code" > /app/.exit-code 2>/dev/null || true

  # 5. Signal that all artifacts are ready for retrieval. The MCP polling loop
  #    checks for this file instead of .exit-code to avoid the race condition
  #    where artifacts haven't been copied yet when exit-code appears.
  touch /app/.artifacts-ready

  # 6. Upload binary artifacts to Tigris (if presigned URLs provided)
  if [[ -n "${ARTIFACT_UPLOAD_URLS:-}" ]]; then
    log "Uploading artifacts to Tigris..."

    upload_artifact() {
      local file="$1" url="$2" content_type="$3"
      if [[ -f "$file" && -n "$url" ]]; then
        local size
        size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo "?")
        if curl -sf --max-time 120 -X PUT -T "$file" -H "Content-Type: $content_type" "$url"; then
          log "Uploaded $(basename "$file") to Tigris (${size} bytes)"
        else
          log "WARNING: Failed to upload $(basename "$file") to Tigris"
        fi
      fi
    }

    # Extract URLs from JSON using jq (available in the Docker image)
    extract_url() { echo "$ARTIFACT_UPLOAD_URLS" | jq -r ".urls[\"$1\"] // empty" 2>/dev/null; }

    upload_artifact "$RECORDING_FILE" "$(extract_url 'recording.mp4')" "video/mp4"
    upload_artifact "/app/.stdout.log" "$(extract_url 'stdout.log')" "text/plain"
    upload_artifact "/app/.stderr.log" "$(extract_url 'stderr.log')" "text/plain"
    upload_artifact "/app/.exit-code" "$(extract_url 'exit-code')" "text/plain"
    upload_artifact "/app/.progress.jsonl" "$(extract_url 'progress.jsonl')" "application/x-ndjson"
    upload_artifact "/app/.error.log" "$(extract_url 'error.log')" "text/plain"
    upload_artifact "/app/.ffmpeg.log" "$(extract_url 'ffmpeg.log')" "text/plain"
    upload_artifact "/app/.devserver.log" "$(extract_url 'devserver.log')" "text/plain"

    # Upload any trace.zip files
    for trace_file in /app/project/playwright-results/*/trace.zip; do
      if [[ -f "$trace_file" ]]; then
        upload_artifact "$trace_file" "$(extract_url 'trace.zip')" "application/zip"
        break  # Only upload the first trace
      fi
    done
  fi

  # 7. Grace period: keep the machine alive so the MCP server can pull artifacts
  #    via the /exec API. Without this, auto_destroy kills the machine immediately.
  log "Sleeping 60s for artifact retrieval..."
  sleep 60
  log "Cleanup complete (exit: $exit_code)"
}
trap cleanup EXIT

log "Starting remote Playwright runner"
log "  GIT_REMOTE    : $GIT_REMOTE"
log "  GIT_REF       : $GIT_REF"
log "  TEST_FILE     : $TEST_FILE"
log "  DEMO_RUN_ID   : ${DEMO_RUN_ID:-<not set>}"
log "  DEMO_TELEMETRY: ${DEMO_TELEMETRY:-0}"

# ---------------------------------------------------------------------------
# Configure git credential helper for private repos
# ---------------------------------------------------------------------------
if [[ -n "${GIT_AUTH_TOKEN:-}" ]]; then
  log "Configuring git credential helper (GIT_AUTH_TOKEN is set)"
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GIT_AUTH_TOKEN"; }; f'
fi

# ---------------------------------------------------------------------------
# Clone repository (skip if project image already has the code)
# ---------------------------------------------------------------------------
if [[ -f /app/.project-image && -d /app/project/node_modules ]]; then
  log "Project image detected — skipping clone and install"
  echo '{"type":"setup","phase":"clone_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  cd /app/project
  # Pull latest changes on the branch (project image may be slightly behind)
  if [[ -n "${GIT_AUTH_TOKEN:-}" ]]; then
    git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GIT_AUTH_TOKEN"; }; f'
  fi
  git fetch origin "$GIT_REF" --depth=1 2>&1 | tee -a /app/.error.log || true
  git checkout FETCH_HEAD 2>&1 | tee -a /app/.error.log || true
  echo '{"type":"setup","phase":"clone_done","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  echo '{"type":"setup","phase":"install_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  echo '{"type":"setup","phase":"install_done","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  INSTALL_HEARTBEAT_PID=""
else
  log "Cloning $GIT_REMOTE at ref $GIT_REF ..."
  echo '{"type":"setup","phase":"clone_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  git clone --depth=1 --branch "$GIT_REF" "$GIT_REMOTE" /app/project 2>&1 | tee -a /app/.error.log

  cd /app/project
  echo '{"type":"setup","phase":"clone_done","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true

  # ---------------------------------------------------------------------------
  # Install dependencies
  # ---------------------------------------------------------------------------
  log "Running pnpm install (store: ${PNPM_STORE_DIR:-/cache/pnpm-store}) ..."
  echo '{"type":"setup","phase":"install_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  # Heartbeat during install — write progress events every 30s to prevent stall detector timeout
  (while true; do sleep 30; echo '{"type":"setup","phase":"install_progress","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true; done) &
  INSTALL_HEARTBEAT_PID=$!
  NODE_ENV=development PNPM_STORE_DIR="${PNPM_STORE_DIR:-/cache/pnpm-store}" \
    pnpm install --frozen-lockfile 2>&1 | tee -a /app/.error.log
fi
if [[ -n "$INSTALL_HEARTBEAT_PID" ]]; then
  kill "$INSTALL_HEARTBEAT_PID" 2>/dev/null || true
fi

# Install the correct browser version for the project's Playwright version.
# Skip if this is a project image (browsers already installed during image build).
if [[ ! -f /app/.project-image ]]; then
  log "Installing Playwright browsers (matching project's @playwright/test version)..."
  npx playwright install chromium 2>&1 | tee -a /app/.error.log || true
  echo '{"type":"setup","phase":"install_done","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
else
  log "Project image — Playwright browsers already installed"
fi
# Use development mode — Fly machines run dev servers, and production mode
# triggers strict env validation (e.g. CREDENTIAL_ENCRYPTION_KEY required).
# The web server's NODE_ENV is handled by playwright.config.ts; this sets
# it globally for the backend and other processes.
export NODE_ENV=development

# ---------------------------------------------------------------------------
# Execute prerequisites from GENTYR_PREREQUISITES JSON
# ---------------------------------------------------------------------------
if [[ -n "${GENTYR_PREREQUISITES:-}" ]]; then
  log "Executing prerequisites..."
  echo '{"type":"setup","phase":"prerequisites_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true

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
  echo '{"type":"setup","phase":"prerequisites_done","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
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
  echo '{"type":"setup","phase":"devserver_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
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
  echo '{"type":"setup","phase":"devserver_ready","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true
  export PLAYWRIGHT_BASE_URL="http://localhost:${DEV_SERVER_PORT:-3000}"
  log "Set PLAYWRIGHT_BASE_URL=$PLAYWRIGHT_BASE_URL"
fi

# ---------------------------------------------------------------------------
# Increase /dev/shm for Chrome stability (default 64MB is too small)
# ---------------------------------------------------------------------------
# Chrome uses /dev/shm for renderer IPC even with --disable-dev-shm-usage.
# The 64MB default causes crashes after 2-3 minutes in headed mode.
if mount -o remount,size=2G /dev/shm 2>/dev/null; then
  log "Increased /dev/shm to 2GB"
else
  log "Warning: could not increase /dev/shm (may cause Chrome crashes)"
fi

# ---------------------------------------------------------------------------
# Start virtual display for window-level recording (only when headed)
# ---------------------------------------------------------------------------
if [[ "${DEMO_HEADLESS:-1}" != "1" ]]; then
  log "Starting Xvfb virtual display (${RECORDING_RESOLUTION})..."
  Xvfb :99 -screen 0 "${RECORDING_RESOLUTION}x24" -ac -nolisten tcp &
  XVFB_PID=$!
  export DISPLAY=:99
  sleep 1

  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    error "Xvfb failed to start — falling back to headless (no recording)"
    XVFB_PID=""
  else
    export DEMO_MAXIMIZE=1

    # Hide the system cursor — only the CSS cursor-highlight red dot should
    # be visible in the recording.  unclutter -idle 0 hides the X11 cursor
    # immediately and keeps it hidden for the lifetime of the process.
    if command -v unclutter &>/dev/null; then
      unclutter -idle 0 -root &
      UNCLUTTER_PID=$!
      log "System cursor hidden via unclutter (PID: $UNCLUTTER_PID)"
    else
      log "WARNING: unclutter not found — system cursor will be visible in recording"
    fi

    # NOTE: ffmpeg recording is started later, just before the Playwright test,
    # so the recording does not include minutes of blank Xvfb desktop during
    # install, build, prerequisites, and dev server startup.
  fi
else
  log "Running headless — skipping Xvfb and recording"
fi

log "Progress file: $PROGRESS_FILE"

# ---------------------------------------------------------------------------
# System metrics poller (when telemetry enabled)
# ---------------------------------------------------------------------------
METRICS_PID=""
if [[ "${DEMO_TELEMETRY:-}" == "1" ]]; then
  TELEMETRY_DIR="${DEMO_TELEMETRY_DIR:-/app/.artifacts/telemetry}"
  mkdir -p "$TELEMETRY_DIR"
  log "Starting system metrics poller (interval: 2s) -> $TELEMETRY_DIR/system-metrics.jsonl"
  (while true; do
    MEM_INFO=$(free -m 2>/dev/null || echo "")
    MEM_TOTAL=$(echo "$MEM_INFO" | awk '/Mem/{print $2}')
    MEM_USED=$(echo "$MEM_INFO" | awk '/Mem/{print $3}')
    MEM_FREE=$(echo "$MEM_INFO" | awk '/Mem/{print $7}')
    CPU_PCT=$(top -bn1 2>/dev/null | grep 'Cpu(s)' | awk '{print $2}' || echo "0")
    LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1","$2","$3}' || echo "0,0,0")
    echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"type\":\"system_metrics\",\"run_id\":\"${DEMO_RUN_ID:-unknown}\",\"system\":{\"cpu_percent\":${CPU_PCT:-0},\"mem_used_mb\":${MEM_USED:-0},\"mem_total_mb\":${MEM_TOTAL:-0},\"mem_free_mb\":${MEM_FREE:-0},\"load_avg\":[${LOAD}]}}" >> "$TELEMETRY_DIR/system-metrics.jsonl" 2>/dev/null
    sleep 2
  done) &
  METRICS_PID=$!
fi

# ---------------------------------------------------------------------------
# Run Playwright tests (with stall-detection watchdog)
# ---------------------------------------------------------------------------
log "Running Playwright tests: $TEST_FILE"
echo '{"type":"setup","phase":"test_start","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /app/.progress.jsonl 2>/dev/null || true

PLAYWRIGHT_EXIT=0
STALL_TIMEOUT=${GENTYR_STALL_TIMEOUT_S:-600}
GRACE_PERIOD=${GENTYR_STALL_GRACE_S:-60}

# Launch Playwright in the background; tee stdout/stderr to log files while
# still streaming them to the terminal so container logs capture output.
# ffmpeg recording starts AFTER Chrome appears on the display (see below).
npx playwright test "$TEST_FILE" \
  --reporter=json,line \
  --trace=on \
  > >(tee /app/.stdout.log) \
  2> >(tee /app/.stderr.log >&2) &
PLAYWRIGHT_PID=$!

# ---------------------------------------------------------------------------
# Start ffmpeg recording when Chrome appears on Xvfb (not before).
# Playwright's webServer config compiles packages and starts dev servers for
# 2-3 minutes before Chrome launches. Polling for the Chrome window avoids
# recording minutes of blank Xvfb desktop.
# ---------------------------------------------------------------------------
if [[ -n "$XVFB_PID" ]] && kill -0 "$XVFB_PID" 2>/dev/null && [[ -z "$FFMPEG_PID" ]]; then
  # Remove stale signal from a previous run
  rm -f /tmp/.demo-automation-ready

  (
    # Wait for the demo fixture to signal that automation is about to begin.
    # The vendorPage fixture writes /tmp/.demo-automation-ready after the
    # dashboard loads and just before handing the page to the test body.
    # Falls back to Chrome window detection, then to a 5-minute timeout.
    WAIT_START=$(date +%s)
    STARTED=false

    start_ffmpeg() {
      ffmpeg -f x11grab -video_size "${RECORDING_RESOLUTION}" \
        -framerate "${RECORDING_FPS}" -i :99 \
        -c:v libx264 -preset ultrafast -profile:v high -crf 23 -pix_fmt yuv420p \
        -movflags +faststart -y "$RECORDING_FILE" \
        < /dev/null > /app/.ffmpeg.log 2>&1 &
      echo $! > /tmp/.ffmpeg_pid
      STARTED=true
    }

    while kill -0 "$PLAYWRIGHT_PID" 2>/dev/null && [[ "$STARTED" == "false" ]]; do
      # Primary: fixture signal file
      if [[ -f /tmp/.demo-automation-ready ]]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Demo automation ready signal received — starting recording" >&2
        start_ffmpeg
        break
      fi

      ELAPSED=$(( $(date +%s) - WAIT_START ))

      # Fallback: Chrome window detected + 5s buffer for fixture to finish
      if [[ "$ELAPSED" -ge 30 ]] && xdotool search --name "Chrom" >/dev/null 2>&1; then
        # Chrome has been up for a while but no signal — fixture may not support it
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Chrome window detected (no signal file) — starting recording" >&2
        start_ffmpeg
        break
      fi

      # Hard fallback: 5 minutes
      if [[ "$ELAPSED" -ge 300 ]]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARNING: No automation signal after 5 min — starting recording" >&2
        start_ffmpeg
        break
      fi

      sleep 1
    done
  ) &
  CHROME_DETECT_PID=$!

  # Log when recording actually starts
  (
    while [[ ! -f /tmp/.ffmpeg_pid ]] && kill -0 "$PLAYWRIGHT_PID" 2>/dev/null; do
      sleep 1
    done
    if [[ -f /tmp/.ffmpeg_pid ]]; then
      FPID=$(cat /tmp/.ffmpeg_pid)
      if kill -0 "$FPID" 2>/dev/null; then
        log "Recording started (PID: $FPID)"
      fi
    fi
  ) &
fi

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
# Stop ffmpeg immediately so the recording ends cleanly when the test ends,
# not minutes later when the EXIT trap fires after artifact copy + sleep.
# SIGINT allows ffmpeg to write the moov atom (required for a playable MP4).
# The EXIT trap is a safety net — it will no-op if FFMPEG_PID is already dead.
# ---------------------------------------------------------------------------
# Pick up FFMPEG_PID from file (set by the Chrome-detection subshell)
if [[ -z "$FFMPEG_PID" && -f /tmp/.ffmpeg_pid ]]; then
  FFMPEG_PID=$(cat /tmp/.ffmpeg_pid 2>/dev/null || echo "")
fi
if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
  log "Stopping ffmpeg recording..."
  kill -INT "$FFMPEG_PID" 2>/dev/null || true
  local_count=0
  while kill -0 "$FFMPEG_PID" 2>/dev/null && [[ $local_count -lt 20 ]]; do
    sleep 0.5; local_count=$((local_count + 1))
  done
  if kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -9 "$FFMPEG_PID" 2>/dev/null || true
  fi
  log "Recording stopped"
fi

# The EXIT trap (cleanup) handles: writing exit code, stopping Xvfb,
# copying artifacts, and the 60s grace period for artifact retrieval.
log "Remote runner complete (exit: ${PLAYWRIGHT_EXIT:-$?})"
exit ${PLAYWRIGHT_EXIT:-1}
