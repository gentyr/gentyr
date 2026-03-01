#!/bin/bash
# apply-credential-hardening.sh
# Applies security hardening changes to root-owned GENTYR hook files.
# Must be run with sudo:
#   sudo bash node_modules/gentyr/scripts/apply-credential-hardening.sh  (npm install model)
#   sudo bash .claude-framework/scripts/apply-credential-hardening.sh    (legacy symlink)
#
# When running via a symlink (e.g. .claude-framework -> /path/to/gentyr), bash may resolve
# BASH_SOURCE[0] through the physical path, causing PROJECT_ROOT auto-detection to fail.
# In that case, pass the project root explicitly:
#   sudo bash .claude-framework/scripts/apply-credential-hardening.sh --project-root /path/to/project
#
# Changes:
# 1. Adds missing credentialKeys to protected-actions.json (github, resend, elastic, codecov)
# 2. Removes redundant full-path op CLI pattern from block-no-verify.js (cleanup)
# 3. Fixes mismatched tool names in protected-actions.json (10 tools across 3 servers)

set -euo pipefail

# Parse --project-root <path> CLI argument
EXPLICIT_PROJECT_ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      EXPLICIT_PROJECT_ROOT="${2:-}"
      if [ -z "$EXPLICIT_PROJECT_ROOT" ]; then
        echo "ERROR: --project-root requires a path argument"
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      echo "Usage: sudo bash $0 [--project-root <path>]"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "$EXPLICIT_PROJECT_ROOT" ]; then
  # Explicit override: trust the caller, but still validate
  PROJECT_ROOT="$(cd "$EXPLICIT_PROJECT_ROOT" && pwd)"
else
  # Auto-detect: resolve project root by walking up from SCRIPT_DIR.
  # When BASH_SOURCE[0] resolves through a symlink's physical path (e.g.
  # /Users/user/git/gentyr/scripts/ rather than .claude-framework/scripts/),
  # the grandparent calculation below may land in the wrong directory.
  # Use --project-root to override if auto-detection fails.
  _PARENT_DIR="$(dirname "$SCRIPT_DIR")"
  _GRANDPARENT_DIR="$(dirname "$_PARENT_DIR")"
  if [ "$(basename "$_GRANDPARENT_DIR")" = "node_modules" ]; then
    # npm install model: node_modules/gentyr/scripts/ -> node_modules/ -> project root
    PROJECT_ROOT="$(dirname "$_GRANDPARENT_DIR")"
  else
    # Legacy symlink model: .claude-framework/scripts/ -> .claude-framework/ -> project root
    PROJECT_ROOT="$_GRANDPARENT_DIR"
  fi
fi

HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"

# Validate that the resolved hooks directory actually exists
if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: Hooks directory not found at: $HOOKS_DIR"
  echo ""
  echo "This usually means the project root was resolved incorrectly."
  echo "When running via symlink (e.g. .claude-framework -> /path/to/gentyr),"
  echo "bash may resolve BASH_SOURCE[0] through the physical path and miss"
  echo "the actual project directory."
  echo ""
  echo "Fix: Pass the project root explicitly:"
  echo "  sudo bash $0 --project-root /path/to/your/project"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run with sudo"
  echo "Usage: sudo bash $0"
  exit 1
fi

echo "=== GENTYR Credential Hardening ==="
echo ""

# --- 1. Update protected-actions.json ---
PA_FILE="$HOOKS_DIR/protected-actions.json"
if [ ! -f "$PA_FILE" ]; then
  echo "ERROR: $PA_FILE not found"
  exit 1
fi

echo "1. Updating protected-actions.json..."

python3 -c "
import json, sys

with open('$PA_FILE', 'r') as f:
    data = json.load(f)

changes = []

# Add credentialKeys to github (was approval-only without key protection)
if 'github' in data['servers'] and 'credentialKeys' not in data['servers']['github']:
    data['servers']['github']['credentialKeys'] = ['GITHUB_TOKEN', 'GITHUB_PAT']
    changes.append('Added GITHUB_TOKEN, GITHUB_PAT to github.credentialKeys')

# Add credentialKeys to resend (was approval-only without key protection)
if 'resend' in data['servers'] and 'credentialKeys' not in data['servers']['resend']:
    data['servers']['resend']['credentialKeys'] = ['RESEND_API_KEY']
    changes.append('Added RESEND_API_KEY to resend.credentialKeys')

# Add OP_CONNECT_TOKEN to onepassword
if 'onepassword' in data['servers']:
    keys = data['servers']['onepassword'].get('credentialKeys', [])
    if 'OP_CONNECT_TOKEN' not in keys:
        keys.append('OP_CONNECT_TOKEN')
        data['servers']['onepassword']['credentialKeys'] = keys
        changes.append('Added OP_CONNECT_TOKEN to onepassword.credentialKeys')

# Add SUPABASE_ANON_KEY to supabase
if 'supabase' in data['servers']:
    keys = data['servers']['supabase'].get('credentialKeys', [])
    if 'SUPABASE_ANON_KEY' not in keys:
        keys.append('SUPABASE_ANON_KEY')
        data['servers']['supabase']['credentialKeys'] = keys
        changes.append('Added SUPABASE_ANON_KEY to supabase.credentialKeys')

# Add supabase_push_migration and supabase_get_migration to supabase protected tools
if 'supabase' in data['servers']:
    tools = data['servers']['supabase'].get('tools', [])
    new_tools = ['supabase_push_migration', 'supabase_get_migration']
    for tool in new_tools:
        if tool not in tools:
            tools.append(tool)
            changes.append(f'Added {tool} to supabase.tools')
    data['servers']['supabase']['tools'] = tools

# Rename elastic -> elastic-logs for consistency with MCP server name
if 'elastic' in data['servers'] and 'elastic-logs' not in data['servers']:
    data['servers']['elastic-logs'] = data['servers'].pop('elastic')
    changes.append('Renamed elastic -> elastic-logs for consistency')

# Add elastic-logs credentialKeys (elastic-logs is in allowedUnprotectedServers for MCP tools,
# but we need credentialKeys for credential-file-guard env var blocking)
if 'elastic-logs' not in data['servers']:
    data['servers']['elastic-logs'] = {
        'credentialKeys': ['ELASTIC_API_KEY', 'ELASTIC_CLOUD_ID']
    }
    changes.append('Added elastic-logs with ELASTIC_API_KEY, ELASTIC_CLOUD_ID credentialKeys')
else:
    keys = data['servers']['elastic-logs'].get('credentialKeys', [])
    for k in ['ELASTIC_API_KEY', 'ELASTIC_CLOUD_ID']:
        if k not in keys:
            keys.append(k)
            changes.append(f'Added {k} to elastic-logs.credentialKeys')
    data['servers']['elastic-logs']['credentialKeys'] = keys

# Add codecov credentialKeys (codecov is in allowedUnprotectedServers for MCP tools,
# but we need credentialKeys for credential-file-guard env var blocking)
if 'codecov' not in data['servers']:
    data['servers']['codecov'] = {
        'credentialKeys': ['CODECOV_TOKEN']
    }
    changes.append('Added codecov with CODECOV_TOKEN credentialKey')
elif 'credentialKeys' not in data['servers'].get('codecov', {}):
    data['servers']['codecov']['credentialKeys'] = ['CODECOV_TOKEN']
    changes.append('Added CODECOV_TOKEN to codecov.credentialKeys')

# Add playwright credentialKeys (playwright MCP server needs Supabase creds for E2E tests)
if 'playwright' not in data['servers']:
    data['servers']['playwright'] = {
        'credentialKeys': ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
    }
    changes.append('Added playwright with SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY credentialKeys')
else:
    keys = data['servers']['playwright'].get('credentialKeys', [])
    for k in ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']:
        if k not in keys:
            keys.append(k)
            changes.append(f'Added {k} to playwright.credentialKeys')
    data['servers']['playwright']['credentialKeys'] = keys

# Add playwright to allowedUnprotectedServers if not present
allowed = data.get('allowedUnprotectedServers', [])
if 'playwright' not in allowed:
    allowed.append('playwright')
    data['allowedUnprotectedServers'] = allowed
    changes.append('Added playwright to allowedUnprotectedServers')

if changes:
    with open('$PA_FILE', 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    for c in changes:
        print(f'   + {c}')
else:
    print('   (no changes needed)')
"

echo ""

# --- 2. Remove redundant full-path op CLI pattern from block-no-verify.js ---
# Pattern 1 (\bop\s+...) already matches full-path invocations like /usr/local/bin/op
# because \b fires at the boundary between / and o. The "full-path variant" pattern 3
# ((?:^|[\/\s])op\s+...) is therefore redundant and should be cleaned up.
BNV_FILE="$HOOKS_DIR/block-no-verify.js"
if [ ! -f "$BNV_FILE" ]; then
  echo "2. block-no-verify.js not found, skipping redundant pattern cleanup"
else
  echo "2. Cleaning up redundant full-path op pattern in block-no-verify.js..."
  if grep -q 'full-path variant' "$BNV_FILE"; then
    python3 -c "
with open('$BNV_FILE', 'r') as f:
    lines = f.readlines()

# Remove lines containing 'full-path variant' and the preceding pattern line.
# The redundant entry spans 2 lines:
#   { pattern: /(?:^|[...])op...,
#     reason: '...full-path variant...' },
filtered = []
skip_next = False
removed = False
for i, line in enumerate(lines):
    if skip_next:
        skip_next = False
        continue
    # Check if NEXT line contains the marker (pattern line precedes reason line)
    if i + 1 < len(lines) and 'full-path variant' in lines[i + 1]:
        skip_next = True
        removed = True
        continue
    filtered.append(line)

if removed:
    with open('$BNV_FILE', 'w') as f:
        f.writelines(filtered)
    print('   + Removed redundant full-path op CLI pattern (2 lines)')
else:
    print('   (pattern not found in expected format, may need manual removal)')
"
  else
    echo "   (no redundant pattern found, skipping)"
  fi
fi

echo ""

# --- 3. Fix mismatched tool names in protected-actions.json ---
echo "3. Fixing mismatched tool names in protected-actions.json..."

python3 -c "
import json

with open('$PA_FILE', 'r') as f:
    data = json.load(f)

changes = []

# Supabase: executeSql -> supabase_sql, deleteData -> supabase_delete, etc.
if 'supabase' in data['servers']:
    tools = data['servers']['supabase'].get('tools', [])
    renames = {
        'executeSql': 'supabase_sql',
        'deleteData': 'supabase_delete',
        'deleteUser': 'supabase_delete_user',
        'deleteFile': 'supabase_delete_file',
    }
    for old_name, new_name in renames.items():
        if old_name in tools:
            idx = tools.index(old_name)
            tools[idx] = new_name
            changes.append(f'supabase: {old_name} -> {new_name}')
    data['servers']['supabase']['tools'] = tools

# Cloudflare: create_dns_record -> cloudflare_create_dns_record, etc.
if 'cloudflare' in data['servers']:
    tools = data['servers']['cloudflare'].get('tools', [])
    renames = {
        'create_dns_record': 'cloudflare_create_dns_record',
        'update_dns_record': 'cloudflare_update_dns_record',
        'delete_dns_record': 'cloudflare_delete_dns_record',
    }
    for old_name, new_name in renames.items():
        if old_name in tools:
            idx = tools.index(old_name)
            tools[idx] = new_name
            changes.append(f'cloudflare: {old_name} -> {new_name}')
    data['servers']['cloudflare']['tools'] = tools

# Resend: create_api_key -> resend_create_api_key, etc.
if 'resend' in data['servers']:
    tools = data['servers']['resend'].get('tools', [])
    renames = {
        'create_api_key': 'resend_create_api_key',
        'delete_api_key': 'resend_delete_api_key',
        'delete_domain': 'resend_delete_domain',
    }
    for old_name, new_name in renames.items():
        if old_name in tools:
            idx = tools.index(old_name)
            tools[idx] = new_name
            changes.append(f'resend: {old_name} -> {new_name}')
    data['servers']['resend']['tools'] = tools

if changes:
    with open('$PA_FILE', 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    for c in changes:
        print(f'   + Fixed {c}')
else:
    print('   (no mismatches found)')
"

echo ""
echo "=== Hardening complete ==="
echo ""
echo "Protected credential keys now include:"
python3 -c "
import json
with open('$PA_FILE', 'r') as f:
    data = json.load(f)
for name, server in sorted(data['servers'].items()):
    keys = server.get('credentialKeys', [])
    if keys:
        joined = ', '.join(keys)
        print(f'  {name}: {joined}')
"
echo ""
echo "Protected tool names per server:"
python3 -c "
import json
with open('$PA_FILE', 'r') as f:
    data = json.load(f)
for name, server in sorted(data['servers'].items()):
    tools = server.get('tools', [])
    if tools:
        joined = ', '.join(tools) if isinstance(tools, list) else str(tools)
        print(f'  {name}: {joined}')
"
echo ""
echo "To verify: echo \$GITHUB_TOKEN in a Claude session should be BLOCKED."
