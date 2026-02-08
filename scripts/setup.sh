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
PROTECT_MCP=false
RECONFIGURE_MCP=false
CONFIGURE_CREDENTIALS=false
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
        --protect-mcp)
            PROTECT_MCP=true
            shift
            ;;
        --reconfigure)
            RECONFIGURE_MCP=true
            shift
            ;;
        --configure-credentials)
            CONFIGURE_CREDENTIALS=true
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
            echo "Usage: $0 --path <dir> [--protect] [--protect-mcp] [--reconfigure] [--configure-credentials] [--uninstall] [--protect-only] [--unprotect-only]"
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

get_original_group() {
    local user="$(get_original_user)"
    # Get primary group for the user
    id -gn "$user" 2>/dev/null || echo "staff"
}

do_protect() {
    require_root "--protect"
    local hooks_dir="$(get_hooks_dir)"

    echo -e "${YELLOW}Enabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$hooks_dir/protected-action-gate.js"
        "$hooks_dir/protected-action-approval-hook.js"
        "$hooks_dir/credential-file-guard.js"
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
    local original_group="$(get_original_group)"

    echo -e "${YELLOW}Disabling protection...${NC}"

    local files=(
        "$hooks_dir/pre-commit-review.js"
        "$hooks_dir/bypass-approval-hook.js"
        "$hooks_dir/block-no-verify.js"
        "$hooks_dir/protected-action-gate.js"
        "$hooks_dir/protected-action-approval-hook.js"
        "$hooks_dir/credential-file-guard.js"
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
# CONFIGURE CREDENTIALS (Fix 4)
# =============================================================================

do_configure_credentials() {
    local gentyr_dir
    if [ -L "$PROJECT_DIR/.claude-framework" ]; then
        gentyr_dir="$(readlink -f "$PROJECT_DIR/.claude-framework")"
    else
        gentyr_dir="$PROJECT_DIR/.claude-framework"
    fi
    local providers_dir="$gentyr_dir/scripts/credential-providers"
    local config_path="$PROJECT_DIR/.claude/credential-provider.json"
    local protected_actions_path="$PROJECT_DIR/.claude/hooks/protected-actions.json"
    local mcp_json_path="$PROJECT_DIR/.mcp.json"

    echo -e "${YELLOW}Configuring credentials...${NC}"
    echo ""

    # 1. Read protected-actions.json to find servers with credentialKeys
    if [ ! -f "$protected_actions_path" ]; then
        echo -e "${RED}Error: $protected_actions_path not found.${NC}"
        echo "  Run setup.sh --path $PROJECT_DIR first."
        return 1
    fi

    # 2. Check for provider config or prompt to create one
    local provider_name=""
    if [ -f "$config_path" ]; then
        provider_name=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$config_path','utf8')).provider || '')" 2>/dev/null)
        echo -e "  Using provider from config: ${GREEN}${provider_name}${NC}"
    fi

    if [ -z "$provider_name" ]; then
        echo "  No credential provider configured."
        echo ""
        echo "  Available providers:"
        echo "    1) onepassword - Resolve from 1Password vaults (requires op CLI)"
        echo "    2) manual      - Enter credentials interactively"
        echo ""
        read -p "  Select provider (1/2): " choice
        case "$choice" in
            1) provider_name="onepassword" ;;
            2) provider_name="manual" ;;
            *) echo -e "${RED}Invalid choice.${NC}"; return 1 ;;
        esac

        # Create provider config
        mkdir -p "$(dirname "$config_path")"
        echo "{\"provider\": \"$provider_name\", \"vaultMappings\": {}}" > "$config_path"
        echo -e "  Created ${GREEN}$config_path${NC}"
    fi

    # 3. Use node to resolve credentials and inject into .mcp.json
    node --input-type=module -e "
import fs from 'fs';
import path from 'path';

const projectDir = '$PROJECT_DIR';
const providersDir = '$providers_dir';
const providerName = '$provider_name';
const protectedActionsPath = '$protected_actions_path';
const mcpJsonPath = '$mcp_json_path';
const configPath = '$config_path';

async function main() {
  // Load protected actions to find credentialKeys
  const config = JSON.parse(fs.readFileSync(protectedActionsPath, 'utf8'));
  const providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Load provider
  const providerPath = path.join(providersDir, providerName + '.js');
  if (!fs.existsSync(providerPath)) {
    console.error('Provider not found: ' + providerPath);
    process.exit(1);
  }
  const provider = await import(providerPath);

  // Check availability
  if (!(await provider.isAvailable())) {
    console.error('Provider \"' + providerName + '\" is not available.');
    console.error('Ensure prerequisites are met (see provider docs).');
    process.exit(1);
  }

  console.log('  Provider: ' + provider.name);
  console.log('');

  // Load .mcp.json
  if (!fs.existsSync(mcpJsonPath)) {
    console.error('.mcp.json not found at: ' + mcpJsonPath);
    process.exit(1);
  }
  const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));

  // Iterate over servers with credentialKeys
  let credentialCount = 0;
  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    const keys = serverConfig.credentialKeys;
    if (!keys || keys.length === 0) continue;

    const mcpServer = mcpJson.mcpServers?.[serverName];
    if (!mcpServer) {
      console.log('  SKIP: MCP server \"' + serverName + '\" not in .mcp.json');
      continue;
    }

    console.log('  Server: ' + serverName);
    for (const key of keys) {
      const vaultRef = providerConfig.vaultMappings?.[key] || '';
      try {
        const value = await provider.resolve(key, vaultRef);
        if (!mcpServer.env) mcpServer.env = {};
        mcpServer.env[key] = value;
        credentialCount++;
        console.log('    ✓ ' + key);
      } catch (err) {
        console.error('    ✗ ' + key + ': ' + err.message);
      }
    }
  }

  // Write updated .mcp.json
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\\n');
  console.log('');
  console.log('  Injected ' + credentialCount + ' credential(s) into .mcp.json');

  // Warn if credential env vars detected in shell
  const envWarnings = [];
  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    for (const key of (serverConfig.credentialKeys || [])) {
      if (process.env[key]) {
        envWarnings.push(key);
      }
    }
  }
  if (envWarnings.length > 0) {
    console.log('');
    console.error('  ⚠ WARNING: Credential env vars detected in shell environment:');
    envWarnings.forEach(k => console.error('    - ' + k));
    console.error('  These should be removed from shell profiles for security.');
    console.error('  Credentials are now in .mcp.json (accessible only to MCP servers).');
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
"

    echo ""
    echo -e "${GREEN}Credentials configured in .mcp.json.${NC}"
    echo -e "${YELLOW}IMPORTANT: Root-protect .mcp.json to prevent agent access:${NC}"
    echo "  sudo $0 --path $PROJECT_DIR --protect-only"
}

if [ "$CONFIGURE_CREDENTIALS" = true ]; then
    do_configure_credentials
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
    "$PROJECT_DIR/.claude/autonomous-mode.json" \
    "$PROJECT_DIR/.claude/bypass-approval-token.json" \
    "$PROJECT_DIR/.claude/protection-state.json" \
    "$PROJECT_DIR/.claude/protected-action-approvals.json"; do
    [ -f "$state_file" ] || echo '{}' > "$state_file"
done

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
fi

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

# --- 8. Test Failure Reporters ---
echo ""
echo -e "${YELLOW}Configuring test failure reporters...${NC}"

# Detect test framework and configure reporter
JEST_CONFIG=""
VITEST_CONFIG=""

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

# Check for monorepo packages with vitest
if [ -d "$PROJECT_DIR/packages" ]; then
    for pkg_vitest in "$PROJECT_DIR"/packages/*/vitest.config.*; do
        [ -f "$pkg_vitest" ] || continue
        pkg_dir=$(dirname "$pkg_vitest")
        pkg_name=$(basename "$pkg_dir")

        # Create reporters directory in package
        mkdir -p "$pkg_dir/.claude/reporters"

        # Symlink - path goes up to package, then to project root's .claude-framework
        ln -sf "../../../$FRAMEWORK_REL/.claude/hooks/reporters/vitest-failure-reporter.js" "$pkg_dir/.claude/reporters/vitest-failure-reporter.js"
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

        # Symlink - path goes up 4 levels to project root's .claude-framework
        ln -sf "../../../../$FRAMEWORK_REL/.claude/hooks/reporters/vitest-failure-reporter.js" "$int_dir/.claude/reporters/vitest-failure-reporter.js"
        echo "  Symlink: integrations/$int_name/.claude/reporters/vitest-failure-reporter.js"

        if ! grep -q "vitest-failure-reporter" "$int_vitest" 2>/dev/null; then
            echo -e "  ${YELLOW}NOTE: Add to integrations/$int_name/$(basename "$int_vitest"):${NC}"
            echo "    reporters: ['default', './.claude/reporters/vitest-failure-reporter.js']"
        fi
    done
fi

if [ -z "$JEST_CONFIG" ] && [ -z "$VITEST_CONFIG" ] && [ ! -d "$PROJECT_DIR/packages" ] && [ ! -d "$PROJECT_DIR/integrations" ]; then
    echo "  No Jest or Vitest config found, skipping reporter setup"
fi

# --- 9. CLAUDE.md Agent Instructions ---
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
