#!/bin/bash
# GENTYR Setup Script
#
# Usage:
#   scripts/setup.sh --path /path/to/project                # Install
#   sudo scripts/setup.sh --path /path/to/project --protect # Install + protect
#   sudo scripts/setup.sh --path /path/to/project --uninstall  # Uninstall (auto-unprotects)
#   sudo scripts/setup.sh --path /path/to/project --protect-only   # Protect only
#   sudo scripts/setup.sh --path /path/to/project --unprotect-only # Unprotect only
#
# --path is required. Protection requires sudo.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# =============================================================================
# PARSE FLAGS
# =============================================================================

MODE="install"
PROTECT=false
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --uninstall)
            MODE="uninstall"
            shift
            ;;
        --protect)
            PROTECT=true
            shift
            ;;
        --protect-only)
            MODE="protect"
            shift
            ;;
        --unprotect-only)
            MODE="unprotect"
            shift
            ;;
        --path)
            PROJECT_DIR="$(cd "$2" 2>/dev/null && pwd)" || {
                echo -e "${RED}Error: directory does not exist: $2${NC}"
                exit 1
            }
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown flag: $1${NC}"
            echo "Usage: $0 --path <dir> [--protect] [--uninstall] [--protect-only] [--unprotect-only]"
            exit 1
            ;;
    esac
done

if [ -z "$PROJECT_DIR" ]; then
    echo -e "${RED}Error: --path is required${NC}"
    echo "Usage: $0 --path /path/to/project [--protect] [--uninstall]"
    exit 1
fi

# Framework-managed agents (individual file symlinks)
FRAMEWORK_AGENTS=(
    "investigator.md"
    "code-writer.md"
    "test-writer.md"
    "code-reviewer.md"
    "project-manager.md"
    "deputy-cto.md"
    "antipattern-hunter.md"
    "repo-hygiene-expert.md"
)

# =============================================================================
# PATH RESOLUTION
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(readlink -f "$SCRIPT_DIR/..")"
FRAMEWORK_REL=".claude-framework"

# =============================================================================
# PROTECTION HELPERS
# =============================================================================

# Resolve hooks dir (follows symlink to real files)
get_hooks_dir() {
    if [ -L "$PROJECT_DIR/.claude/hooks" ]; then
        readlink -f "$PROJECT_DIR/.claude/hooks"
    elif [ -d "$PROJECT_DIR/.claude-framework/.claude/hooks" ]; then
        echo "$PROJECT_DIR/.claude-framework/.claude/hooks"
    else
        echo "$PROJECT_DIR/.claude/hooks"
    fi
}

is_protected() {
    local state_file="$PROJECT_DIR/.claude/protection-state.json"
    if [ -f "$state_file" ] && grep -q '"protected": true' "$state_file" 2>/dev/null; then
        return 0
    fi
    return 1
}

require_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}Error: this operation requires sudo${NC}"
        echo "Usage: sudo $0 --path $PROJECT_DIR $1"
        exit 1
    fi
}

get_original_user() {
    if [ -n "$SUDO_USER" ]; then
        echo "$SUDO_USER"
    else
        logname 2>/dev/null || echo "$USER"
    fi
}

do_protect() {
    require_root "--protect"
    local hooks_dir="$(get_hooks_dir)"

    echo -e "${YELLOW}Enabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$PROJECT_DIR/.claude/settings.json"
        "$PROJECT_DIR/eslint.config.js"
        "$PROJECT_DIR/.husky/pre-commit"
        "$PROJECT_DIR/package.json"
    )

    local dirs=(
        "$PROJECT_DIR/.husky"
        "$PROJECT_DIR/.claude"
        "$hooks_dir"
    )

    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            chown root:root "$dir"
            chmod 1755 "$dir"
            echo "  Protected dir: $dir"
        fi
    done

    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            chown root:root "$file"
            # Husky hooks need execute permission to function as git hooks
            if [[ "$file" == *".husky/"* ]]; then
                chmod 755 "$file"
            else
                chmod 644 "$file"
            fi
            echo "  Protected: $file"
        fi
    done

    # Write state
    cat > "$PROJECT_DIR/.claude/protection-state.json" << EOF
{
  "protected": true,
  "timestamp": "$(date -Iseconds)",
  "modified_by": "$(get_original_user)"
}
EOF
    chmod 644 "$PROJECT_DIR/.claude/protection-state.json"

    echo -e "${GREEN}Protection enabled. Agents cannot modify critical files.${NC}"
}

do_unprotect() {
    require_root "--unprotect-only"
    local hooks_dir="$(get_hooks_dir)"
    local original_user="$(get_original_user)"

    echo -e "${YELLOW}Disabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$PROJECT_DIR/.claude/settings.json"
        "$PROJECT_DIR/.claude/TESTING.md"
        "$PROJECT_DIR/eslint.config.js"
        "$PROJECT_DIR/.husky/pre-commit"
        "$PROJECT_DIR/.husky/post-commit"
        "$PROJECT_DIR/.husky/pre-push"
        "$PROJECT_DIR/.mcp.json"
        "$PROJECT_DIR/package.json"
    )

    local dirs=(
        "$PROJECT_DIR/.husky"
        "$PROJECT_DIR/.claude"
        "$hooks_dir"
    )

    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            chown "$original_user:$original_user" "$file"
            chmod 644 "$file"
            echo "  Unprotected: $file"
        fi
    done

    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            chown "$original_user:$original_user" "$dir"
            chmod 755 "$dir"
            echo "  Unprotected dir: $dir"
        fi
    done

    # Bulk-fix any remaining root-owned files in project dirs (not following symlinks)
    if [ -d "$PROJECT_DIR/.husky" ]; then
        find "$PROJECT_DIR/.husky" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_user" {} \;
    fi
    if [ -d "$PROJECT_DIR/.claude" ]; then
        find "$PROJECT_DIR/.claude" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_user" {} \;
    fi
    if [ -d "$PROJECT_DIR/.claude/state" ]; then
        find "$PROJECT_DIR/.claude/state" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_user" {} \;
    fi

    # Write state
    cat > "$PROJECT_DIR/.claude/protection-state.json" << EOF
{
  "protected": false,
  "timestamp": "$(date -Iseconds)",
  "modified_by": "$original_user"
}
EOF

    echo -e "${GREEN}Protection disabled.${NC}"
}

# =============================================================================
# PROTECT-ONLY MODE
# =============================================================================

if [ "$MODE" = "protect" ]; then
    do_protect
    exit 0
fi

# =============================================================================
# UNPROTECT-ONLY MODE
# =============================================================================

if [ "$MODE" = "unprotect" ]; then
    do_unprotect
    exit 0
fi

# =============================================================================
# INSTALL MODE
# =============================================================================

if [ "$MODE" = "install" ]; then

# Check if --protect was requested, require sudo upfront
if [ "$PROTECT" = true ]; then
    require_root "--protect"
fi

# Create or verify symlink
if [ -L "$PROJECT_DIR/.claude-framework" ]; then
    REAL_EXISTING="$(readlink -f "$PROJECT_DIR/.claude-framework")"
    if [ "$REAL_EXISTING" != "$FRAMEWORK_DIR" ]; then
        echo -e "${RED}Error: .claude-framework already symlinked to a different framework${NC}"
        echo "  Existing: $REAL_EXISTING"
        echo "  This: $FRAMEWORK_DIR"
        exit 1
    fi
elif [ -d "$PROJECT_DIR/.claude-framework" ]; then
    echo -e "${RED}Error: .claude-framework exists as a directory (submodule?)${NC}"
    exit 1
else
    ln -s "$FRAMEWORK_DIR" "$PROJECT_DIR/.claude-framework"
    echo -e "${GREEN}Created symlink: .claude-framework -> $FRAMEWORK_DIR${NC}"
fi

echo -e "${GREEN}Installing GENTYR...${NC}"
echo ""

# --- 1. Symlinks ---
echo -e "${YELLOW}Setting up .claude/ directory...${NC}"
mkdir -p "$PROJECT_DIR/.claude"
mkdir -p "$PROJECT_DIR/.claude/state"

# Pre-create runtime state files so they exist (user-owned) before protection
# Protection locks .claude/ with sticky bit, preventing NEW file creation
for state_file in \
    "$PROJECT_DIR/.claude/state/agent-tracker-history.json" \
    "$PROJECT_DIR/.claude/state/antipattern-hunter-state.json" \
    "$PROJECT_DIR/.claude/state/schema-mapper-state.json" \
    "$PROJECT_DIR/.claude/state/usage-snapshots.json" \
    "$PROJECT_DIR/.claude/hourly-automation-state.json" \
    "$PROJECT_DIR/.claude/plan-executor-state.json" \
    "$PROJECT_DIR/.claude/autonomous-mode.json" \
    "$PROJECT_DIR/.claude/bypass-approval-token.json" \
    "$PROJECT_DIR/.claude/protection-state.json"; do
    [ -f "$state_file" ] || echo '{}' > "$state_file"
done

# Pre-create automation config with defaults if not exists
if [ ! -f "$PROJECT_DIR/.claude/state/automation-config.json" ]; then
    cat > "$PROJECT_DIR/.claude/state/automation-config.json" << 'CONFIGEOF'
{
  "version": 1,
  "defaults": {
    "hourly_tasks": 55,
    "triage_check": 5,
    "plan_executor": 55,
    "antipattern_hunter": 360,
    "schema_mapper": 1440,
    "lint_checker": 30,
    "todo_maintenance": 15,
    "triage_per_item": 60
  },
  "effective": {
    "hourly_tasks": 55,
    "triage_check": 5,
    "plan_executor": 55,
    "antipattern_hunter": 360,
    "schema_mapper": 1440,
    "lint_checker": 30,
    "todo_maintenance": 15,
    "triage_per_item": 60
  },
  "adjustment": {
    "factor": 1.0,
    "last_updated": null,
    "constraining_metric": null,
    "projected_at_reset": null
  }
}
CONFIGEOF
fi

# Directory symlinks for commands, hooks, mcp
for item in commands hooks mcp; do
    if [ -L "$PROJECT_DIR/.claude/$item" ]; then
        rm "$PROJECT_DIR/.claude/$item"
    fi
    if [ -d "$PROJECT_DIR/.claude/$item" ]; then
        echo -e "${YELLOW}  Moving existing $item/ to $item.backup/${NC}"
        mv "$PROJECT_DIR/.claude/$item" "$PROJECT_DIR/.claude/$item.backup"
    fi
    ln -sf "../$FRAMEWORK_REL/.claude/$item" "$PROJECT_DIR/.claude/$item"
    echo "  Symlink: .claude/$item"
done

# Individual file symlinks for agents
echo "  Setting up agents (individual symlinks)..."

# If agents is a directory symlink (old approach), remove it
if [ -L "$PROJECT_DIR/.claude/agents" ]; then
    rm "$PROJECT_DIR/.claude/agents"
    echo "    Removed legacy agents directory symlink"
fi

# If agents is a real dir with conflicting framework-named files, back them up
if [ -d "$PROJECT_DIR/.claude/agents" ]; then
    for agent in "${FRAMEWORK_AGENTS[@]}"; do
        if [ -f "$PROJECT_DIR/.claude/agents/$agent" ] && [ ! -L "$PROJECT_DIR/.claude/agents/$agent" ]; then
            mkdir -p "$PROJECT_DIR/.claude/agents.backup"
            mv "$PROJECT_DIR/.claude/agents/$agent" "$PROJECT_DIR/.claude/agents.backup/$agent"
            echo -e "${YELLOW}    Backed up existing $agent${NC}"
        fi
    done
fi

# Create agents directory if needed
mkdir -p "$PROJECT_DIR/.claude/agents"

# Restore any non-framework agents from agents.backup (project-specific ones displaced by old migration)
if [ -d "$PROJECT_DIR/.claude/agents.backup" ]; then
    for file in "$PROJECT_DIR/.claude/agents.backup"/*.md; do
        [ -f "$file" ] || continue
        basename_file="$(basename "$file")"
        # Only restore if it's not a framework agent
        is_framework=false
        for agent in "${FRAMEWORK_AGENTS[@]}"; do
            if [ "$basename_file" = "$agent" ]; then
                is_framework=true
                break
            fi
        done
        if [ "$is_framework" = false ] && [ ! -f "$PROJECT_DIR/.claude/agents/$basename_file" ]; then
            mv "$file" "$PROJECT_DIR/.claude/agents/$basename_file"
            echo -e "${GREEN}    Restored project agent: $basename_file${NC}"
        fi
    done
    # Clean up backup dir if empty
    rmdir "$PROJECT_DIR/.claude/agents.backup" 2>/dev/null || true
fi

# Create individual symlinks for framework agents
for agent in "${FRAMEWORK_AGENTS[@]}"; do
    ln -sf "../../$FRAMEWORK_REL/.claude/agents/$agent" "$PROJECT_DIR/.claude/agents/$agent"
done
echo "  Symlink: .claude/agents/ (${#FRAMEWORK_AGENTS[@]} framework agents)"

# --- 2. Settings + TESTING.md ---
echo ""
echo -e "${YELLOW}Setting up settings.json...${NC}"
if [ ! -f "$PROJECT_DIR/.claude/settings.json" ]; then
    cp "$FRAMEWORK_DIR/.claude/settings.json.template" "$PROJECT_DIR/.claude/settings.json"
    echo "  Created .claude/settings.json from template"
else
    echo "  Keeping existing .claude/settings.json"
fi
if cp "$FRAMEWORK_DIR/TESTING.md" "$PROJECT_DIR/.claude/TESTING.md" 2>/dev/null; then
    echo "  Copied TESTING.md -> .claude/TESTING.md"
else
    echo -e "  ${YELLOW}Skipped TESTING.md (file is root-owned, will update on next sudo install)${NC}"
fi

# --- 3. MCP config ---
echo ""
echo -e "${YELLOW}Generating .mcp.json...${NC}"
if sed "s|\${FRAMEWORK_PATH}|$FRAMEWORK_REL|g" \
    "$FRAMEWORK_DIR/.mcp.json.template" > "$PROJECT_DIR/.mcp.json" 2>/dev/null; then
    echo "  Generated .mcp.json"
else
    echo -e "  ${YELLOW}Skipped .mcp.json (file is root-owned, will update on next sudo install)${NC}"
fi

# --- 4. Husky hooks ---
echo ""
echo -e "${YELLOW}Setting up husky hooks...${NC}"
mkdir -p "$PROJECT_DIR/.husky"
for hook in pre-commit post-commit pre-push; do
    if [ -f "$FRAMEWORK_DIR/husky/$hook" ]; then
        cp "$FRAMEWORK_DIR/husky/$hook" "$PROJECT_DIR/.husky/$hook"
        chmod +x "$PROJECT_DIR/.husky/$hook"
        echo "  Installed .husky/$hook"
    fi
done

# --- 5. Install dependencies ---
echo ""
echo -e "${YELLOW}Installing hook dependencies...${NC}"
cd "$FRAMEWORK_DIR"
if [ ! -d "node_modules" ]; then
    npm install
fi
echo "  Hook dependencies ready"

echo ""
echo -e "${YELLOW}Building MCP servers...${NC}"
cd "$FRAMEWORK_DIR/packages/mcp-servers"
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
fi
echo "  Building TypeScript..."
npm run build
cd "$PROJECT_DIR"

# --- 6. Automation Service ---
echo ""
echo -e "${YELLOW}Setting up automation service (10-min timer)...${NC}"
if [ -x "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" ]; then
    "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" setup --path "$PROJECT_DIR"
else
    echo -e "  ${YELLOW}setup-automation-service.sh not found or not executable, skipping.${NC}"
fi

# --- 7. Gitignore ---
echo ""
echo -e "${YELLOW}Updating .gitignore...${NC}"
GITIGNORE_ENTRIES="
# GENTYR runtime
.claude/*.db
.claude/*.db-shm
.claude/*.db-wal
.claude/*-state.json
.claude/*.log
.claude/api-key-rotation.json
.claude/commit-approval-token.json
.claude/autonomous-mode.json
.claude/state/
.claude/settings.local.json
"
if ! grep -q "# GENTYR runtime" "$PROJECT_DIR/.gitignore" 2>/dev/null; then
    echo "$GITIGNORE_ENTRIES" >> "$PROJECT_DIR/.gitignore"
    echo "  Added runtime exclusions to .gitignore"
else
    echo "  .gitignore already configured"
fi

# --- 7. Specs directory ---
echo ""
echo -e "${YELLOW}Checking specs directory...${NC}"
if [ ! -d "$PROJECT_DIR/specs" ]; then
    mkdir -p "$PROJECT_DIR/specs/global" "$PROJECT_DIR/specs/local" "$PROJECT_DIR/specs/reference"
    cat > "$PROJECT_DIR/specs/global/CORE-INVARIANTS.md" << 'EOF'
# Core Invariants

## G001: Fail-Closed Error Handling
All error handling must fail-closed. Never fail-open.

## G003: Input Validation
Validate all external input with Zod schemas.

## G004: No Hardcoded Credentials
Never commit credentials, API keys, or secrets.
EOF
    echo "  Created specs/ directory structure"
else
    echo "  specs/ directory already exists"
fi

# --- 8. Protection (if requested) ---
if [ "$PROTECT" = true ]; then
    echo ""
    do_protect
fi

# Done
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}GENTYR installed!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Framework version: $(cat "$FRAMEWORK_DIR/version.json" 2>/dev/null | grep version | cut -d'"' -f4 || echo "1.0.0")"

# =============================================================================
# UNINSTALL MODE
# =============================================================================

else

# Unprotect first if needed
if is_protected; then
    require_root "--uninstall"
    do_unprotect
    echo ""
fi

echo -e "${YELLOW}Uninstalling GENTYR from $PROJECT_DIR...${NC}"
echo ""

# --- Remove automation service ---
echo -e "${YELLOW}Removing automation service...${NC}"
if [ -x "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" ]; then
    "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" remove --path "$PROJECT_DIR"
elif [ -x "$PROJECT_DIR/.claude-framework/scripts/setup-automation-service.sh" ]; then
    "$PROJECT_DIR/.claude-framework/scripts/setup-automation-service.sh" remove --path "$PROJECT_DIR"
else
    echo "  setup-automation-service.sh not found, skipping service removal."
fi
echo ""

# --- Remove .claude/ symlinks ---
echo -e "${YELLOW}Removing symlinks from .claude/...${NC}"

# Remove directory symlinks for commands, hooks, mcp
for item in commands hooks mcp; do
    if [ -L "$PROJECT_DIR/.claude/$item" ]; then
        rm "$PROJECT_DIR/.claude/$item"
        echo "  Removed: .claude/$item"
    fi
done
for item in commands hooks mcp; do
    if [ -d "$PROJECT_DIR/.claude/${item}.backup" ]; then
        mv "$PROJECT_DIR/.claude/${item}.backup" "$PROJECT_DIR/.claude/$item"
        echo -e "${GREEN}  Restored backup: .claude/$item${NC}"
    fi
done

# Handle agents: remove only framework agent symlinks, preserve project-specific files
if [ -L "$PROJECT_DIR/.claude/agents" ]; then
    # Legacy: agents is still a directory symlink (never re-ran setup with new approach)
    rm "$PROJECT_DIR/.claude/agents"
    echo "  Removed: .claude/agents (legacy directory symlink)"
elif [ -d "$PROJECT_DIR/.claude/agents" ]; then
    # New approach: remove individual framework agent symlinks
    for agent in "${FRAMEWORK_AGENTS[@]}"; do
        if [ -L "$PROJECT_DIR/.claude/agents/$agent" ]; then
            rm "$PROJECT_DIR/.claude/agents/$agent"
        fi
    done
    echo "  Removed: ${#FRAMEWORK_AGENTS[@]} framework agent symlinks"

    # Count remaining project-specific agents
    remaining=$(find "$PROJECT_DIR/.claude/agents" -maxdepth 1 -type f -name "*.md" 2>/dev/null | wc -l)
    if [ "$remaining" -gt 0 ]; then
        echo -e "${GREEN}  Preserved: $remaining project-specific agent(s)${NC}"
    fi

    # Only remove the directory if empty
    rmdir "$PROJECT_DIR/.claude/agents" 2>/dev/null && echo "  Removed empty .claude/agents/" || true
fi

# Restore agents.backup if it exists
if [ -d "$PROJECT_DIR/.claude/agents.backup" ]; then
    mkdir -p "$PROJECT_DIR/.claude/agents"
    for file in "$PROJECT_DIR/.claude/agents.backup"/*.md; do
        [ -f "$file" ] || continue
        mv "$file" "$PROJECT_DIR/.claude/agents/$(basename "$file")"
    done
    rmdir "$PROJECT_DIR/.claude/agents.backup" 2>/dev/null || true
    echo -e "${GREEN}  Restored agents from backup${NC}"
fi
echo ""

# --- Remove generated files ---
echo -e "${YELLOW}Removing generated files...${NC}"
if [ -f "$PROJECT_DIR/.mcp.json" ] && grep -q "claude-framework" "$PROJECT_DIR/.mcp.json" 2>/dev/null; then
    rm "$PROJECT_DIR/.mcp.json"
    echo "  Removed .mcp.json"
fi
echo ""

# --- Remove husky hooks ---
echo -e "${YELLOW}Removing husky hooks...${NC}"
for hook in pre-commit post-commit pre-push; do
    if [ -f "$PROJECT_DIR/.husky/$hook" ] && grep -q ".claude/hooks/" "$PROJECT_DIR/.husky/$hook" 2>/dev/null; then
        rm "$PROJECT_DIR/.husky/$hook"
        echo "  Removed .husky/$hook"
    fi
done
echo ""

# --- Remove framework symlink ---
if [ -L "$PROJECT_DIR/.claude-framework" ]; then
    rm "$PROJECT_DIR/.claude-framework"
    echo "  Removed .claude-framework symlink"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}GENTYR uninstalled!${NC}"
echo -e "${GREEN}========================================${NC}"

fi
