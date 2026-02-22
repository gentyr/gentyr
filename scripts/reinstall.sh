#!/bin/bash
# Reinstall GENTYR (unprotect → install → protect)
#
# Usage: sudo scripts/reinstall.sh --path /path/to/project [--op-token <token>] [--makerkit|--no-makerkit]
#
# Requires sudo since it handles protection.
# After reinstall, start a new Claude Code session and run /setup-gentyr
# to configure credentials interactively.
#
# DEPRECATION NOTICE:
#   This script will be superseded by the `npx gentyr` CLI in a future release.
#   Prefer: sudo npx gentyr sync --path /path/to/project

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR=""
OP_TOKEN=""
MAKERKIT_FLAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path)
            PROJECT_DIR="$2"
            shift 2
            ;;
        --op-token)
            OP_TOKEN="$2"
            shift 2
            ;;
        --makerkit)
            MAKERKIT_FLAG="--makerkit"
            shift
            ;;
        --no-makerkit)
            MAKERKIT_FLAG="--no-makerkit"
            shift
            ;;
        *)
            echo "Usage: sudo $0 --path /path/to/project [--op-token <token>] [--makerkit|--no-makerkit]"
            exit 1
            ;;
    esac
done

if [ -z "$PROJECT_DIR" ]; then
    echo "Usage: sudo $0 --path /path/to/project [--op-token <token>] [--makerkit|--no-makerkit]"
    exit 1
fi

if [ "$EUID" -ne 0 ]; then
    echo "Error: requires sudo"
    echo "Usage: sudo $0 --path /path/to/project"
    exit 1
fi

ORIGINAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo $USER)}"

echo "Reinstalling framework at: $PROJECT_DIR"
echo "Running install step as: $ORIGINAL_USER"
echo ""

# 1. Unprotect (as root)
"$SCRIPT_DIR/setup.sh" --path "$PROJECT_DIR" --unprotect-only 2>/dev/null || true

# 2. Install (as user)
SETUP_ARGS=(--path "$PROJECT_DIR")
if [ -n "$OP_TOKEN" ]; then
    SETUP_ARGS+=(--op-token "$OP_TOKEN")
fi
if [ -n "$MAKERKIT_FLAG" ]; then
    SETUP_ARGS+=("$MAKERKIT_FLAG")
fi
sudo -u "$ORIGINAL_USER" "$SCRIPT_DIR/setup.sh" "${SETUP_ARGS[@]}"

# 3. Protect (as root)
"$SCRIPT_DIR/setup.sh" --path "$PROJECT_DIR" --protect-only

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Reinstall complete!"
echo ""
echo "  Next steps:"
echo "    1. Start a new Claude Code session"
echo "    2. Run /setup-gentyr to configure credentials"
echo "════════════════════════════════════════════════════════════"
