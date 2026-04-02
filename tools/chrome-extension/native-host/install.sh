#!/bin/bash
# Install the Gentyr native messaging host for Chrome.
# Registers the host manifest so Chrome can launch host.cjs when the extension connects.

set -euo pipefail

EXTENSION_ID="dojoamdbiafnflmaknagfcakgpdkmpmn"
HOST_NAME="com.gentyr.chrome_browser_extension"

# Resolve absolute path to host.cjs
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="${SCRIPT_DIR}/host.cjs"

if [ ! -f "$HOST_PATH" ]; then
  echo "Error: host.cjs not found at $HOST_PATH" >&2
  exit 1
fi

# Ensure host.cjs is executable
chmod +x "$HOST_PATH"

# Determine native messaging host directory
if [ "$(uname)" = "Darwin" ]; then
  NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$NMH_DIR"

MANIFEST_PATH="${NMH_DIR}/${HOST_NAME}.json"

# Write native messaging host manifest
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Gentyr Browser Automation Native Host",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

echo "Native messaging host installed:"
echo "  Manifest: $MANIFEST_PATH"
echo "  Host:     $HOST_PATH"
echo "  Extension ID: $EXTENSION_ID"
