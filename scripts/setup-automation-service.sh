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
#   ./scripts/setup-automation-service.sh setup [--path /project]  # Install/update service
#   ./scripts/setup-automation-service.sh remove [--path /project] # Remove service
#   ./scripts/setup-automation-service.sh status [--path /project] # Check status
#   ./scripts/setup-automation-service.sh run [--path /project]    # Run manually
#
# If --path is not provided, infers project dir from script location
# (framework dir -> parent = project root).
#
# This is a LOCAL DEV ONLY service - not for production.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="plan-executor"

# Parse --path argument (can appear after action)
EXPLICIT_PATH=""
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--path" ]; then
    EXPECT_PATH=true
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
  ARGS+=("$arg")
done

# Check for dangling --path flag (no value provided)
if [ "$EXPECT_PATH" = true ]; then
  echo -e "\033[0;31m[ERROR]\033[0m --path requires a directory argument"
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

setup_linux() {
  log_info "Setting up systemd user service..."

  # Create systemd user directory if needed
  mkdir -p "$SYSTEMD_USER_DIR"

  # Fix ownership if running as root
  if [ "$EUID" -eq 0 ] && [ -n "$SUDO_USER" ]; then
    chown "$SUDO_USER:$SUDO_USER" "$SYSTEMD_USER_DIR"
  fi

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
    chown "$SUDO_USER:$SUDO_USER" "$SERVICE_FILE" "$TIMER_FILE"
  fi

  # Reload systemd and enable timer
  if run_systemctl_user daemon-reload && \
     run_systemctl_user enable "${SERVICE_NAME}.timer" && \
     run_systemctl_user start "${SERVICE_NAME}.timer"; then
    log_info "Timer enabled and started."
  fi
}

remove_linux() {
  log_info "Removing systemd user service..."

  # Stop and disable timer
  run_systemctl_user stop "${SERVICE_NAME}.timer" 2>/dev/null || true
  run_systemctl_user disable "${SERVICE_NAME}.timer" 2>/dev/null || true

  # Remove files
  rm -f "$SERVICE_FILE" "$TIMER_FILE"

  # Reload systemd
  run_systemctl_user daemon-reload 2>/dev/null || true

  log_info "Service removed."
}

status_linux() {
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
    </dict>

    <key>StartInterval</key>
    <integer>600</integer>

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
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load "$PLIST_FILE"
  log_info "Agent loaded."

  # Start the agent immediately so the first run happens while the user is watching.
  # If TCC hasn't been granted yet, the prompt appears now rather than randomly later.
  # Safe because hourly-automation.js has its own cooldowns and concurrency guards.
  launchctl start "com.local.${SERVICE_NAME}" 2>/dev/null || true
  log_info "First run triggered (supervised)."
}

remove_macos() {
  log_info "Removing launchd agent..."

  # Unload the agent
  launchctl unload "$PLIST_FILE" 2>/dev/null || true

  # Remove plist file
  rm -f "$PLIST_FILE"

  log_info "Agent removed."
}

status_macos() {
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
