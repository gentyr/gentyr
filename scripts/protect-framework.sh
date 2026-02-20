#!/bin/bash
# ==============================================================================
# GENTYR Protection Script
#
# This script makes critical files root-owned to prevent agents from bypassing
# security mechanisms. Agents run as the same user, so they have the same file
# permissions. Root-owned files are truly unbypassable.
#
# Protected files:
#   - Pre-commit hook (enforces lint + deputy-cto review)
#   - Bypass approval hook (processes CTO approval phrases)
#   - ESLint config (lint rules)
#   - Husky pre-commit (git hook entry point)
#   - lint-staged config in package.json (enforced via hash check)
#
# Usage:
#   sudo bash .claude-framework/scripts/protect-framework.sh          # Enable protection
#   bash .claude-framework/scripts/protect-framework.sh status        # Check status
#   sudo bash .claude-framework/scripts/protect-framework.sh disable  # Temporarily disable
#
# ==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get script directory - works whether framework is local or symlinked
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Determine project directory
# If .claude-framework is a symlink, follow it to find the real framework
# The project dir is where .claude-framework points FROM, not TO
if [ -L "$FRAMEWORK_DIR" ]; then
    # Framework is symlinked - project dir contains the symlink
    PROJECT_DIR="$(cd "$(dirname "$(readlink -f "$FRAMEWORK_DIR")")/../.." && pwd)"
else
    # Framework is inside project - go up two levels
    PROJECT_DIR="$(cd "$FRAMEWORK_DIR/.." && pwd)"
fi

# Also check if we're being run from a project that symlinks to this framework
# by looking for common project markers
if [ ! -f "$PROJECT_DIR/package.json" ] && [ ! -d "$PROJECT_DIR/.git" ]; then
    # Try to find project dir by checking parent of script invocation
    INVOKE_DIR="$(pwd)"
    if [ -f "$INVOKE_DIR/package.json" ] || [ -d "$INVOKE_DIR/.git" ]; then
        PROJECT_DIR="$INVOKE_DIR"
    fi
fi

# Determine hooks directory - resolve symlink if needed
if [ -L "$PROJECT_DIR/.claude/hooks" ]; then
    HOOKS_DIR="$(readlink -f "$PROJECT_DIR/.claude/hooks")"
    USE_FRAMEWORK=true
elif [ -d "$PROJECT_DIR/.claude-framework/.claude/hooks" ]; then
    HOOKS_DIR="$PROJECT_DIR/.claude-framework/.claude/hooks"
    USE_FRAMEWORK=true
else
    HOOKS_DIR="$PROJECT_DIR/.claude/hooks"
    USE_FRAMEWORK=false
fi

# Files to protect (synced with setup.sh do_protect)
PROTECTED_FILES=(
    "$HOOKS_DIR/pre-commit-review.js"
    "$HOOKS_DIR/bypass-approval-hook.js"
    "$HOOKS_DIR/block-no-verify.js"
    "$HOOKS_DIR/protected-action-gate.js"
    "$HOOKS_DIR/protected-action-approval-hook.js"
    "$HOOKS_DIR/credential-file-guard.js"
    "$HOOKS_DIR/protected-actions.json"
    "$PROJECT_DIR/.claude/settings.json"
    "$PROJECT_DIR/.claude/protection-key"
    "$PROJECT_DIR/.mcp.json"
    "$PROJECT_DIR/.claude/config/services.json"
    "$PROJECT_DIR/eslint.config.js"
    "$PROJECT_DIR/.husky/pre-commit"
    "$PROJECT_DIR/package.json"
)

# Directories to protect (prevents deletion of protected files inside)
PROTECTED_DIRS=(
    "$PROJECT_DIR/.husky"
    "$PROJECT_DIR/.claude"
    "$HOOKS_DIR"
)

# State file for tracking protection
STATE_FILE="$PROJECT_DIR/.claude/protection-state.json"

# ==============================================================================
# Functions
# ==============================================================================

check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}Error: This script must be run with sudo${NC}"
        echo "Usage: sudo $0 [status|disable]"
        exit 1
    fi
}

get_original_user() {
    # Get the user who invoked sudo
    if [ -n "$SUDO_USER" ]; then
        echo "$SUDO_USER"
    else
        echo "$(logname 2>/dev/null || echo $USER)"
    fi
}

get_original_group() {
    local user="$(get_original_user)"
    # Get primary group for the user (returns "staff" on macOS, user's group on Linux)
    id -gn "$user" 2>/dev/null || echo "staff"
}

get_root_group() {
    # macOS uses "wheel" for root group, Linux uses "root"
    if [ "$(uname)" = "Darwin" ]; then
        echo "wheel"
    else
        echo "root"
    fi
}

protect_file() {
    local file="$1"
    local root_group="$(get_root_group)"

    if [ ! -f "$file" ]; then
        echo -e "  ${YELLOW}Skip: $file (not found)${NC}"
        return 0
    fi

    # Change ownership to root
    chown "root:$root_group" "$file"

    # Set permissions: readable by all, writable only by root
    # Husky hooks need execute permission to function as git hooks
    if [[ "$file" == *".husky/"* ]]; then
        chmod 755 "$file"
    else
        chmod 644 "$file"
    fi

    echo -e "  ${GREEN}Protected: $file${NC}"
}

unprotect_file() {
    local file="$1"
    local original_user="$2"
    local original_group="$3"

    if [ ! -f "$file" ]; then
        echo -e "  ${YELLOW}Skip: $file (not found)${NC}"
        return 0
    fi

    # Change ownership back to original user
    chown "$original_user:$original_group" "$file"

    # Set permissions: readable and writable by owner
    chmod 644 "$file"

    echo -e "  ${GREEN}Unprotected: $file${NC}"
}

check_file_protection() {
    local file="$1"

    if [ ! -f "$file" ]; then
        echo -e "  ${YELLOW}N/A: $file (not found)${NC}"
        return 2
    fi

    # macOS uses stat -f, Linux uses stat -c
    local owner perms
    if [ "$(uname)" = "Darwin" ]; then
        owner=$(stat -f '%Su' "$file")
        perms=$(stat -f '%Lp' "$file")
    else
        owner=$(stat -c '%U' "$file")
        perms=$(stat -c '%a' "$file")
    fi

    if [ "$owner" = "root" ] && [ "$perms" = "644" ]; then
        echo -e "  ${GREEN}PROTECTED: $file (owner: root, perms: 644)${NC}"
        return 0
    else
        echo -e "  ${RED}UNPROTECTED: $file (owner: $owner, perms: $perms)${NC}"
        return 1
    fi
}

protect_dir() {
    local dir="$1"
    local root_group="$(get_root_group)"

    if [ ! -d "$dir" ]; then
        echo -e "  ${YELLOW}Skip: $dir (not found)${NC}"
        return 0
    fi

    # Change ownership to root (prevents deletion by non-root)
    chown "root:$root_group" "$dir"

    # Set permissions: readable/executable by all, writable only by root
    # Sticky bit (1755) prevents users from deleting files they don't own
    chmod 1755 "$dir"

    echo -e "  ${GREEN}Protected dir: $dir${NC}"
}

unprotect_dir() {
    local dir="$1"
    local original_user="$2"
    local original_group="$3"

    if [ ! -d "$dir" ]; then
        echo -e "  ${YELLOW}Skip: $dir (not found)${NC}"
        return 0
    fi

    # Change ownership back to original user
    chown "$original_user:$original_group" "$dir"

    # Set permissions: standard directory permissions
    chmod 755 "$dir"

    echo -e "  ${GREEN}Unprotected dir: $dir${NC}"
}

check_dir_protection() {
    local dir="$1"

    if [ ! -d "$dir" ]; then
        echo -e "  ${YELLOW}N/A: $dir (not found)${NC}"
        return 2
    fi

    # macOS uses stat -f, Linux uses stat -c
    local owner perms
    if [ "$(uname)" = "Darwin" ]; then
        owner=$(stat -f '%Su' "$dir")
        perms=$(stat -f '%Lp' "$dir")
    else
        owner=$(stat -c '%U' "$dir")
        perms=$(stat -c '%a' "$dir")
    fi

    if [ "$owner" = "root" ] && ([ "$perms" = "1755" ] || [ "$perms" = "755" ]); then
        echo -e "  ${GREEN}PROTECTED: $dir (owner: root, perms: $perms)${NC}"
        return 0
    else
        echo -e "  ${RED}UNPROTECTED: $dir (owner: $owner, perms: $perms)${NC}"
        return 1
    fi
}

write_state() {
    local protected="$1"
    local timestamp=$(date -Iseconds)
    local user=$(get_original_user)

    mkdir -p "$(dirname "$STATE_FILE")"

    cat > "$STATE_FILE" << EOF
{
  "protected": $protected,
  "timestamp": "$timestamp",
  "modified_by": "$user",
  "files": [
    "$HOOKS_DIR/pre-commit-review.js",
    "$HOOKS_DIR/bypass-approval-hook.js",
    "$PROJECT_DIR/eslint.config.js",
    "$PROJECT_DIR/.husky/pre-commit"
  ]
}
EOF

    # Make state file readable by all
    chmod 644 "$STATE_FILE"
}

# ==============================================================================
# Commands
# ==============================================================================

cmd_status() {
    echo -e "${BLUE}Checking framework protection status...${NC}"
    echo ""

    echo "Project directory: $PROJECT_DIR"
    echo "Framework directory: $FRAMEWORK_DIR"

    if [ "$USE_FRAMEWORK" = true ]; then
        echo -e "Mode: ${GREEN}Framework${NC}"
        echo "Hooks directory: $HOOKS_DIR"
    else
        echo -e "Mode: ${YELLOW}Direct (no framework)${NC}"
        echo "Hooks directory: $HOOKS_DIR"
    fi
    echo ""

    local all_protected=true

    echo "Protected directories:"
    for dir in "${PROTECTED_DIRS[@]}"; do
        if ! check_dir_protection "$dir"; then
            all_protected=false
        fi
    done

    echo ""
    echo "Protected files:"
    for file in "${PROTECTED_FILES[@]}"; do
        if ! check_file_protection "$file"; then
            all_protected=false
        fi
    done

    echo ""
    if [ "$all_protected" = true ]; then
        echo -e "${GREEN}Status: All critical files and directories are protected${NC}"
        return 0
    else
        echo -e "${RED}Status: Some items are NOT protected${NC}"
        echo "Run: sudo bash $0"
        return 1
    fi
}

cmd_protect() {
    check_root

    echo -e "${BLUE}Enabling framework protection...${NC}"
    echo ""

    echo "Project directory: $PROJECT_DIR"
    if [ "$USE_FRAMEWORK" = true ]; then
        echo "Mode: Framework (protecting actual files, not symlinks)"
    else
        echo "Mode: Direct"
    fi
    echo ""

    echo "Protecting directories (prevents deletion):"
    for dir in "${PROTECTED_DIRS[@]}"; do
        protect_dir "$dir"
    done

    echo ""
    echo "Protecting files:"
    for file in "${PROTECTED_FILES[@]}"; do
        protect_file "$file"
    done

    write_state "true"

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Protection enabled!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Protected files and directories are now root-owned."
    echo "Agents cannot modify or delete them without sudo access."
    echo ""
    echo "To make changes, first run:"
    echo "  sudo bash $0 disable"
    echo ""
    echo "After making changes, re-enable protection:"
    echo "  sudo bash $0"
}

cmd_disable() {
    check_root

    local original_user=$(get_original_user)
    local original_group=$(get_original_group)

    echo -e "${YELLOW}Disabling framework protection...${NC}"
    echo ""
    echo "Restoring ownership to: $original_user:$original_group"
    echo ""

    echo "Unprotecting files:"
    for file in "${PROTECTED_FILES[@]}"; do
        unprotect_file "$file" "$original_user" "$original_group"
    done

    echo ""
    echo "Unprotecting directories:"
    for dir in "${PROTECTED_DIRS[@]}"; do
        unprotect_dir "$dir" "$original_user" "$original_group"
    done

    write_state "false"

    echo ""
    echo -e "${YELLOW}========================================${NC}"
    echo -e "${YELLOW}Protection DISABLED${NC}"
    echo -e "${YELLOW}========================================${NC}"
    echo ""
    echo -e "${RED}WARNING: Files can now be modified by agents!${NC}"
    echo ""
    echo "After making your changes, re-enable protection:"
    echo "  sudo $0"
}

cmd_help() {
    echo "GENTYR Protection Script"
    echo ""
    echo "Usage: sudo $0 [command]"
    echo ""
    echo "Commands:"
    echo "  (none)    Enable protection (make files root-owned)"
    echo "  status    Check current protection status (no sudo needed)"
    echo "  disable   Disable protection (restore user ownership)"
    echo "  help      Show this help message"
    echo ""
    echo "Protected files:"
    for file in "${PROTECTED_FILES[@]}"; do
        echo "  - $file"
    done
    echo ""
    echo "Why this works:"
    echo "  Claude Code agents run as your user. By making critical files"
    echo "  owned by root, agents cannot modify them (no sudo access)."
    echo "  This is the only truly unbypassable protection mechanism."
}

# ==============================================================================
# Main
# ==============================================================================

case "${1:-}" in
    status)
        cmd_status
        ;;
    disable)
        cmd_disable
        ;;
    help|--help|-h)
        cmd_help
        ;;
    "")
        cmd_protect
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        cmd_help
        exit 1
        ;;
esac
