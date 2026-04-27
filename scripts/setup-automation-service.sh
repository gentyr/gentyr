#!/bin/bash
#
# Setup Automation Service
#
# Idempotently sets up a 10-minute timer service for automation tasks:
# usage tracking, report triage, plan execution, lint fixing, CLAUDE.md refactoring.
#
# Supports:
# - Linux: systemd user service + timer
# - macOS: launchd plist
#
# Usage:
#   ./scripts/setup-automation-service.sh setup [--path /project]                  # Install/update service
#   ./scripts/setup-automation-service.sh setup [--path /project] --op-token TOKEN # Install with 1Password service account
#   ./scripts/setup-automation-service.sh remove [--path /project]                 # Remove service
#   ./scripts/setup-automation-service.sh status [--path /project]                 # Check status
#   ./scripts/setup-automation-service.sh run [--path /project]                    # Run manually
#
# Options:
#   --op-token TOKEN  Include OP_SERVICE_ACCOUNT_TOKEN in the service environment.
#                     Enables headless 1Password credential resolution without
#                     macOS TCC prompts or Touch ID prompts. Without this, the
#                     automation service skips credential resolution in background
#                     mode and spawned agents run without infrastructure credentials.
#
# If --path is not provided, infers project dir from script location
# (framework dir -> parent = project root).
#
# This is a LOCAL DEV ONLY service - not for production.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="plan-executor"

# Parse --path and --op-token arguments (can appear after action)
EXPLICIT_PATH=""
OP_TOKEN_FOR_SERVICE=""
ARGS=()
EXPECT_PATH=false
EXPECT_OP_TOKEN=false
for arg in "$@"; do
  if [ "$arg" = "--path" ]; then
    EXPECT_PATH=true
    continue
  fi
  if [ "$arg" = "--op-token" ]; then
    EXPECT_OP_TOKEN=true
    continue
  fi
  if [ "$EXPECT_PATH" = true ]; then
    EXPLICIT_PATH="$(cd "$arg" 2>/dev/null && pwd)" || {
      echo -e "\033[0;31m[ERROR]\033[0m Directory does not exist: $arg"
      exit 1
    }
    EXPECT_PATH=false
    continue
  fi
  if [ "$EXPECT_OP_TOKEN" = true ]; then
    OP_TOKEN_FOR_SERVICE="$arg"
    EXPECT_OP_TOKEN=false
    continue
  fi
  ARGS+=("$arg")
done

# Check for dangling flags (no value provided)
if [ "$EXPECT_PATH" = true ]; then
  echo -e "\033[0;31m[ERROR]\033[0m --path requires a directory argument"
  exit 1
fi
if [ "$EXPECT_OP_TOKEN" = true ]; then
  echo -e "\033[0;31m[ERROR]\033[0m --op-token requires a 1Password service account token"
  exit 1
fi

# Resolve project directory
if [ -n "$EXPLICIT_PATH" ]; then
  PROJECT_DIR="$EXPLICIT_PATH"
else
  # When in framework: scripts/ -> .claude-framework/ -> project root
  PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# If running from a worktree path, resolve to the main project root
case "$PROJECT_DIR" in
  */.claude/worktrees/*)
    RESOLVED=$(dirname "$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")
    if [ -n "$RESOLVED" ]; then
      echo -e "${YELLOW}[WARN]${NC} Detected worktree path, resolving to main project: $RESOLVED"
      PROJECT_DIR="$RESOLVED"
    fi
    ;;
esac

# Also check if .git is a file (worktree indicator) rather than a directory
if [ -f "$PROJECT_DIR/.git" ]; then
  RESOLVED=$(dirname "$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$PROJECT_DIR" ]; then
    echo -e "${YELLOW}[WARN]${NC} Detected worktree, resolving to main project: $RESOLVED"
    PROJECT_DIR="$RESOLVED"
  fi
fi

# Hard-fail if still in a worktree
case "$PROJECT_DIR" in
  */.claude/worktrees/*)
    echo -e "${RED}[ERROR]${NC} Cannot set up automation from a worktree path: $PROJECT_DIR"
    echo "Run from the main project root instead."
    exit 1
    ;;
esac

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       echo "unknown" ;;
  esac
}

# ============================================================================
# systemctl --user helper (handles sudo context)
# ============================================================================

# When running under sudo or sudo -u, systemctl --user needs the user's D-Bus session.
# This helper ensures XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are set.
run_systemctl_user() {
  local TARGET_UID

  if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
    # Running as root - need to switch to actual user
    TARGET_UID=$(id -u "$SUDO_USER")
    local XDG="/run/user/$TARGET_UID"

    if [ -S "$XDG/bus" ]; then
      runuser -u "$SUDO_USER" -- env \
        XDG_RUNTIME_DIR="$XDG" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG/bus" \
        systemctl --user "$@"
    else
      log_warn "D-Bus session bus not found at $XDG/bus"
      log_warn "Timer files created but not activated. Run as your user:"
      log_warn "  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.timer"
      return 1
    fi
  elif [ -z "$XDG_RUNTIME_DIR" ] || [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    # Running as user but missing D-Bus env (e.g., invoked via sudo -u)
    TARGET_UID=$(id -u)
    local XDG="/run/user/$TARGET_UID"

    if [ -S "$XDG/bus" ]; then
      XDG_RUNTIME_DIR="$XDG" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG/bus" \
      systemctl --user "$@"
    else
      log_warn "D-Bus session bus not found at $XDG/bus"
      log_warn "Timer files created but not activated. Run:"
      log_warn "  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.timer"
      return 1
    fi
  else
    systemctl --user "$@"
  fi
}

# When running under sudo, resolve paths for the real user
if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
  REAL_HOME=$(eval echo "~$SUDO_USER")
else
  REAL_HOME="$HOME"
fi

# ============================================================================
# Linux (systemd) Implementation
# ============================================================================

SYSTEMD_USER_DIR="$REAL_HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"
TIMER_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.timer"
REVIVAL_SERVICE_FILE="$SYSTEMD_USER_DIR/gentyr-revival-daemon.service"
MCP_DAEMON_SERVICE_FILE="$SYSTEMD_USER_DIR/gentyr-mcp-daemon.service"

setup_linux() {
  log_info "Setting up systemd user service..."

  # Create systemd user directory if needed
  mkdir -p "$SYSTEMD_USER_DIR"

  # Fix ownership if running as root
  if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
    chown "$SUDO_USER:$(id -gn "$SUDO_USER" 2>/dev/null || echo staff)" "$SYSTEMD_USER_DIR"
  fi

  # Build optional OP_SERVICE_ACCOUNT_TOKEN env line
  # Preserve token from existing service if not explicitly provided via --op-token
  if [ -z "$OP_TOKEN_FOR_SERVICE" ] && [ -f "$SERVICE_FILE" ]; then
    EXISTING_OP_TOKEN=$(grep 'OP_SERVICE_ACCOUNT_TOKEN=' "$SERVICE_FILE" 2>/dev/null | sed 's/.*OP_SERVICE_ACCOUNT_TOKEN=//' || echo "")
    if [ -n "$EXISTING_OP_TOKEN" ]; then
      OP_TOKEN_FOR_SERVICE="$EXISTING_OP_TOKEN"
      log_info "Preserved OP_SERVICE_ACCOUNT_TOKEN from existing systemd service."
    fi
  fi
  OP_TOKEN_ENV=""
  if [ -n "$OP_TOKEN_FOR_SERVICE" ]; then
    OP_TOKEN_ENV="Environment=OP_SERVICE_ACCOUNT_TOKEN=$OP_TOKEN_FOR_SERVICE"
    log_info "Including OP_SERVICE_ACCOUNT_TOKEN in systemd service (API-based credential resolution, no prompts)."
  fi

  # Resolve framework dir for service script paths (handles broken symlinks)
  FRAMEWORK_DIR=""
  if [ -d "$PROJECT_DIR/node_modules/gentyr" ]; then
    # -d follows symlinks — only true if target directory exists
    FRAMEWORK_DIR="$(cd "$PROJECT_DIR/node_modules/gentyr" && pwd -P)"
  elif [ -d "$PROJECT_DIR/.claude-framework" ]; then
    FRAMEWORK_DIR="$(cd "$PROJECT_DIR/.claude-framework" && pwd -P)"
  elif [ -L "$PROJECT_DIR/.claude/hooks" ] && [ -d "$PROJECT_DIR/.claude/hooks" ]; then
    # Fallback: follow hooks symlink up to framework root
    HOOKS_REAL="$(cd "$PROJECT_DIR/.claude/hooks" && pwd -P)"
    CANDIDATE="$(cd "$HOOKS_REAL/../.." && pwd -P 2>/dev/null)" || true
    if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/version.json" ]; then
      FRAMEWORK_DIR="$CANDIDATE"
    fi
  fi
  if [ -z "$FRAMEWORK_DIR" ] && [ -d "$SCRIPT_DIR/.." ]; then
    # Last resort: script is in gentyr/scripts/, go up one level
    FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi

  # --- Revival Daemon Service (Restart=always, sub-second crash recovery) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/revival-daemon.js" ]; then
    cat > "$REVIVAL_SERVICE_FILE" << EOF
[Unit]
Description=GENTYR Revival Daemon - sub-second crash recovery for agent processes
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node $FRAMEWORK_DIR/scripts/revival-daemon.js
Environment=CLAUDE_PROJECT_DIR=$PROJECT_DIR
Environment=GENTYR_LAUNCHD_SERVICE=true
Restart=always
RestartSec=5
StandardOutput=append:$PROJECT_DIR/.claude/revival-daemon.log
StandardError=append:$PROJECT_DIR/.claude/revival-daemon.log

[Install]
WantedBy=default.target
EOF

    log_info "Created $REVIVAL_SERVICE_FILE"
  else
    log_warn "Revival daemon script not found — skipping revival daemon service."
  fi

  # --- Shared MCP Server Daemon Service (Restart=always, HTTP transport) ---
  MCP_DAEMON_OP_TOKEN_ENV=""
  if [ -n "$OP_TOKEN_FOR_SERVICE" ]; then
    MCP_DAEMON_OP_TOKEN_ENV="Environment=OP_SERVICE_ACCOUNT_TOKEN=$OP_TOKEN_FOR_SERVICE"
  fi
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/mcp-server-daemon.js" ]; then
    cat > "$MCP_DAEMON_SERVICE_FILE" << EOF
[Unit]
Description=GENTYR Shared MCP Server Daemon - HTTP transport for Tier 1 servers
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node $FRAMEWORK_DIR/scripts/mcp-server-daemon.js
Environment=CLAUDE_PROJECT_DIR=$PROJECT_DIR
Environment=GENTYR_LAUNCHD_SERVICE=true
$MCP_DAEMON_OP_TOKEN_ENV
Restart=always
RestartSec=5
StandardOutput=append:$PROJECT_DIR/.claude/mcp-daemon.log
StandardError=append:$PROJECT_DIR/.claude/mcp-daemon.log

[Install]
WantedBy=default.target
EOF

    log_info "Created $MCP_DAEMON_SERVICE_FILE"
  else
    log_warn "MCP server daemon script not found — skipping MCP daemon service."
  fi

  # --- Automation Service ---
  # Create service file
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Automation Service - Usage tracking, plan execution, and maintenance
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node $PROJECT_DIR/.claude/hooks/hourly-automation.js
Environment=CLAUDE_PROJECT_DIR=$PROJECT_DIR
Environment=GENTYR_LAUNCHD_SERVICE=true
$OP_TOKEN_ENV
StandardOutput=append:$PROJECT_DIR/.claude/hourly-automation.log
StandardError=append:$PROJECT_DIR/.claude/hourly-automation.log

[Install]
WantedBy=default.target
EOF

  log_info "Created $SERVICE_FILE"

  # Create timer file
  cat > "$TIMER_FILE" << EOF
[Unit]
Description=Run Automation Service every 10 minutes

[Timer]
OnCalendar=*:0/10
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF

  log_info "Created $TIMER_FILE"

  # Fix ownership of service files if running as root
  if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
    chown "$SUDO_USER:$(id -gn "$SUDO_USER" 2>/dev/null || echo staff)" "$SERVICE_FILE" "$TIMER_FILE"
    [ -f "$REVIVAL_SERVICE_FILE" ] && chown "$SUDO_USER:$(id -gn "$SUDO_USER" 2>/dev/null || echo staff)" "$REVIVAL_SERVICE_FILE"
    [ -f "$MCP_DAEMON_SERVICE_FILE" ] && chown "$SUDO_USER:$(id -gn "$SUDO_USER" 2>/dev/null || echo staff)" "$MCP_DAEMON_SERVICE_FILE"
  fi

  # Reload systemd and enable services
  if run_systemctl_user daemon-reload; then
    # Start revival daemon
    if [ -f "$REVIVAL_SERVICE_FILE" ]; then
      run_systemctl_user enable "gentyr-revival-daemon.service" 2>/dev/null || true
      run_systemctl_user start "gentyr-revival-daemon.service" 2>/dev/null || true
      log_info "Revival daemon service enabled and started."
    fi
    # Start shared MCP daemon
    if [ -f "$MCP_DAEMON_SERVICE_FILE" ]; then
      run_systemctl_user enable "gentyr-mcp-daemon.service" 2>/dev/null || true
      run_systemctl_user start "gentyr-mcp-daemon.service" 2>/dev/null || true
      log_info "Shared MCP daemon service enabled and started."
    fi
    # Then timer
    run_systemctl_user enable "${SERVICE_NAME}.timer" && \
    run_systemctl_user start "${SERVICE_NAME}.timer"
    log_info "Timer enabled and started."
  fi
}

remove_linux() {
  log_info "Removing systemd user services..."

  # Stop and disable shared MCP daemon
  run_systemctl_user stop "gentyr-mcp-daemon.service" 2>/dev/null || true
  run_systemctl_user disable "gentyr-mcp-daemon.service" 2>/dev/null || true
  rm -f "$MCP_DAEMON_SERVICE_FILE"
  log_info "Shared MCP daemon service removed."

  # Stop and disable revival daemon
  run_systemctl_user stop "gentyr-revival-daemon.service" 2>/dev/null || true
  run_systemctl_user disable "gentyr-revival-daemon.service" 2>/dev/null || true
  rm -f "$REVIVAL_SERVICE_FILE"
  log_info "Revival daemon service removed."

  # Stop and disable timer
  run_systemctl_user stop "${SERVICE_NAME}.timer" 2>/dev/null || true
  run_systemctl_user disable "${SERVICE_NAME}.timer" 2>/dev/null || true

  # Remove files
  rm -f "$SERVICE_FILE" "$TIMER_FILE"

  # Reload systemd
  run_systemctl_user daemon-reload 2>/dev/null || true

  log_info "Services removed."
}

status_linux() {
  echo ""
  echo "=== Shared MCP Daemon Status (Linux) ==="
  echo ""

  if [ -f "$MCP_DAEMON_SERVICE_FILE" ]; then
    echo "MCP daemon service: $MCP_DAEMON_SERVICE_FILE (exists)"
  else
    echo "MCP daemon service: $MCP_DAEMON_SERVICE_FILE (NOT FOUND)"
  fi

  echo "MCP daemon systemd status:"
  run_systemctl_user status "gentyr-mcp-daemon.service" 2>/dev/null || echo "  MCP daemon not found or not running"

  echo ""
  echo "MCP daemon health:"
  curl -sf http://localhost:18090/health 2>/dev/null || echo "  MCP daemon not responding"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/mcp-daemon.log" ]; then
    echo "Last 5 MCP daemon log lines:"
    tail -5 "$PROJECT_DIR/.claude/mcp-daemon.log"
  else
    echo "No MCP daemon log file found yet."
  fi

  echo ""
  echo "=== Revival Daemon Status (Linux) ==="
  echo ""

  if [ -f "$REVIVAL_SERVICE_FILE" ]; then
    echo "Revival daemon service: $REVIVAL_SERVICE_FILE (exists)"
  else
    echo "Revival daemon service: $REVIVAL_SERVICE_FILE (NOT FOUND)"
  fi

  echo "Revival daemon systemd status:"
  run_systemctl_user status "gentyr-revival-daemon.service" 2>/dev/null || echo "  Revival daemon not found or not running"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/revival-daemon.log" ]; then
    echo "Last 5 revival daemon log lines:"
    tail -5 "$PROJECT_DIR/.claude/revival-daemon.log"
  else
    echo "No revival daemon log file found yet."
  fi

  echo ""
  echo "=== Hourly Automation Status (Linux) ==="
  echo ""

  if [ -f "$TIMER_FILE" ]; then
    echo "Timer file: $TIMER_FILE (exists)"
  else
    echo "Timer file: $TIMER_FILE (NOT FOUND)"
  fi

  if [ -f "$SERVICE_FILE" ]; then
    echo "Service file: $SERVICE_FILE (exists)"
  else
    echo "Service file: $SERVICE_FILE (NOT FOUND)"
  fi

  echo ""
  echo "Timer status:"
  run_systemctl_user status "${SERVICE_NAME}.timer" 2>/dev/null || echo "  Timer not found or not running"

  echo ""
  echo "Recent runs:"
  journalctl --user -u "${SERVICE_NAME}.service" -n 5 --no-pager 2>/dev/null || echo "  No recent runs found"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/hourly-automation.log" ]; then
    echo "Last 10 log lines:"
    tail -10 "$PROJECT_DIR/.claude/hourly-automation.log"
  else
    echo "No log file found yet."
  fi
}

# ============================================================================
# macOS (launchd) Implementation
# ============================================================================

LAUNCHD_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$LAUNCHD_DIR/com.local.${SERVICE_NAME}.plist"
REVIVAL_PLIST_FILE="$LAUNCHD_DIR/com.local.gentyr-revival-daemon.plist"
MCP_DAEMON_PLIST_FILE="$LAUNCHD_DIR/com.local.gentyr-mcp-daemon.plist"
PREVIEW_WATCHER_PLIST_FILE="$LAUNCHD_DIR/com.local.gentyr-preview-watcher.plist"
SESSION_ACTIVITY_PLIST_FILE="$LAUNCHD_DIR/com.local.gentyr-session-activity-broadcaster.plist"
LIVE_FEED_PLIST_FILE="$LAUNCHD_DIR/com.local.gentyr-live-feed-daemon.plist"
LAUNCHD_UID=$(id -u)
LAUNCHD_DOMAIN="gui/$LAUNCHD_UID"

# Modern launchctl: bootstrap/bootout (macOS 10.10+), fallback to load/unload
# Returns 0 on success, 1 on failure
launchd_load() {
  local plist="$1"
  local label="$2"
  launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
  sleep 1  # Allow launchd to fully deregister before re-bootstrap
  if launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist" 2>/dev/null; then
    return 0
  fi
  if launchctl load "$plist" 2>/dev/null; then
    return 0
  fi
  return 1
}

launchd_unload() {
  local plist="$1"
  local label="$2"
  if ! launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null; then
    launchctl unload "$plist" 2>/dev/null || true
  fi
}

setup_macos() {
  log_info "Setting up launchd agent..."

  # Create LaunchAgents directory if needed
  mkdir -p "$LAUNCHD_DIR"

  # Find node binary (supports both Intel and Apple Silicon Macs)
  NODE_PATH=$(which node)
  if [ -z "$NODE_PATH" ]; then
    log_error "Node.js not found. Please install Node.js first."
    exit 1
  fi
  log_info "Using node at: $NODE_PATH"

  # Build optional OP_SERVICE_ACCOUNT_TOKEN plist entry
  # Preserve token from existing plist if not explicitly provided via --op-token
  if [ -z "$OP_TOKEN_FOR_SERVICE" ] && [ -f "$PLIST_FILE" ]; then
    EXISTING_OP_TOKEN=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:OP_SERVICE_ACCOUNT_TOKEN" "$PLIST_FILE" 2>/dev/null || echo "")
    if [ -n "$EXISTING_OP_TOKEN" ]; then
      OP_TOKEN_FOR_SERVICE="$EXISTING_OP_TOKEN"
      log_info "Preserved OP_SERVICE_ACCOUNT_TOKEN from existing plist."
    fi
  fi
  OP_TOKEN_PLIST=""
  if [ -n "$OP_TOKEN_FOR_SERVICE" ]; then
    OP_TOKEN_PLIST="        <key>OP_SERVICE_ACCOUNT_TOKEN</key>
        <string>$OP_TOKEN_FOR_SERVICE</string>"
    log_info "Including OP_SERVICE_ACCOUNT_TOKEN in plist (API-based credential resolution, no prompts)."
  fi

  # Resolve framework dir for service script paths (handles broken symlinks)
  FRAMEWORK_DIR=""
  if [ -d "$PROJECT_DIR/node_modules/gentyr" ]; then
    # -d follows symlinks — only true if target directory exists
    FRAMEWORK_DIR="$(cd "$PROJECT_DIR/node_modules/gentyr" && pwd -P)"
  elif [ -d "$PROJECT_DIR/.claude-framework" ]; then
    FRAMEWORK_DIR="$(cd "$PROJECT_DIR/.claude-framework" && pwd -P)"
  elif [ -L "$PROJECT_DIR/.claude/hooks" ] && [ -d "$PROJECT_DIR/.claude/hooks" ]; then
    # Fallback: follow hooks symlink up to framework root
    HOOKS_REAL="$(cd "$PROJECT_DIR/.claude/hooks" && pwd -P)"
    CANDIDATE="$(cd "$HOOKS_REAL/../.." && pwd -P 2>/dev/null)" || true
    if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/version.json" ]; then
      FRAMEWORK_DIR="$CANDIDATE"
    fi
  fi
  if [ -z "$FRAMEWORK_DIR" ] && [ -d "$SCRIPT_DIR/.." ]; then
    # Last resort: script is in gentyr/scripts/, go up one level
    FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi

  # --- Revival Daemon (KeepAlive, sub-second crash recovery) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/revival-daemon.js" ]; then
    cat > "$REVIVAL_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.gentyr-revival-daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$FRAMEWORK_DIR/scripts/revival-daemon.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>
    </dict>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/revival-daemon.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/revival-daemon.log</string>
</dict>
</plist>
EOF

    if launchd_load "$REVIVAL_PLIST_FILE" "com.local.gentyr-revival-daemon"; then
      log_info "Revival daemon service loaded (KeepAlive, RunAtLoad)."
    else
      log_warn "Revival daemon service FAILED to load — check: launchctl list | grep gentyr-revival-daemon"
    fi
  else
    log_warn "Revival daemon script not found — skipping revival daemon service."
  fi

  # --- Shared MCP Server Daemon (KeepAlive, HTTP transport on port 18090) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/mcp-server-daemon.js" ]; then
    cat > "$MCP_DAEMON_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.gentyr-mcp-daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$FRAMEWORK_DIR/scripts/mcp-server-daemon.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>$(if [ -n "$OP_TOKEN_FOR_SERVICE" ]; then echo "
        <key>OP_SERVICE_ACCOUNT_TOKEN</key>
        <string>$OP_TOKEN_FOR_SERVICE</string>"; fi)
    </dict>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/mcp-daemon.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/mcp-daemon.log</string>
</dict>
</plist>
EOF

    if launchd_load "$MCP_DAEMON_PLIST_FILE" "com.local.gentyr-mcp-daemon"; then
      log_info "Shared MCP daemon service loaded (KeepAlive, RunAtLoad, port 18090)."
    else
      log_warn "Shared MCP daemon service FAILED to load — check: launchctl list | grep gentyr-mcp-daemon"
    fi
  else
    log_warn "MCP server daemon script not found — skipping MCP daemon service."
  fi

  # --- Preview Watcher Daemon (KeepAlive, auto-syncs worktrees with base branch) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/preview-watcher.js" ]; then
    cat > "$PREVIEW_WATCHER_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.gentyr-preview-watcher</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$FRAMEWORK_DIR/scripts/preview-watcher.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>
    </dict>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/preview-watcher.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/preview-watcher.log</string>
</dict>
</plist>
EOF

    if launchd_load "$PREVIEW_WATCHER_PLIST_FILE" "com.local.gentyr-preview-watcher"; then
      log_info "Preview watcher daemon service loaded (KeepAlive, RunAtLoad)."
    else
      log_warn "Preview watcher daemon FAILED to load — check: launchctl list | grep gentyr-preview-watcher"
    fi
  else
    log_warn "Preview watcher script not found — skipping preview watcher service."
  fi

  # --- Session Activity Broadcaster (KeepAlive, LLM-powered session summaries) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/session-activity-broadcaster.js" ]; then
    cat > "$SESSION_ACTIVITY_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.gentyr-session-activity-broadcaster</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$FRAMEWORK_DIR/scripts/session-activity-broadcaster.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>
    </dict>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/session-activity-broadcaster.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/session-activity-broadcaster.log</string>
</dict>
</plist>
EOF

    if launchd_load "$SESSION_ACTIVITY_PLIST_FILE" "com.local.gentyr-session-activity-broadcaster"; then
      log_info "Session activity broadcaster loaded (KeepAlive, RunAtLoad)."
    else
      log_warn "Session activity broadcaster FAILED to load — check: launchctl list | grep gentyr-session-activity"
    fi
  else
    log_warn "Session activity broadcaster script not found — skipping."
  fi

  # --- Live Feed Daemon (KeepAlive, 60s polling, writes to live-feed.db) ---
  if [ -n "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/scripts/live-feed-daemon.js" ]; then
    cat > "$LIVE_FEED_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.gentyr-live-feed-daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$FRAMEWORK_DIR/scripts/live-feed-daemon.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>
    </dict>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/live-feed-daemon.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/live-feed-daemon.log</string>
</dict>
</plist>
EOF

    if launchd_load "$LIVE_FEED_PLIST_FILE" "com.local.gentyr-live-feed-daemon"; then
      log_info "Live feed daemon loaded (KeepAlive, RunAtLoad)."
    else
      log_warn "Live feed daemon FAILED to load — check: launchctl list | grep gentyr-live-feed"
    fi
  else
    log_warn "Live feed daemon script not found — skipping."
  fi

  # --- Automation Service (10-min interval) ---
  # Create plist file
  cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local.${SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$PROJECT_DIR/.claude/hooks/hourly-automation.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>GENTYR_LAUNCHD_SERVICE</key>
        <string>true</string>
$OP_TOKEN_PLIST
    </dict>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>WatchPaths</key>
    <array>
        <string>$HOME/.claude/.credentials.json</string>
    </array>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/.claude/hourly-automation.log</string>

    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/.claude/hourly-automation.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

  log_info "Created $PLIST_FILE"

  # Load the agent
  if launchd_load "$PLIST_FILE" "com.local.${SERVICE_NAME}"; then
    log_info "Agent loaded."
  else
    log_warn "Agent FAILED to load — check: launchctl list | grep ${SERVICE_NAME}"
  fi

  # Start the agent immediately so the first run happens while the user is watching.
  # If TCC hasn't been granted yet, the prompt appears now rather than randomly later.
  # Safe because hourly-automation.js has its own cooldowns and concurrency guards.
  launchctl start "com.local.${SERVICE_NAME}" 2>/dev/null || true
  log_info "First run triggered (supervised)."
}

remove_macos() {
  log_info "Removing launchd agents..."

  # Unload and remove shared MCP daemon
  launchd_unload "$MCP_DAEMON_PLIST_FILE" "com.local.gentyr-mcp-daemon"
  rm -f "$MCP_DAEMON_PLIST_FILE"
  log_info "Shared MCP daemon service removed."

  # Unload and remove revival daemon
  launchd_unload "$REVIVAL_PLIST_FILE" "com.local.gentyr-revival-daemon"
  rm -f "$REVIVAL_PLIST_FILE"
  log_info "Revival daemon service removed."

  # Unload and remove preview watcher daemon
  launchd_unload "$PREVIEW_WATCHER_PLIST_FILE" "com.local.gentyr-preview-watcher"
  rm -f "$PREVIEW_WATCHER_PLIST_FILE"
  log_info "Preview watcher daemon service removed."

  # Unload and remove session activity broadcaster
  launchd_unload "$SESSION_ACTIVITY_PLIST_FILE" "com.local.gentyr-session-activity-broadcaster"
  rm -f "$SESSION_ACTIVITY_PLIST_FILE"
  log_info "Session activity broadcaster service removed."

  # Unload and remove live feed daemon
  launchd_unload "$LIVE_FEED_PLIST_FILE" "com.local.gentyr-live-feed-daemon"
  rm -f "$LIVE_FEED_PLIST_FILE"
  log_info "Live feed daemon service removed."

  # Unload and remove automation agent
  launchd_unload "$PLIST_FILE" "com.local.${SERVICE_NAME}"
  rm -f "$PLIST_FILE"
  log_info "Automation agent removed."
}

status_macos() {
  echo ""
  echo "=== Shared MCP Daemon Status (macOS) ==="
  echo ""

  if [ -f "$MCP_DAEMON_PLIST_FILE" ]; then
    echo "MCP daemon plist: $MCP_DAEMON_PLIST_FILE (exists)"
  else
    echo "MCP daemon plist: $MCP_DAEMON_PLIST_FILE (NOT FOUND)"
  fi

  echo "MCP daemon launchd:"
  launchctl list | grep "gentyr-mcp-daemon" || echo "  MCP daemon not loaded"

  echo ""
  echo "MCP daemon health:"
  curl -sf http://localhost:18090/health 2>/dev/null || echo "  MCP daemon not responding"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/mcp-daemon.log" ]; then
    echo "Last 5 MCP daemon log lines:"
    tail -5 "$PROJECT_DIR/.claude/mcp-daemon.log"
  else
    echo "No MCP daemon log file found yet."
  fi

  echo ""
  echo "=== Revival Daemon Status (macOS) ==="
  echo ""

  if [ -f "$REVIVAL_PLIST_FILE" ]; then
    echo "Revival plist: $REVIVAL_PLIST_FILE (exists)"
  else
    echo "Revival plist: $REVIVAL_PLIST_FILE (NOT FOUND)"
  fi

  echo "Revival daemon launchd:"
  launchctl list | grep "gentyr-revival-daemon" || echo "  Revival daemon not loaded"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/revival-daemon.log" ]; then
    echo "Last 5 revival daemon log lines:"
    tail -5 "$PROJECT_DIR/.claude/revival-daemon.log"
  else
    echo "No revival daemon log file found yet."
  fi

  echo ""
  echo "=== Preview Watcher Status (macOS) ==="
  echo ""

  if [ -f "$PREVIEW_WATCHER_PLIST_FILE" ]; then
    echo "Preview watcher plist: $PREVIEW_WATCHER_PLIST_FILE (exists)"
  else
    echo "Preview watcher plist: $PREVIEW_WATCHER_PLIST_FILE (NOT FOUND)"
  fi

  echo "Preview watcher launchd:"
  launchctl list | grep "gentyr-preview-watcher" || echo "  Preview watcher not loaded"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/preview-watcher.log" ]; then
    echo "Last 5 preview watcher log lines:"
    tail -5 "$PROJECT_DIR/.claude/preview-watcher.log"
  else
    echo "No preview watcher log file found yet."
  fi

  echo ""
  echo "=== Hourly Automation Status (macOS) ==="
  echo ""

  if [ -f "$PLIST_FILE" ]; then
    echo "Plist file: $PLIST_FILE (exists)"
  else
    echo "Plist file: $PLIST_FILE (NOT FOUND)"
  fi

  echo ""
  echo "Launchd status:"
  launchctl list | grep "${SERVICE_NAME}" || echo "  Agent not loaded"

  echo ""
  if [ -f "$PROJECT_DIR/.claude/hourly-automation.log" ]; then
    echo "Last 10 log lines:"
    tail -10 "$PROJECT_DIR/.claude/hourly-automation.log"
  else
    echo "No log file found yet."
  fi
}

# ============================================================================
# Main
# ============================================================================

OS=$(detect_os)
ACTION="${ARGS[0]:-setup}"

case "$OS" in
  linux)
    case "$ACTION" in
      setup)
        setup_linux
        log_info "Automation service installed successfully!"
        log_info "The service will run every 10 minutes. Check status with: $0 status"
        log_info "Logs: $PROJECT_DIR/.claude/hourly-automation.log"
        ;;
      remove)
        remove_linux
        ;;
      status)
        status_linux
        ;;
      run)
        log_info "Running automation service manually..."
        node "$PROJECT_DIR/.claude/hooks/hourly-automation.js"
        ;;
      *)
        echo "Usage: $0 [setup|remove|status|run] [--path /project]"
        exit 1
        ;;
    esac
    ;;

  macos)
    case "$ACTION" in
      setup)
        setup_macos
        log_info "Automation service installed successfully!"
        log_info "The agent will run every 10 minutes. Check status with: $0 status"
        log_info "Logs: $PROJECT_DIR/.claude/hourly-automation.log"
        ;;
      remove)
        remove_macos
        ;;
      status)
        status_macos
        ;;
      run)
        log_info "Running automation service manually..."
        node "$PROJECT_DIR/.claude/hooks/hourly-automation.js"
        ;;
      *)
        echo "Usage: $0 [setup|remove|status|run] [--path /project]"
        exit 1
        ;;
    esac
    ;;

  *)
    log_error "Unsupported operating system: $(uname -s)"
    log_error "This script supports Linux (systemd) and macOS (launchd) only."
    exit 1
    ;;
esac
