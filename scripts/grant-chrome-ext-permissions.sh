#!/bin/bash
# Grant Chrome extension host permissions for the Claude Chrome Extension
#
# On fresh installs, Chrome may not auto-grant <all_urls> host permissions
# even when declared in the manifest. This script modifies Chrome's Secure
# Preferences to grant full host access, avoiding the manual "Allow on all
# sites" toggle in chrome://extensions.
#
# The extension needs <all_urls> to inject content scripts (accessibility
# tree, element finder) into any tab the user wants to automate.
#
# Usage:
#   scripts/grant-chrome-ext-permissions.sh           # Grant permissions
#   scripts/grant-chrome-ext-permissions.sh --check   # Report-only
#   scripts/grant-chrome-ext-permissions.sh --remove   # No-op (permissions are user-owned)
#
# Requires: Chrome NOT running (modifies preferences file)
# Platform: macOS only

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

EXTENSION_ID="fcoeoabgfenejglbffodgkkbkcdhcgfn"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
CHECK_ONLY=false

# --- Parse arguments ---
case "${1:-}" in
    --check)
        CHECK_ONLY=true
        ;;
    --remove)
        echo -e "${YELLOW}No action needed: host permissions are user-owned and persist in Chrome.${NC}"
        exit 0
        ;;
    --help|-h)
        echo "Grant Chrome extension host permissions for Claude Chrome Extension"
        echo ""
        echo "Usage: $0 [--check] [--remove]"
        echo ""
        echo "  (none)    Grant <all_urls> host permission to the extension"
        echo "  --check   Report current permission state without modifying"
        echo "  --remove  No-op (permissions are user-owned)"
        exit 0
        ;;
esac

# --- macOS only ---
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${YELLOW}Skipping: Chrome permission grant is macOS-only${NC}"
    exit 0
fi

# --- Check Chrome directory exists ---
if [ ! -d "$CHROME_DIR" ]; then
    echo -e "${YELLOW}Chrome not found at $CHROME_DIR${NC}"
    exit 0
fi

# --- Check Chrome is not running (unless check-only) ---
if [ "$CHECK_ONLY" = false ] && pgrep -x "Google Chrome" > /dev/null 2>&1; then
    echo -e "${RED}Error: Chrome must be closed before modifying permissions.${NC}"
    echo "  Please quit Chrome and re-run this script."
    exit 1
fi

# --- Find profiles with the extension installed ---
PROFILES_FOUND=0
PROFILES_MODIFIED=0

process_profile() {
    local profile_dir="$1"
    local profile_name
    profile_name="$(basename "$profile_dir")"

    local prefs_file="$profile_dir/Secure Preferences"
    if [ ! -f "$prefs_file" ]; then
        return
    fi

    # Check if extension is installed in this profile
    # Pass file path and extension ID via sys.argv to avoid shell injection
    local ext_installed
    ext_installed=$(python3 - "$prefs_file" "$EXTENSION_ID" <<'PYEOF'
import json, sys
try:
    prefs_file, ext_id = sys.argv[1], sys.argv[2]
    with open(prefs_file, 'r') as f:
        prefs = json.load(f)
    settings = prefs.get('extensions', {}).get('settings', {})
    print('yes' if ext_id in settings else 'no')
except Exception as e:
    print('error:' + str(e), file=sys.stderr)
    print('no')
PYEOF
    )

    if [ "$ext_installed" != "yes" ]; then
        return
    fi

    PROFILES_FOUND=$((PROFILES_FOUND + 1))

    # Check current permission state
    local perm_state
    perm_state=$(python3 - "$prefs_file" "$EXTENSION_ID" <<'PYEOF'
import json, sys
try:
    prefs_file, ext_id = sys.argv[1], sys.argv[2]
    with open(prefs_file, 'r') as f:
        prefs = json.load(f)
    ext = prefs.get('extensions', {}).get('settings', {}).get(ext_id, {})
    withholding = ext.get('withholding_permissions', False)
    granted = ext.get('granted_permissions', {}).get('explicit_host', [])
    active = ext.get('active_permissions', {}).get('explicit_host', [])
    has_all_urls_granted = '<all_urls>' in granted
    has_all_urls_active = '<all_urls>' in active
    if not withholding and has_all_urls_granted and has_all_urls_active:
        print('granted')
    elif withholding:
        print('withheld')
    elif not has_all_urls_granted:
        print('missing_granted')
    elif not has_all_urls_active:
        print('missing_active')
    else:
        print('unknown')
except Exception as e:
    print('error:' + str(e), file=sys.stderr)
    print('error')
PYEOF
    )

    if [ "$perm_state" = "granted" ]; then
        echo -e "  ${GREEN}$profile_name: Host permissions already granted${NC}"
        return
    fi

    if [ "$CHECK_ONLY" = true ]; then
        echo -e "  ${YELLOW}$profile_name: Permissions need grant (state: $perm_state)${NC}"
        return
    fi

    # Back up Secure Preferences
    cp "$prefs_file" "${prefs_file}.bak"

    # Modify permissions
    local modify_result
    modify_result=$(python3 - "$prefs_file" "$EXTENSION_ID" <<'PYEOF'
import json, sys
try:
    prefs_file, ext_id = sys.argv[1], sys.argv[2]
    with open(prefs_file, 'r') as f:
        prefs = json.load(f)

    ext = prefs.setdefault('extensions', {}).setdefault('settings', {}).get(ext_id)
    if ext is None:
        print('not_found')
        sys.exit(0)

    # Set granted_permissions.explicit_host
    granted = ext.setdefault('granted_permissions', {})
    granted['explicit_host'] = ['<all_urls>']

    # Set active_permissions.explicit_host
    active = ext.setdefault('active_permissions', {})
    active['explicit_host'] = ['<all_urls>']

    # Disable permission withholding
    ext['withholding_permissions'] = False

    # Delete the extension's MAC entry to force Chrome to recalculate
    protection = prefs.get('protection', {})
    macs = protection.get('macs', {})
    ext_settings_macs = macs.get('extensions', {}).get('settings', {})
    if ext_id in ext_settings_macs:
        del ext_settings_macs[ext_id]

    # Delete super_mac to force full recalculation
    if 'super_mac' in protection:
        del protection['super_mac']

    with open(prefs_file, 'w') as f:
        json.dump(prefs, f, separators=(',', ':'))

    print('ok')
except Exception as e:
    print('error:' + str(e), file=sys.stderr)
    print('error')
PYEOF
    )

    if [ "$modify_result" = "ok" ]; then
        PROFILES_MODIFIED=$((PROFILES_MODIFIED + 1))
        echo -e "  ${GREEN}$profile_name: Host permissions granted (backup: Secure Preferences.bak)${NC}"
    else
        # Restore backup on failure
        mv "${prefs_file}.bak" "$prefs_file"
        echo -e "  ${RED}$profile_name: Failed to modify permissions (restored backup)${NC}"
    fi
}

echo -e "${BLUE}Checking Chrome extension permissions...${NC}"

# Process Default profile
if [ -d "$CHROME_DIR/Default" ]; then
    process_profile "$CHROME_DIR/Default"
fi

# Process numbered profiles (Profile 1, Profile 2, etc.)
for profile_dir in "$CHROME_DIR"/Profile\ *; do
    [ -d "$profile_dir" ] && process_profile "$profile_dir"
done

# --- Summary ---
if [ "$PROFILES_FOUND" -eq 0 ]; then
    echo -e "  ${YELLOW}Extension $EXTENSION_ID not found in any Chrome profile${NC}"
    exit 0
fi

if [ "$CHECK_ONLY" = true ]; then
    echo -e "${BLUE}Found extension in $PROFILES_FOUND profile(s)${NC}"
else
    if [ "$PROFILES_MODIFIED" -gt 0 ]; then
        echo -e "${GREEN}Modified $PROFILES_MODIFIED of $PROFILES_FOUND profile(s)${NC}"
    else
        echo -e "${GREEN}All $PROFILES_FOUND profile(s) already have correct permissions${NC}"
    fi
fi
