#!/bin/bash
# apply-credential-hardening.sh
# Applies security hardening changes to root-owned GENTYR hook files.
# Must be run with sudo: sudo bash .claude-framework/scripts/apply-credential-hardening.sh
#
# Changes:
# 1. Adds missing credentialKeys to protected-actions.json (github, resend, elastic, codecov)
# 2. Adds full-path op CLI detection to block-no-verify.js
# 3. Fixes mismatched tool names in protected-actions.json (10 tools across 3 servers)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve project root: scripts/ is inside .claude-framework/, so go up two levels
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"

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

# --- 2. Update block-no-verify.js ---
BNV_FILE="$HOOKS_DIR/block-no-verify.js"
if [ ! -f "$BNV_FILE" ]; then
  echo "ERROR: $BNV_FILE not found"
  exit 1
fi

echo "2. Hardening block-no-verify.js (full-path op detection)..."

# Check if the full-path pattern already exists
if grep -q 'full-path variant' "$BNV_FILE"; then
  echo "   (already hardened, skipping)"
else
  # Insert the new pattern after the existing op --flags pattern
  python3 -c "
import re

with open('$BNV_FILE', 'r') as f:
    content = f.read()

old = \"\"\"  { pattern: /\\\\bop\\\\s+--/i,
    reason: '1Password CLI access blocked — global op flags indicate CLI usage' },
];\"\"\"

new = \"\"\"  { pattern: /\\\\bop\\\\s+--/i,
    reason: '1Password CLI access blocked — global op flags indicate CLI usage' },
  { pattern: /(?:^|[\\\\/\\\\s])op\\\\s+(run|read|item|inject|signin|signout|whoami|vault|document|connect|account|group|user|service-account|events-api|plugin)\\\\b/i,
    reason: '1Password CLI access blocked (full-path variant) — secrets must only flow through MCP server env fields' },
];\"\"\"

if old in content:
    content = content.replace(old, new)
    with open('$BNV_FILE', 'w') as f:
        f.write(content)
    print('   + Added full-path op CLI detection pattern')
else:
    print('   WARNING: Could not find expected pattern in block-no-verify.js')
    print('   Manual edit may be required')
"
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
