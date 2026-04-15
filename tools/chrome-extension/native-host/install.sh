#!/bin/bash
# Install the Gentyr native messaging host for Chrome.
# Creates a launcher wrapper with the absolute node path (Chrome's PATH
# doesn't include Homebrew/nvm/fnm directories) and registers the NMH manifest.

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

# Find absolute node path — Chrome's launchd PATH won't include Homebrew/nvm/fnm
NODE_BIN="$(which node 2>/dev/null || command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

# Create a launcher wrapper that uses the absolute node path
LAUNCHER_PATH="${SCRIPT_DIR}/launch-host.sh"
cat > "$LAUNCHER_PATH" <<LAUNCH_EOF
#!/bin/bash
# Clear NODE_OPTIONS to prevent preload modules (e.g. node-version-shim.cjs from
# nvm/fnm) from crashing the native host when launched by Chrome
unset NODE_OPTIONS
exec "${NODE_BIN}" "${HOST_PATH}" "\$@"
LAUNCH_EOF
chmod +x "$LAUNCHER_PATH"

# Determine native messaging host directory
if [ "$(uname)" = "Darwin" ]; then
  NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$NMH_DIR"

MANIFEST_PATH="${NMH_DIR}/${HOST_NAME}.json"

# Write native messaging host manifest — points to launcher, not host.cjs directly
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Gentyr Browser Automation Native Host",
  "path": "${LAUNCHER_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

echo "Native messaging host installed:"
echo "  Manifest:  $MANIFEST_PATH"
echo "  Launcher:  $LAUNCHER_PATH"
echo "  Host:      $HOST_PATH"
echo "  Node:      $NODE_BIN"
echo "  Extension: $EXTENSION_ID"
