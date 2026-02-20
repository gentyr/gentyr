#!/bin/bash
# GENTYR Setup Script
#
# Usage:
#   scripts/setup.sh --path /path/to/project --op-token <token>  # Install with OP token
#   sudo scripts/setup.sh --path /path/to/project --protect     # Install + protect
#   sudo scripts/setup.sh --path /path/to/project --uninstall  # Uninstall (auto-unprotects)
#   sudo scripts/setup.sh --path /path/to/project --protect-only   # Protect only
#   sudo scripts/setup.sh --path /path/to/project --unprotect-only # Unprotect only
#   scripts/setup.sh --scaffold --path /path/to/new-project   # Scaffold new project
#
# --path is required. Protection requires sudo.

set -eo pipefail

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
PROTECT_MCP=false
RECONFIGURE_MCP=false
SCAFFOLD=false
PROJECT_DIR=""
OP_TOKEN=""
MAKERKIT_FLAG=""  # "", "force", or "skip"

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
        --protect-mcp)
            PROTECT_MCP=true
            shift
            ;;
        --reconfigure)
            RECONFIGURE_MCP=true
            shift
            ;;
        --scaffold)
            SCAFFOLD=true
            shift
            ;;
        --makerkit)
            MAKERKIT_FLAG="force"
            shift
            ;;
        --no-makerkit)
            MAKERKIT_FLAG="skip"
            shift
            ;;
        --op-token)
            if [ -z "$2" ] || [[ "$2" == --* ]]; then
                echo -e "${RED}Error: --op-token requires a value${NC}"
                exit 1
            fi
            OP_TOKEN="$2"
            shift 2
            ;;
        --path)
            if [ "$SCAFFOLD" = true ] && [ ! -d "$2" ]; then
                # For scaffold mode, allow non-existent directory (will be created)
                PROJECT_DIR="$(cd "$(dirname "$2")" 2>/dev/null && echo "$(pwd)/$(basename "$2")")" || {
                    echo -e "${RED}Error: parent directory does not exist: $(dirname "$2")${NC}"
                    exit 1
                }
            else
                PROJECT_DIR="$(cd "$2" 2>/dev/null && pwd)" || {
                    echo -e "${RED}Error: directory does not exist: $2${NC}"
                    exit 1
                }
            fi
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown flag: $1${NC}"
            echo "Usage: $0 --path <dir> [--op-token <token>] [--protect] [--protect-mcp] [--reconfigure] [--scaffold] [--makerkit] [--no-makerkit] [--uninstall] [--protect-only] [--unprotect-only]"
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
    "secret-manager.md"
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

get_original_group() {
    local user="$(get_original_user)"
    local group
    group="$(id -gn "$user" 2>/dev/null)" || group=""
    if [ -z "$group" ]; then
        if [ "$(uname)" = "Darwin" ]; then echo "staff"; else echo "$user"; fi
    else
        echo "$group"
    fi
}

do_protect() {
    require_root "--protect"
    local hooks_dir="$(get_hooks_dir)"
    # macOS root group is "wheel", Linux is "root"
    local root_group="root"
    if [ "$(uname -s)" = "Darwin" ]; then
        root_group="wheel"
    fi

    echo -e "${YELLOW}Enabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$hooks_dir/protected-action-gate.js"
        "$hooks_dir/protected-action-approval-hook.js"
        "$hooks_dir/credential-file-guard.js"
        "$hooks_dir/secret-leak-detector.js"
        "$hooks_dir/protected-actions.json"
        "$PROJECT_DIR/.claude/settings.json"
        "$PROJECT_DIR/.claude/protection-key"
        "$PROJECT_DIR/.mcp.json"
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
            chown "root:$root_group" "$dir"
            chmod 1755 "$dir"
            echo "  Protected dir: $dir"
        fi
    done

    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            chown "root:$root_group" "$file"
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
    local original_group="$(get_original_group)"

    echo -e "${YELLOW}Disabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$hooks_dir/protected-action-gate.js"
        "$hooks_dir/protected-action-approval-hook.js"
        "$hooks_dir/credential-file-guard.js"
        "$hooks_dir/secret-leak-detector.js"
        "$hooks_dir/protected-actions.json"
        "$PROJECT_DIR/.claude/settings.json"
        "$PROJECT_DIR/.claude/TESTING.md"
        "$PROJECT_DIR/.claude/protection-key"
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
            chown "$original_user:$original_group" "$file"
            chmod 644 "$file"
            echo "  Unprotected: $file"
        fi
    done

    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            chown "$original_user:$original_group" "$dir"
            chmod 755 "$dir"
            echo "  Unprotected dir: $dir"
        fi
    done

    # Bulk-fix any remaining root-owned files in project dirs (not following symlinks)
    if [ -d "$PROJECT_DIR/.husky" ]; then
        find "$PROJECT_DIR/.husky" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_group" {} \;
    fi
    if [ -d "$PROJECT_DIR/.claude" ]; then
        find "$PROJECT_DIR/.claude" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_group" {} \;
    fi
    if [ -d "$PROJECT_DIR/.claude/state" ]; then
        find "$PROJECT_DIR/.claude/state" -maxdepth 1 -type f -user root -exec chown "$original_user:$original_group" {} \;
    fi
    # Fix agents directory and symlinks within it
    if [ -d "$PROJECT_DIR/.claude/agents" ]; then
        chown "$original_user:$original_group" "$PROJECT_DIR/.claude/agents"
        chmod 755 "$PROJECT_DIR/.claude/agents"
        find "$PROJECT_DIR/.claude/agents" -maxdepth 1 -user root -exec chown -h "$original_user:$original_group" {} \;
        echo "  Unprotected dir: $PROJECT_DIR/.claude/agents"
    fi
    # Fix reporters directory and symlinks within it
    if [ -d "$PROJECT_DIR/.claude/reporters" ]; then
        chown "$original_user:$original_group" "$PROJECT_DIR/.claude/reporters"
        chmod 755 "$PROJECT_DIR/.claude/reporters"
        find "$PROJECT_DIR/.claude/reporters" -maxdepth 1 -user root -exec chown -h "$original_user:$original_group" {} \;
        echo "  Unprotected dir: $PROJECT_DIR/.claude/reporters"
    fi

    # Fix framework build/install directories (may be root-owned from previous runs under sudo)
    for framework_subdir in \
        "$FRAMEWORK_DIR/packages/mcp-servers/dist" \
        "$FRAMEWORK_DIR/packages/mcp-servers/node_modules" \
        "$FRAMEWORK_DIR/node_modules"; do
        if [ -d "$framework_subdir" ]; then
            chown -R "$original_user:$original_group" "$framework_subdir"
            echo "  Unprotected dir: $framework_subdir"
        fi
    done

    # Fix LaunchAgents plist (macOS) - may be root-owned from previous sudo install
    local plist_file="$REAL_HOME/Library/LaunchAgents/com.local.plan-executor.plist"
    if [ -f "$plist_file" ] && [ "$(stat -f '%u' "$plist_file" 2>/dev/null)" = "0" ]; then
        chown "$original_user:$original_group" "$plist_file"
        echo "  Unprotected: $plist_file"
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
# SCAFFOLD MODE
# =============================================================================

if [ "$SCAFFOLD" = true ]; then
    TEMPLATES_DIR="$FRAMEWORK_DIR/templates"

    if [ ! -d "$TEMPLATES_DIR" ]; then
        echo -e "${RED}Error: templates directory not found at $TEMPLATES_DIR${NC}"
        exit 1
    fi

    # Check if project already has code
    if [ -f "$PROJECT_DIR/package.json" ]; then
        echo -e "${YELLOW}Warning: $PROJECT_DIR already has a package.json.${NC}"
        read -p "This looks like an existing project. Continue scaffolding? (y/N): " confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            echo "Aborted."
            exit 0
        fi
    fi

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}GENTYR Project Scaffold${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    # Collect project info
    DEFAULT_PROJECT_NAME="$(basename "$PROJECT_DIR")"
    read -p "Project name [$DEFAULT_PROJECT_NAME]: " PROJECT_NAME
    PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"

    read -p "Product name (e.g. my-app): " PRODUCT_NAME
    if [ -z "$PRODUCT_NAME" ]; then
        echo -e "${RED}Product name is required.${NC}"
        exit 1
    fi

    read -p "GitHub org/user: " GITHUB_ORG
    GITHUB_ORG="${GITHUB_ORG:-my-org}"

    read -p "GitHub repo [$PROJECT_NAME]: " GITHUB_REPO
    GITHUB_REPO="${GITHUB_REPO:-$PROJECT_NAME}"

    read -p "Domain (e.g. example.com) [localhost]: " DOMAIN
    DOMAIN="${DOMAIN:-localhost}"

    echo ""
    echo -e "${YELLOW}Scaffolding project...${NC}"
    echo "  Project: $PROJECT_NAME"
    echo "  Product: $PRODUCT_NAME"
    echo "  GitHub:  $GITHUB_ORG/$GITHUB_REPO"
    echo "  Domain:  $DOMAIN"
    echo ""

    # Create project directory
    mkdir -p "$PROJECT_DIR"

    # --- Config templates ---
    echo -e "${YELLOW}Creating configuration files...${NC}"

    # pnpm-workspace.yaml (no substitution needed)
    if [ -f "$TEMPLATES_DIR/config/pnpm-workspace.yaml" ]; then
        cp "$TEMPLATES_DIR/config/pnpm-workspace.yaml" "$PROJECT_DIR/pnpm-workspace.yaml"
        echo "  Created pnpm-workspace.yaml"
    fi

    # tsconfig.base.json
    if [ -f "$TEMPLATES_DIR/config/tsconfig.base.json" ]; then
        cp "$TEMPLATES_DIR/config/tsconfig.base.json" "$PROJECT_DIR/tsconfig.base.json"
        echo "  Created tsconfig.base.json"
    fi

    # package.json (with substitution)
    if [ -f "$TEMPLATES_DIR/config/package.json.template" ]; then
        sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
            -e "s|{{PRODUCT_NAME}}|$PRODUCT_NAME|g" \
            -e "s|{{GITHUB_ORG}}|$GITHUB_ORG|g" \
            -e "s|{{GITHUB_REPO}}|$GITHUB_REPO|g" \
            -e "s|{{DOMAIN}}|$DOMAIN|g" \
            "$TEMPLATES_DIR/config/package.json.template" > "$PROJECT_DIR/package.json"
        echo "  Created package.json"
    fi

    # .gitignore
    if [ -f "$TEMPLATES_DIR/config/gitignore.template" ]; then
        cp "$TEMPLATES_DIR/config/gitignore.template" "$PROJECT_DIR/.gitignore"
        echo "  Created .gitignore"
    fi

    # services.json
    if [ -f "$TEMPLATES_DIR/config/services.json.template" ]; then
        mkdir -p "$PROJECT_DIR/.claude/config"
        sed -e "s|{{PRODUCT_NAME}}|$PRODUCT_NAME|g" \
            "$TEMPLATES_DIR/config/services.json.template" > "$PROJECT_DIR/.claude/config/services.json"
        echo "  Created .claude/config/services.json"
    fi

    # --- Scaffold templates ---
    echo ""
    echo -e "${YELLOW}Creating project structure...${NC}"

    # Shared packages
    if [ -d "$TEMPLATES_DIR/scaffold/packages" ]; then
        for pkg_dir in "$TEMPLATES_DIR/scaffold/packages"/*/; do
            [ -d "$pkg_dir" ] || continue
            pkg_name="$(basename "$pkg_dir")"
            mkdir -p "$PROJECT_DIR/packages/$pkg_name"

            # Copy all files, performing substitution
            while IFS= read -r -d '' file; do
                rel_path="${file#$pkg_dir}"
                dest_dir="$PROJECT_DIR/packages/$pkg_name/$(dirname "$rel_path")"
                mkdir -p "$dest_dir"
                sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
                    -e "s|{{PRODUCT_NAME}}|$PRODUCT_NAME|g" \
                    -e "s|{{GITHUB_ORG}}|$GITHUB_ORG|g" \
                    -e "s|{{GITHUB_REPO}}|$GITHUB_REPO|g" \
                    -e "s|{{DOMAIN}}|$DOMAIN|g" \
                    "$file" > "$dest_dir/$(basename "$file")"
            done < <(find "$pkg_dir" -type f -print0)
            echo "  Created packages/$pkg_name/"
        done
    fi

    # Product directory (rename _product to actual product name)
    if [ -d "$TEMPLATES_DIR/scaffold/products/_product" ]; then
        while IFS= read -r -d '' file; do
            rel_path="${file#$TEMPLATES_DIR/scaffold/products/_product/}"
            dest_dir="$PROJECT_DIR/products/$PRODUCT_NAME/$(dirname "$rel_path")"
            mkdir -p "$dest_dir"
            sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
                -e "s|{{PRODUCT_NAME}}|$PRODUCT_NAME|g" \
                -e "s|{{GITHUB_ORG}}|$GITHUB_ORG|g" \
                -e "s|{{GITHUB_REPO}}|$GITHUB_REPO|g" \
                -e "s|{{DOMAIN}}|$DOMAIN|g" \
                "$file" > "$dest_dir/$(basename "$file")"
        done < <(find "$TEMPLATES_DIR/scaffold/products/_product" -type f -print0)
        echo "  Created products/$PRODUCT_NAME/"
    fi

    # Specs directories (just .gitkeep files)
    if [ -d "$TEMPLATES_DIR/scaffold/specs" ]; then
        for spec_dir in "$TEMPLATES_DIR/scaffold/specs"/*/; do
            [ -d "$spec_dir" ] || continue
            spec_name="$(basename "$spec_dir")"
            mkdir -p "$PROJECT_DIR/specs/$spec_name"
            touch "$PROJECT_DIR/specs/$spec_name/.gitkeep"
        done
        echo "  Created specs/{global,local,reference}/"
    fi

    # Integrations template directory
    if [ -d "$TEMPLATES_DIR/scaffold/integrations" ]; then
        mkdir -p "$PROJECT_DIR/integrations/_template"
        touch "$PROJECT_DIR/integrations/_template/.gitkeep"
        echo "  Created integrations/_template/"
    fi

    # --- Git init ---
    echo ""
    echo -e "${YELLOW}Initializing git...${NC}"
    if [ ! -d "$PROJECT_DIR/.git" ]; then
        cd "$PROJECT_DIR"
        git init
        echo "  Initialized git repository"
        cd - > /dev/null
    else
        echo "  Git already initialized"
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Project scaffolded at: $PROJECT_DIR${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Install GENTYR:  $FRAMEWORK_DIR/scripts/setup.sh --path $PROJECT_DIR"
    echo "  2. Install deps:    cd $PROJECT_DIR && pnpm install"
    echo "  3. Configure creds: Run /setup-gentyr in Claude Code"
    echo ""
    exit 0
fi

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
    "$PROJECT_DIR/.claude/bypass-approval-token.json" \
    "$PROJECT_DIR/.claude/protection-state.json" \
    "$PROJECT_DIR/.claude/protected-action-approvals.json"; do
    [ -f "$state_file" ] || echo '{}' > "$state_file"
done

# Pre-create autonomous-mode.json with all automations enabled by default
# This eliminates the need for manual configuration after GENTYR installation
auto_mode_file="$PROJECT_DIR/.claude/autonomous-mode.json"
if [ ! -f "$auto_mode_file" ]; then
    cat > "$auto_mode_file" << 'AUTOEOF'
{
  "enabled": true,
  "claudeMdRefactorEnabled": true,
  "lintCheckerEnabled": true,
  "taskRunnerEnabled": true,
  "previewPromotionEnabled": true,
  "stagingPromotionEnabled": true,
  "stagingHealthMonitorEnabled": true,
  "productionHealthMonitorEnabled": true,
  "standaloneAntipatternHunterEnabled": true,
  "standaloneComplianceCheckerEnabled": true
}
AUTOEOF
fi

# Pre-create vault-mappings.json for MCP launcher credential resolution
# This is populated interactively via /setup-gentyr in the Claude Code session
vault_mappings="$PROJECT_DIR/.claude/vault-mappings.json"
if [ ! -f "$vault_mappings" ]; then
    echo '{"provider": "1password", "mappings": {}}' > "$vault_mappings"
    echo "  Created vault-mappings.json (configure via /setup-gentyr)"
fi

# Pre-create SQLite database files for MCP servers
# These must exist before protection since sticky bit prevents new file creation
# Also create WAL journal files (-shm, -wal) since SQLite needs them
for db_file in \
    "$PROJECT_DIR/.claude/todo.db" \
    "$PROJECT_DIR/.claude/deputy-cto.db" \
    "$PROJECT_DIR/.claude/cto-reports.db" \
    "$PROJECT_DIR/.claude/session-events.db"; do
    [ -f "$db_file" ] || touch "$db_file"
    [ -f "${db_file}-shm" ] || touch "${db_file}-shm"
    [ -f "${db_file}-wal" ] || touch "${db_file}-wal"
done

# When running under sudo, ensure pre-created files are owned by the original user
# This allows MCP servers to write to these files after protection is applied
if [ "$EUID" -eq 0 ]; then
    original_user="$(get_original_user)"
    original_group="$(get_original_group)"
    chown -R "$original_user:$original_group" "$PROJECT_DIR/.claude/state/"
    chown "$original_user:$original_group" "$PROJECT_DIR/.claude"/*.json 2>/dev/null || true
    chown "$original_user:$original_group" "$PROJECT_DIR/.claude"/*.db 2>/dev/null || true
    chown "$original_user:$original_group" "$PROJECT_DIR/.claude"/*.db-shm 2>/dev/null || true
    chown "$original_user:$original_group" "$PROJECT_DIR/.claude"/*.db-wal 2>/dev/null || true
    # Fix ownership of .mcp.json (generated in project root, not in .claude/)
    if [ -f "$PROJECT_DIR/.mcp.json" ]; then
        chown "$original_user:$original_group" "$PROJECT_DIR/.mcp.json"
    fi
fi

# Pre-create automation config with defaults if not exists
if [ ! -f "$PROJECT_DIR/.claude/state/automation-config.json" ]; then
    cat > "$PROJECT_DIR/.claude/state/automation-config.json" << 'CONFIGEOF'
{
  "version": 1,
  "defaults": {
    "hourly_tasks": 55,
    "triage_check": 5,
    "antipattern_hunter": 360,
    "schema_mapper": 1440,
    "lint_checker": 30,
    "todo_maintenance": 15,
    "task_runner": 60,
    "triage_per_item": 60
  },
  "effective": {
    "hourly_tasks": 55,
    "triage_check": 5,
    "antipattern_hunter": 360,
    "schema_mapper": 1440,
    "lint_checker": 30,
    "todo_maintenance": 15,
    "task_runner": 60,
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

# Symlink docs/shared for agent-accessible documentation
if [ -L "$PROJECT_DIR/.claude/docs" ]; then
    rm "$PROJECT_DIR/.claude/docs"
fi
if [ -d "$PROJECT_DIR/.claude/docs" ]; then
    echo -e "${YELLOW}  Moving existing docs/ to docs.backup/${NC}"
    mv "$PROJECT_DIR/.claude/docs" "$PROJECT_DIR/.claude/docs.backup"
fi
ln -sf "../$FRAMEWORK_REL/docs/shared" "$PROJECT_DIR/.claude/docs"
echo "  Symlink: .claude/docs"

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
if [ -f "$PROJECT_DIR/.claude/settings.json" ] && [ ! -w "$PROJECT_DIR/.claude/settings.json" ]; then
    echo -e "  ${YELLOW}Skipped settings.json (not writable, will merge on next sudo install)${NC}"
else
    node "$FRAMEWORK_DIR/scripts/merge-settings.cjs" install \
        "$PROJECT_DIR/.claude/settings.json" \
        "$FRAMEWORK_DIR/.claude/settings.json.template"
fi
if cp "$FRAMEWORK_DIR/TESTING.md" "$PROJECT_DIR/.claude/TESTING.md" 2>/dev/null; then
    echo "  Copied TESTING.md -> .claude/TESTING.md"
else
    echo -e "  ${YELLOW}Skipped TESTING.md (file is root-owned, will update on next sudo install)${NC}"
fi

# --- 3. MCP config ---
echo ""
echo -e "${YELLOW}Generating .mcp.json...${NC}"
# Preserve existing OP_SERVICE_ACCOUNT_TOKEN before regenerating .mcp.json
EXISTING_OP_TOKEN=""
if [ -z "$OP_TOKEN" ] && [ -f "$PROJECT_DIR/.mcp.json" ]; then
    EXISTING_OP_TOKEN=$(node -e "
      const fs = require('fs');
      try {
        const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        for (const s of Object.values(c.mcpServers || {})) {
          if (s.env && s.env.OP_SERVICE_ACCOUNT_TOKEN) {
            console.log(s.env.OP_SERVICE_ACCOUNT_TOKEN);
            break;
          }
        }
      } catch {}
    " "$PROJECT_DIR/.mcp.json" 2>/dev/null || true)
fi
if sed "s|\${FRAMEWORK_PATH}|$FRAMEWORK_REL|g" \
    "$FRAMEWORK_DIR/.mcp.json.template" > "$PROJECT_DIR/.mcp.json" 2>/dev/null; then
    echo "  Generated .mcp.json"
else
    echo -e "  ${YELLOW}Skipped .mcp.json (file is root-owned, will update on next sudo install)${NC}"
fi
# Use preserved token if --op-token wasn't provided
if [ -z "$OP_TOKEN" ] && [ -n "$EXISTING_OP_TOKEN" ]; then
    OP_TOKEN="$EXISTING_OP_TOKEN"
fi

# --- 3b. Inject OP_SERVICE_ACCOUNT_TOKEN into .mcp.json launcher envs ---
if [ -n "$OP_TOKEN" ]; then
    echo -e "${YELLOW}Injecting OP_SERVICE_ACCOUNT_TOKEN into .mcp.json...${NC}"
    INJECT_TOKEN="$OP_TOKEN" node -e "
      const fs = require('fs');
      const p = process.argv[1];
      const token = process.env.INJECT_TOKEN;
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of Object.values(c.mcpServers || {})) {
        if (s.args && s.args.some(a => a.includes('mcp-launcher.js'))) {
          s.env = s.env || {};
          s.env.OP_SERVICE_ACCOUNT_TOKEN = token;
        }
      }
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
    " "$PROJECT_DIR/.mcp.json"
    echo "  Injected OP_SERVICE_ACCOUNT_TOKEN into launcher-based MCP servers"
else
    # Check if token is already in existing .mcp.json
    HAS_TOKEN=$(node -e "
      const fs = require('fs');
      try {
        const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        const has = Object.values(c.mcpServers || {}).some(s =>
          s.env && s.env.OP_SERVICE_ACCOUNT_TOKEN
        );
        console.log(has ? 'yes' : 'no');
      } catch { console.log('no'); }
    " "$PROJECT_DIR/.mcp.json" 2>/dev/null || echo "no")
    if [ "$HAS_TOKEN" != "yes" ]; then
        echo ""
        echo -e "${RED}ERROR: OP_SERVICE_ACCOUNT_TOKEN is required for 1Password credential resolution.${NC}"
        echo ""
        echo "To create a service account:"
        echo "  1. Open 1Password web app > Settings > Service Accounts"
        echo "  2. Create service account named \"Claude Code MCP\""
        echo "  3. Grant read-only access to: Production, Staging, Preview vaults"
        echo "  4. Copy the token"
        echo "  5. Re-run with: --op-token <your-token>"
        echo ""
        exit 1
    fi
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

# Ensure git knows to use .husky/ for hooks
cd "$PROJECT_DIR"
git config --local core.hooksPath .husky
echo "  Set core.hooksPath = .husky"

# --- 5. Install dependencies ---
echo ""
echo -e "${YELLOW}Installing hook dependencies...${NC}"
cd "$FRAMEWORK_DIR"
npm install --no-fund --no-audit
echo "  Hook dependencies ready"

echo ""
echo -e "${YELLOW}Building MCP servers...${NC}"
cd "$FRAMEWORK_DIR/packages/mcp-servers"
echo "  Installing dependencies..."
npm install --no-fund --no-audit
echo "  Building TypeScript..."
npm run build
cd "$PROJECT_DIR"

# --- 6. Automation Service ---
echo ""
echo -e "${YELLOW}Setting up automation service (10-min timer)...${NC}"
if [ -x "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" ]; then
    # Pass OP_SERVICE_ACCOUNT_TOKEN to automation service if available,
    # enabling headless credential resolution without macOS prompts.
    AUTOMATION_OP_TOKEN_FLAG=""
    if [ -n "$OP_TOKEN" ]; then
        AUTOMATION_OP_TOKEN_FLAG="--op-token $OP_TOKEN"
    fi
    "$FRAMEWORK_DIR/scripts/setup-automation-service.sh" setup --path "$PROJECT_DIR" $AUTOMATION_OP_TOKEN_FLAG
else
    echo -e "  ${YELLOW}setup-automation-service.sh not found or not executable, skipping.${NC}"
fi

# --- 6b. macOS TCC: Re-sign Node.js for persistent permissions ---
echo ""
if [[ "$(uname)" == "Darwin" ]]; then
    echo -e "${YELLOW}Configuring macOS TCC permissions...${NC}"
    if [ -x "$FRAMEWORK_DIR/scripts/resign-node.sh" ]; then
        "$FRAMEWORK_DIR/scripts/resign-node.sh" || echo -e "  ${YELLOW}Node re-signing skipped (non-fatal)${NC}"
    fi
else
    echo -e "${YELLOW}Skipping macOS TCC setup (not macOS)${NC}"
fi

# --- 6c. Chrome Extension Host Permissions ---
echo ""
if [[ "$(uname)" == "Darwin" ]]; then
    echo -e "${YELLOW}Configuring Chrome extension permissions...${NC}"
    if [ -x "$FRAMEWORK_DIR/scripts/grant-chrome-ext-permissions.sh" ]; then
        "$FRAMEWORK_DIR/scripts/grant-chrome-ext-permissions.sh" || \
            echo -e "  ${YELLOW}Chrome permission setup skipped (non-fatal)${NC}"
    fi
else
    echo -e "${YELLOW}Skipping Chrome extension permissions (not macOS)${NC}"
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
.claude/vault-mappings.json
.claude/credential-provider.json
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

# --- 8. Test Failure Reporters ---
echo ""
echo -e "${YELLOW}Configuring test failure reporters...${NC}"

# Detect test framework and configure reporter
JEST_CONFIG=""
VITEST_CONFIG=""
PLAYWRIGHT_CONFIG=""

# Check for Jest
if [ -f "$PROJECT_DIR/jest.config.js" ]; then
    JEST_CONFIG="$PROJECT_DIR/jest.config.js"
elif [ -f "$PROJECT_DIR/jest.config.ts" ]; then
    JEST_CONFIG="$PROJECT_DIR/jest.config.ts"
elif [ -f "$PROJECT_DIR/jest.config.mjs" ]; then
    JEST_CONFIG="$PROJECT_DIR/jest.config.mjs"
fi

# Check for Vitest
if [ -f "$PROJECT_DIR/vitest.config.js" ]; then
    VITEST_CONFIG="$PROJECT_DIR/vitest.config.js"
elif [ -f "$PROJECT_DIR/vitest.config.ts" ]; then
    VITEST_CONFIG="$PROJECT_DIR/vitest.config.ts"
elif [ -f "$PROJECT_DIR/vitest.config.mjs" ]; then
    VITEST_CONFIG="$PROJECT_DIR/vitest.config.mjs"
fi

# Check for Playwright
if [ -f "$PROJECT_DIR/playwright.config.ts" ]; then
    PLAYWRIGHT_CONFIG="$PROJECT_DIR/playwright.config.ts"
elif [ -f "$PROJECT_DIR/playwright.config.js" ]; then
    PLAYWRIGHT_CONFIG="$PROJECT_DIR/playwright.config.js"
fi

# Create reporters symlink directory
mkdir -p "$PROJECT_DIR/.claude/reporters"

if [ -n "$JEST_CONFIG" ]; then
    # Symlink Jest reporter
    ln -sf "../../$FRAMEWORK_REL/.claude/hooks/reporters/jest-failure-reporter.js" "$PROJECT_DIR/.claude/reporters/jest-failure-reporter.js"
    echo "  Symlink: .claude/reporters/jest-failure-reporter.js"

    # Check if reporter is already configured in jest.config
    if grep -q "jest-failure-reporter" "$JEST_CONFIG" 2>/dev/null; then
        echo "  Jest reporter already configured in $(basename "$JEST_CONFIG")"
    else
        echo -e "  ${YELLOW}NOTE: Add to $JEST_CONFIG reporters array:${NC}"
        echo "    reporters: ['default', '<rootDir>/.claude/reporters/jest-failure-reporter.js']"
    fi
fi

if [ -n "$VITEST_CONFIG" ]; then
    # Symlink Vitest reporter
    ln -sf "../../$FRAMEWORK_REL/.claude/hooks/reporters/vitest-failure-reporter.js" "$PROJECT_DIR/.claude/reporters/vitest-failure-reporter.js"
    echo "  Symlink: .claude/reporters/vitest-failure-reporter.js"

    # Check if reporter is already configured
    if grep -q "vitest-failure-reporter" "$VITEST_CONFIG" 2>/dev/null; then
        echo "  Vitest reporter already configured in $(basename "$VITEST_CONFIG")"
    else
        echo -e "  ${YELLOW}NOTE: Add to $VITEST_CONFIG:${NC}"
        echo "    reporters: ['default', './.claude/reporters/vitest-failure-reporter.js']"
    fi
fi

if [ -n "$PLAYWRIGHT_CONFIG" ]; then
    # Symlink Playwright reporter
    ln -sf "../../$FRAMEWORK_REL/.claude/hooks/reporters/playwright-failure-reporter.js" "$PROJECT_DIR/.claude/reporters/playwright-failure-reporter.js"
    echo "  Symlink: .claude/reporters/playwright-failure-reporter.js"

    # Check if reporter is already configured
    if grep -q "playwright-failure-reporter" "$PLAYWRIGHT_CONFIG" 2>/dev/null; then
        echo "  Playwright reporter already configured in $(basename "$PLAYWRIGHT_CONFIG")"
    else
        echo -e "  ${YELLOW}NOTE: Add to $PLAYWRIGHT_CONFIG reporter array:${NC}"
        echo "    reporter: [['list'], ['./.claude/reporters/playwright-failure-reporter.js']]"
    fi
fi

# Check for monorepo packages with vitest
if [ -d "$PROJECT_DIR/packages" ]; then
    for pkg_vitest in "$PROJECT_DIR"/packages/*/vitest.config.*; do
        [ -f "$pkg_vitest" ] || continue
        pkg_dir=$(dirname "$pkg_vitest")
        pkg_name=$(basename "$pkg_dir")

        # Create reporters directory in package
        mkdir -p "$pkg_dir/.claude/reporters"

        # Symlink - path goes up 4 levels: reporters/ -> .claude/ -> pkg/ -> packages/ -> project root
        ln -sf "../../../../$FRAMEWORK_REL/.claude/hooks/reporters/vitest-failure-reporter.js" "$pkg_dir/.claude/reporters/vitest-failure-reporter.js"
        echo "  Symlink: packages/$pkg_name/.claude/reporters/vitest-failure-reporter.js"

        if ! grep -q "vitest-failure-reporter" "$pkg_vitest" 2>/dev/null; then
            echo -e "  ${YELLOW}NOTE: Add to packages/$pkg_name/$(basename "$pkg_vitest"):${NC}"
            echo "    reporters: ['default', './.claude/reporters/vitest-failure-reporter.js']"
        fi
    done
fi

# Check for integrations with vitest (pattern: integrations/*/*/vitest.config.*)
if [ -d "$PROJECT_DIR/integrations" ]; then
    for int_vitest in "$PROJECT_DIR"/integrations/*/*/vitest.config.*; do
        [ -f "$int_vitest" ] || continue
        int_dir=$(dirname "$int_vitest")
        int_name=$(basename "$(dirname "$int_dir")")/$(basename "$int_dir")

        # Create reporters directory in integration
        mkdir -p "$int_dir/.claude/reporters"

        # Symlink - path goes up 5 levels: reporters/ -> .claude/ -> connector/ -> platform/ -> integrations/ -> project root
        ln -sf "../../../../../$FRAMEWORK_REL/.claude/hooks/reporters/vitest-failure-reporter.js" "$int_dir/.claude/reporters/vitest-failure-reporter.js"
        echo "  Symlink: integrations/$int_name/.claude/reporters/vitest-failure-reporter.js"

        if ! grep -q "vitest-failure-reporter" "$int_vitest" 2>/dev/null; then
            echo -e "  ${YELLOW}NOTE: Add to integrations/$int_name/$(basename "$int_vitest"):${NC}"
            echo "    reporters: ['default', './.claude/reporters/vitest-failure-reporter.js']"
        fi
    done
fi

if [ -z "$JEST_CONFIG" ] && [ -z "$VITEST_CONFIG" ] && [ -z "$PLAYWRIGHT_CONFIG" ] && [ ! -d "$PROJECT_DIR/packages" ] && [ ! -d "$PROJECT_DIR/integrations" ]; then
    echo "  No Jest, Vitest, or Playwright config found, skipping reporter setup"
fi

# --- 9. Deploy staged hooks ---
echo ""
echo -e "${YELLOW}Deploying staged hooks...${NC}"
STAGED_HOOKS_DIR="$FRAMEWORK_DIR/scripts/hooks"
HOOKS_DIR="$(get_hooks_dir)"
if [ -d "$STAGED_HOOKS_DIR" ]; then
    for staged_hook in "$STAGED_HOOKS_DIR"/*.js; do
        [ -f "$staged_hook" ] || continue
        hook_name="$(basename "$staged_hook")"
        if cp "$staged_hook" "$HOOKS_DIR/$hook_name" 2>/dev/null; then
            echo "  Deployed: $hook_name"
        else
            echo -e "  ${YELLOW}Skipped $hook_name (hooks dir not writable, will deploy on next sudo install)${NC}"
        fi
    done
else
    echo "  No staged hooks to deploy"
fi

# --- 10. CLAUDE.md Agent Instructions ---
echo ""
echo -e "${YELLOW}Updating CLAUDE.md...${NC}"
GENTYR_SECTION="$FRAMEWORK_DIR/CLAUDE.md.gentyr-section"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
MARKER_START="<!-- GENTYR-FRAMEWORK-START -->"
MARKER_END="<!-- GENTYR-FRAMEWORK-END -->"

if [ -f "$GENTYR_SECTION" ]; then
    # Check if file exists and is writable (or doesn't exist yet)
    if [ -f "$CLAUDE_MD" ] && [ ! -w "$CLAUDE_MD" ]; then
        echo -e "  ${YELLOW}Skipped CLAUDE.md (not writable, may be protected)${NC}"
    elif [ -f "$CLAUDE_MD" ]; then
        if grep -q "$MARKER_START" "$CLAUDE_MD"; then
            # Replace existing section (BSD sed compatible)
            sed -i '' "/$MARKER_START/,/$MARKER_END/d" "$CLAUDE_MD"
            echo "  Replaced existing GENTYR section"
        fi
        # Append section (only add newline if file doesn't end with one)
        if [ -s "$CLAUDE_MD" ] && [ -n "$(tail -c 1 "$CLAUDE_MD")" ]; then
            echo "" >> "$CLAUDE_MD"
        fi
        cat "$GENTYR_SECTION" >> "$CLAUDE_MD"
        echo "  Appended GENTYR agent instructions to CLAUDE.md"
    else
        # Create new CLAUDE.md with section
        cat "$GENTYR_SECTION" > "$CLAUDE_MD"
        echo "  Created CLAUDE.md with GENTYR agent instructions"
    fi
else
    echo "  Skipped CLAUDE.md (template not found)"
fi

# --- 10b. Makerkit Integration ---
echo ""
echo -e "${YELLOW}Checking for Makerkit integration...${NC}"

MAKERKIT_DETECTED=false
MAKERKIT_MCP_PATH=""

if [ "$MAKERKIT_FLAG" = "skip" ]; then
    echo "  Skipped (--no-makerkit flag)"
elif [ "$MAKERKIT_FLAG" = "force" ]; then
    MAKERKIT_DETECTED=true
    # Try to find the MCP server path even without auto-detection
    if [ -d "$PROJECT_DIR/packages/mcp-server" ]; then
        MAKERKIT_MCP_PATH="packages/mcp-server/build/index.js"
    elif [ -d "$PROJECT_DIR/tooling/mcp-server" ]; then
        MAKERKIT_MCP_PATH="tooling/mcp-server/build/index.js"
    fi
    echo "  Forced via --makerkit flag"
else
    # Auto-detect: Check for Makerkit MCP server in project
    if [ -d "$PROJECT_DIR/packages/mcp-server" ] && \
       grep -q "@kit/mcp-server\|makerkit" "$PROJECT_DIR/packages/mcp-server/package.json" 2>/dev/null; then
        MAKERKIT_DETECTED=true
        MAKERKIT_MCP_PATH="packages/mcp-server/build/index.js"
        echo "  Auto-detected Makerkit (packages/mcp-server/)"
    elif [ -d "$PROJECT_DIR/tooling/mcp-server" ] && \
       grep -q "@kit/mcp-server\|makerkit" "$PROJECT_DIR/tooling/mcp-server/package.json" 2>/dev/null; then
        MAKERKIT_DETECTED=true
        MAKERKIT_MCP_PATH="tooling/mcp-server/build/index.js"
        echo "  Auto-detected Makerkit (tooling/mcp-server/)"
    else
        echo "  No Makerkit detected (use --makerkit to force)"
    fi
fi

if [ "$MAKERKIT_DETECTED" = true ]; then
    VENDOR_DIR="$FRAMEWORK_DIR/vendor/makerkit"
    DOCS_REPO="$VENDOR_DIR/documentation"
    DOCS_GENERATED="$VENDOR_DIR/docs-generated"

    # --- Clone or update documentation repo ---
    if [ -d "$DOCS_REPO/.git" ]; then
        echo "  Updating Makerkit documentation..."
        PREV_DIR="$(pwd)"
        cd "$DOCS_REPO"
        git pull --ff-only origin main 2>/dev/null || \
            echo -e "  ${YELLOW}Warning: Could not update docs (offline or auth issue)${NC}"
        cd "$PREV_DIR"
    else
        echo "  Cloning Makerkit documentation..."
        mkdir -p "$VENDOR_DIR"
        if git clone --depth 1 https://github.com/makerkit/documentation.git "$DOCS_REPO" 2>/dev/null; then
            echo "  Cloned Makerkit documentation repo"
        else
            echo -e "  ${YELLOW}Warning: Could not clone docs repo (check GitHub access)${NC}"
            echo "  You can manually clone: git clone https://github.com/makerkit/documentation.git $DOCS_REPO"
        fi
    fi

    # --- Generate LLM-optimized docs ---
    if [ -f "$DOCS_REPO/index.js" ]; then
        echo "  Generating LLM-optimized documentation..."
        PREV_DIR="$(pwd)"
        cd "$DOCS_REPO"
        # Install deps if needed
        if [ ! -d "node_modules" ]; then
            npm install --no-fund --no-audit 2>/dev/null || true
        fi
        node index.js kits/next-supabase-turbo 2>/dev/null || \
            echo -e "  ${YELLOW}Warning: Doc generation failed${NC}"
        cd "$PREV_DIR"

        # Copy generated docs to stable location
        if [ -d "$DOCS_REPO/dist" ]; then
            rm -rf "$DOCS_GENERATED"
            cp -r "$DOCS_REPO/dist" "$DOCS_GENERATED"
            DOC_COUNT=$(ls "$DOCS_GENERATED"/*.md 2>/dev/null | wc -l | tr -d ' ')
            echo "  Generated $DOC_COUNT doc files"
        fi
    fi

    # --- Build Makerkit's built-in MCP server ---
    if [ -n "$MAKERKIT_MCP_PATH" ]; then
        MCP_PKG_DIR="$(dirname "$PROJECT_DIR/$MAKERKIT_MCP_PATH")"
        # Go up from build/ to the mcp-server package root
        MCP_PKG_DIR="$(dirname "$MCP_PKG_DIR")"
        if [ -f "$MCP_PKG_DIR/package.json" ]; then
            echo "  Building Makerkit MCP server..."
            PREV_DIR="$(pwd)"
            cd "$MCP_PKG_DIR"
            npm install --no-fund --no-audit 2>/dev/null || true
            npm run build 2>/dev/null || \
                echo -e "  ${YELLOW}Warning: Makerkit MCP server build failed${NC}"
            cd "$PREV_DIR"
        fi
    fi

    # --- Inject Makerkit MCP servers into .mcp.json ---
    if [ -f "$PROJECT_DIR/.mcp.json" ]; then
        echo "  Adding Makerkit MCP servers to .mcp.json..."
        MAKERKIT_MCP_REL="$MAKERKIT_MCP_PATH" \
        FRAMEWORK_REL_PATH="$FRAMEWORK_REL" \
        node -e "
          const fs = require('fs');
          const p = process.argv[1];
          const c = JSON.parse(fs.readFileSync(p, 'utf8'));

          // Add Makerkit built-in MCP server (project-relative path)
          if (process.env.MAKERKIT_MCP_REL) {
            c.mcpServers['makerkit'] = {
              command: 'node',
              args: [process.env.MAKERKIT_MCP_REL],
              env: { CLAUDE_PROJECT_DIR: '.' }
            };
          }

          // Add GENTYR makerkit-docs server
          c.mcpServers['makerkit-docs'] = {
            command: 'node',
            args: [process.env.FRAMEWORK_REL_PATH + '/packages/mcp-servers/dist/makerkit-docs/server.js'],
            env: {
              CLAUDE_PROJECT_DIR: '.',
              MAKERKIT_DOCS_PATH: process.env.FRAMEWORK_REL_PATH + '/vendor/makerkit/docs-generated'
            }
          };

          fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
        " "$PROJECT_DIR/.mcp.json"
        echo "  Added makerkit + makerkit-docs servers"
    fi

    # --- Inject Makerkit section into CLAUDE.md ---
    MAKERKIT_SECTION="$FRAMEWORK_DIR/CLAUDE.md.makerkit-section"
    MK_MARKER_START="<!-- MAKERKIT-SECTION-START -->"
    MK_MARKER_END="<!-- MAKERKIT-SECTION-END -->"

    if [ -f "$MAKERKIT_SECTION" ] && [ -f "$CLAUDE_MD" ] && [ -w "$CLAUDE_MD" ]; then
        # Remove existing Makerkit section if present
        if grep -q "$MK_MARKER_START" "$CLAUDE_MD" 2>/dev/null; then
            sed -i '' "/$MK_MARKER_START/,/$MK_MARKER_END/d" "$CLAUDE_MD"
        fi
        # Insert before GENTYR-FRAMEWORK-END marker
        if grep -q "$MARKER_END" "$CLAUDE_MD" 2>/dev/null; then
            # Use temp file approach (BSD sed compatible)
            TEMP_CLAUDE="$(mktemp)"
            while IFS= read -r line; do
                if [ "$line" = "$MARKER_END" ]; then
                    cat "$MAKERKIT_SECTION" >> "$TEMP_CLAUDE"
                    echo "" >> "$TEMP_CLAUDE"
                fi
                echo "$line" >> "$TEMP_CLAUDE"
            done < "$CLAUDE_MD"
            mv "$TEMP_CLAUDE" "$CLAUDE_MD"
            echo "  Added Makerkit section to CLAUDE.md"
        fi
    fi

    # --- Write vendor config ---
    mkdir -p "$VENDOR_DIR"
    cat > "$VENDOR_DIR/config.json" << VENDOREOF
{
    "version": "1.0.0",
    "lastUpdated": "$(date -Iseconds 2>/dev/null || date)",
    "docsPath": "$DOCS_GENERATED",
    "mcpServerPath": "$MAKERKIT_MCP_PATH",
    "kit": "next-supabase-turbo"
}
VENDOREOF

    # Fix ownership if running under sudo
    if [ "$EUID" -eq 0 ] && [ -d "$VENDOR_DIR" ]; then
        original_user="$(get_original_user)"
        original_group="$(get_original_group)"
        chown -R "$original_user:$original_group" "$VENDOR_DIR"
    fi

    echo -e "${GREEN}  Makerkit integration complete${NC}"
fi

# --- 10. MCP Protection Setup (if requested) ---
if [ "$PROTECT_MCP" = true ]; then
    echo ""
    echo -e "${YELLOW}Setting up MCP protection...${NC}"

    PROTECTED_ACTIONS_FILE="$PROJECT_DIR/.claude/hooks/protected-actions.json"
    PROTECTION_KEY_FILE="$PROJECT_DIR/.claude/protection-key"

    # Check for existing configuration
    if [ -f "$PROTECTED_ACTIONS_FILE" ] && [ "$RECONFIGURE_MCP" != true ]; then
        echo "  Found existing MCP protection configuration."
        if [ -f "$PROJECT_DIR/.mcp.json" ]; then
            # Show what's protected
            node -e "
                const config = require('$PROTECTED_ACTIONS_FILE');
                const servers = config.servers || {};
                const count = Object.keys(servers).length;
                if (count === 0) {
                    console.log('  No servers currently protected.');
                } else {
                    console.log('  Protected servers:');
                    for (const [name, cfg] of Object.entries(servers)) {
                        const tools = cfg.tools === '*' ? 'all tools' : cfg.tools.join(', ');
                        console.log('    - ' + name + ': ' + tools + ' -> \"' + cfg.phrase + '\"');
                    }
                }
            " 2>/dev/null || echo "  (Could not read existing config)"
        fi
        echo ""
        echo "  Use --reconfigure to change MCP protection settings."
    else
        # Interactive setup or reconfigure
        if [ ! -f "$PROJECT_DIR/.mcp.json" ]; then
            echo -e "  ${YELLOW}No .mcp.json found. Skipping MCP protection setup.${NC}"
        else
            # Generate or preserve protection key
            if [ ! -f "$PROTECTION_KEY_FILE" ]; then
                echo "  Generating protection key..."
                node "$FRAMEWORK_DIR/scripts/encrypt-credential.js" --generate-key
            else
                echo "  Using existing protection key."
            fi

            # Parse .mcp.json to find servers
            echo "  Scanning .mcp.json for MCP servers..."
            MCP_SERVERS=$(node -e "
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('$PROJECT_DIR/.mcp.json', 'utf8'));
                const mcpServers = config.mcpServers || {};
                console.log(Object.keys(mcpServers).join('\n'));
            " 2>/dev/null)

            if [ -z "$MCP_SERVERS" ]; then
                echo -e "  ${YELLOW}No MCP servers found in .mcp.json${NC}"
            else
                echo ""
                echo "  Found MCP servers:"
                echo "$MCP_SERVERS" | while read server; do
                    echo "    - $server"
                done
                echo ""
                echo -e "  ${YELLOW}NOTE: Interactive MCP protection setup requires manual configuration.${NC}"
                echo ""
                echo "  To protect an MCP server:"
                echo "    1. Edit $PROTECTED_ACTIONS_FILE"
                echo "    2. Add server configuration to the 'servers' section"
                echo "    3. Encrypt credentials using: node scripts/encrypt-credential.js"
                echo "    4. Update .mcp.json with encrypted values"
                echo ""
                echo "  Example configuration:"
                echo '    "servers": {'
                echo '      "supabase-prod": {'
                echo '        "protection": "credential-isolated",'
                echo '        "phrase": "APPROVE PROD",'
                echo '        "tools": "*",'
                echo '        "description": "Production Supabase"'
                echo '      }'
                echo '    }'

                # Create initial config if needed
                if [ ! -f "$PROTECTED_ACTIONS_FILE" ]; then
                    cp "$FRAMEWORK_DIR/.claude/hooks/protected-actions.json.template" "$PROTECTED_ACTIONS_FILE"
                    echo ""
                    echo "  Created: $PROTECTED_ACTIONS_FILE"
                fi
            fi
        fi
    fi
fi

# --- 11. Protection (if requested) ---
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

# Remove directory symlinks for commands, hooks, mcp, docs
for item in commands hooks mcp docs; do
    if [ -L "$PROJECT_DIR/.claude/$item" ]; then
        rm "$PROJECT_DIR/.claude/$item"
        echo "  Removed: .claude/$item"
    fi
done
for item in commands hooks mcp docs; do
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

# Remove reporters symlinks
if [ -d "$PROJECT_DIR/.claude/reporters" ]; then
    rm -rf "$PROJECT_DIR/.claude/reporters"
    echo "  Removed: .claude/reporters/"
fi

# Remove reporters from monorepo packages
if [ -d "$PROJECT_DIR/packages" ]; then
    for pkg_reporters in "$PROJECT_DIR"/packages/*/.claude/reporters; do
        [ -d "$pkg_reporters" ] || continue
        rm -rf "$pkg_reporters"
        pkg_name=$(basename "$(dirname "$(dirname "$pkg_reporters")")")
        echo "  Removed: packages/$pkg_name/.claude/reporters/"
    done
fi

# Remove reporters from integrations
if [ -d "$PROJECT_DIR/integrations" ]; then
    for int_reporters in "$PROJECT_DIR"/integrations/*/*/.claude/reporters; do
        [ -d "$int_reporters" ] || continue
        rm -rf "$int_reporters"
        int_dir=$(dirname "$int_reporters")
        int_name=$(basename "$(dirname "$int_dir")")/$(basename "$int_dir")
        echo "  Removed: integrations/$int_name/.claude/reporters/"
    done
fi
echo ""

# --- Remove generated files ---
echo -e "${YELLOW}Removing generated files...${NC}"
if [ -f "$PROJECT_DIR/.mcp.json" ] && grep -q "claude-framework" "$PROJECT_DIR/.mcp.json" 2>/dev/null; then
    rm "$PROJECT_DIR/.mcp.json"
    echo "  Removed .mcp.json"
fi
echo ""

# --- Remove GENTYR hooks from settings.json ---
echo -e "${YELLOW}Cleaning settings.json...${NC}"
if [ -f "$PROJECT_DIR/.claude/settings.json" ]; then
    if [ ! -w "$PROJECT_DIR/.claude/settings.json" ]; then
        echo -e "  ${YELLOW}Skipped settings.json (not writable)${NC}"
    else
        node "$FRAMEWORK_DIR/scripts/merge-settings.cjs" uninstall "$PROJECT_DIR/.claude/settings.json"
    fi
else
    echo "  No settings.json found"
fi
echo ""

# --- Remove GENTYR section from CLAUDE.md ---
echo -e "${YELLOW}Cleaning CLAUDE.md...${NC}"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
MARKER_START="<!-- GENTYR-FRAMEWORK-START -->"
MARKER_END="<!-- GENTYR-FRAMEWORK-END -->"
if [ -f "$CLAUDE_MD" ] && [ ! -w "$CLAUDE_MD" ]; then
    echo -e "  ${YELLOW}Skipped CLAUDE.md (not writable, may be protected)${NC}"
elif [ -f "$CLAUDE_MD" ] && grep -q "$MARKER_START" "$CLAUDE_MD"; then
    sed -i "/^$MARKER_START$/,/^$MARKER_END$/d" "$CLAUDE_MD"
    # Remove trailing blank lines
    sed -i ':a; /^\s*$/{ $d; N; ba; }' "$CLAUDE_MD"
    # Remove file if it became empty
    if [ ! -s "$CLAUDE_MD" ] || ! grep -q '[^[:space:]]' "$CLAUDE_MD"; then
        rm "$CLAUDE_MD"
        echo "  Removed empty CLAUDE.md"
    else
        echo "  Removed GENTYR section from CLAUDE.md"
    fi
else
    echo "  No GENTYR section found in CLAUDE.md"
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

# Unset core.hooksPath if it points to .husky
cd "$PROJECT_DIR"
current_hooks_path=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ "$current_hooks_path" = ".husky" ]; then
    git config --local --unset core.hooksPath
    echo "  Unset core.hooksPath"
fi
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
