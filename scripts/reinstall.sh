#!/bin/bash
# Reinstall GENTYR (unprotect → install → protect)
#
# Usage: sudo scripts/reinstall.sh --path /path/to/project
#
# Requires sudo since it handles protection.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path)
            PROJECT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Usage: sudo $0 --path /path/to/project"
            exit 1
            ;;
    esac
done

if [ -z "$PROJECT_DIR" ]; then
    echo "Usage: sudo $0 --path /path/to/project"
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

"$SCRIPT_DIR/setup.sh" --path "$PROJECT_DIR" --unprotect-only 2>/dev/null || true
sudo -u "$ORIGINAL_USER" "$SCRIPT_DIR/setup.sh" --path "$PROJECT_DIR"
"$SCRIPT_DIR/setup.sh" --path "$PROJECT_DIR" --protect-only
