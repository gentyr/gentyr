#!/bin/bash
# fix-mcp-launcher-issues.sh
# Fixes protected-actions.json (root-owned) for MCP launcher credential resolution.
# Must be run with sudo: sudo bash .claude-framework/scripts/fix-mcp-launcher-issues.sh
#
# Changes:
# 1. Renames servers.elastic -> servers.elastic-logs (consistency with MCP server name)
# 2. Adds ELASTIC_CLOUD_ID to elastic-logs.credentialKeys

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run with sudo"
  echo "Usage: sudo bash $0"
  exit 1
fi

PA_FILE="$HOOKS_DIR/protected-actions.json"
if [ ! -f "$PA_FILE" ]; then
  echo "ERROR: $PA_FILE not found"
  exit 1
fi

echo "=== MCP Launcher Credential Resolution Fixes ==="
echo ""
echo "Updating protected-actions.json..."

python3 -c "
import json

with open('$PA_FILE', 'r') as f:
    data = json.load(f)

changes = []

# Fix #1: Rename servers.elastic -> servers.elastic-logs
if 'elastic' in data['servers'] and 'elastic-logs' not in data['servers']:
    data['servers']['elastic-logs'] = data['servers'].pop('elastic')
    changes.append('Renamed servers.elastic -> servers.elastic-logs')
elif 'elastic' in data['servers'] and 'elastic-logs' in data['servers']:
    # Merge elastic into elastic-logs and remove elastic
    existing_keys = data['servers']['elastic-logs'].get('credentialKeys', [])
    old_keys = data['servers']['elastic'].get('credentialKeys', [])
    for k in old_keys:
        if k not in existing_keys:
            existing_keys.append(k)
    data['servers']['elastic-logs']['credentialKeys'] = existing_keys
    del data['servers']['elastic']
    changes.append('Merged servers.elastic into servers.elastic-logs and removed duplicate')

# Fix #4: Add ELASTIC_CLOUD_ID to elastic-logs.credentialKeys
if 'elastic-logs' in data['servers']:
    keys = data['servers']['elastic-logs'].get('credentialKeys', [])
    if 'ELASTIC_CLOUD_ID' not in keys:
        keys.append('ELASTIC_CLOUD_ID')
        data['servers']['elastic-logs']['credentialKeys'] = keys
        changes.append('Added ELASTIC_CLOUD_ID to elastic-logs.credentialKeys')

if changes:
    with open('$PA_FILE', 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    for c in changes:
        print(f'  + {c}')
else:
    print('  (no changes needed)')
"

echo ""
echo "=== Fix complete ==="
echo ""
echo "Verify elastic-logs entry:"
python3 -c "
import json
with open('$PA_FILE', 'r') as f:
    data = json.load(f)
el = data['servers'].get('elastic-logs', {})
print(f'  elastic-logs.credentialKeys: {el.get(\"credentialKeys\", [])}')
has_old = 'elastic' in data['servers']
print(f'  Old elastic key still present: {has_old}')
"
