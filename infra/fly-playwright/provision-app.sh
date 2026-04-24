#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

success() { echo -e "${GREEN}[OK]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[SKIP]${RESET} $*"; }
err()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; }

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
APP_NAME=""
REGION="iad"
MACHINE_SIZE="shared-cpu-2x"
MACHINE_RAM="2048"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --app-name NAME [--region REGION] [--machine-size SIZE] [--machine-ram RAM]"
  echo ""
  echo "Options:"
  echo "  --app-name      NAME   Required. Fly.io app name."
  echo "  --region        REGION Region to deploy to. Default: iad"
  echo "  --machine-size  SIZE   VM size. Default: shared-cpu-2x"
  echo "  --machine-ram   RAM    VM memory in MB. Default: 2048"
  echo ""
  echo "Example:"
  echo "  $0 --app-name my-playwright-runner --region iad"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-name)
      APP_NAME="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --machine-size)
      MACHINE_SIZE="$2"
      shift 2
      ;;
    --machine-ram)
      MACHINE_RAM="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$APP_NAME" ]]; then
  err "--app-name is required"
  usage
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve script directory (so we can find the Dockerfile + template)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
echo "Checking dependencies ..."

if ! command -v flyctl &>/dev/null; then
  err "flyctl is not installed."
  echo ""
  echo "Install it with:"
  echo "  curl -L https://fly.io/install.sh | sh"
  echo ""
  echo "Then add it to your PATH and re-run this script."
  exit 1
fi

success "flyctl found: $(flyctl version --json 2>/dev/null | grep -o '"version":"[^"]*"' | head -1 || flyctl version 2>/dev/null | head -1)"

if ! flyctl auth whoami &>/dev/null; then
  err "Not authenticated with Fly.io."
  echo ""
  echo "Log in with:"
  echo "  flyctl auth login"
  exit 1
fi

WHOAMI="$(flyctl auth whoami 2>/dev/null)"
success "Authenticated as: $WHOAMI"

# ---------------------------------------------------------------------------
# Generate fly.toml from template
# ---------------------------------------------------------------------------
TEMPLATE="$SCRIPT_DIR/fly.toml.template"
TOML_OUT="$SCRIPT_DIR/fly.toml"

if [[ ! -f "$TEMPLATE" ]]; then
  err "Template not found: $TEMPLATE"
  exit 1
fi

echo "Generating fly.toml from template ..."

sed \
  -e "s/{{APP_NAME}}/$APP_NAME/g" \
  -e "s/{{REGION}}/$REGION/g" \
  -e "s/{{MACHINE_SIZE}}/$MACHINE_SIZE/g" \
  -e "s/{{MACHINE_RAM}}/$MACHINE_RAM/g" \
  "$TEMPLATE" > "$TOML_OUT"

success "Generated $TOML_OUT"

# ---------------------------------------------------------------------------
# Create Fly.io app (idempotent)
# ---------------------------------------------------------------------------
echo "Checking if app '$APP_NAME' exists ..."

if flyctl apps list 2>/dev/null | grep -q "^$APP_NAME[[:space:]]"; then
  warn "App '$APP_NAME' already exists — skipping creation"
else
  echo "Creating app '$APP_NAME' ..."
  flyctl apps create "$APP_NAME" --org personal
  success "App '$APP_NAME' created"
fi

# ---------------------------------------------------------------------------
# Create volume (idempotent)
# ---------------------------------------------------------------------------
echo "Checking if volume 'playwright_cache' exists in region '$REGION' ..."

if flyctl volumes list --app "$APP_NAME" 2>/dev/null | grep -q "playwright_cache"; then
  warn "Volume 'playwright_cache' already exists in app '$APP_NAME' — skipping creation"
else
  echo "Creating volume 'playwright_cache' (5GB, region: $REGION) ..."
  flyctl volumes create playwright_cache \
    --size 5 \
    --region "$REGION" \
    --app "$APP_NAME" \
    --yes
  success "Volume 'playwright_cache' created"
fi

# ---------------------------------------------------------------------------
# Build and deploy
# ---------------------------------------------------------------------------
echo "Deploying app '$APP_NAME' (remote build) ..."

flyctl deploy \
  --app "$APP_NAME" \
  --config "$TOML_OUT" \
  --remote-only

success "App '$APP_NAME' deployed successfully"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}==============================================${RESET}"
echo -e "${GREEN}  Fly.io Playwright runner provisioned!${RESET}"
echo -e "${GREEN}==============================================${RESET}"
echo ""
echo "  App name    : $APP_NAME"
echo "  Region      : $REGION"
echo "  VM size     : $MACHINE_SIZE"
echo "  VM memory   : ${MACHINE_RAM}MB"
echo ""
echo "To run a test on this machine, set GIT_REMOTE, GIT_REF, and TEST_FILE"
echo "as secrets/env vars and start a machine with:"
echo ""
echo "  flyctl machines run . --app $APP_NAME \\"
echo "    --env GIT_REMOTE=<repo-url> \\"
echo "    --env GIT_REF=<branch-or-tag> \\"
echo "    --env TEST_FILE=<path/to/test.spec.ts>"
echo ""
