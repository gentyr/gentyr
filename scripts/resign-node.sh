#!/bin/bash
# Re-sign Homebrew's Node.js binary for macOS TCC persistence
#
# macOS TCC (Transparency, Consent, and Control) requires binaries to have
# a stable code identity to remember permission grants. Homebrew's node is
# ad-hoc signed (no team identifier), so macOS re-prompts on every new
# process. This script creates a self-signed certificate and re-signs node,
# giving it a stable identity that TCC can persist.
#
# Run after: brew upgrade node
# Run during: GENTYR setup (called automatically by setup.sh)
#
# Usage: scripts/resign-node.sh [--check] [--trigger-tcc]

set -eo pipefail

CERT_NAME="NodeLocalDev"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Resolve the actual node binary (follow symlinks)
NODE_SYMLINK="/opt/homebrew/bin/node"
if [ ! -e "$NODE_SYMLINK" ]; then
    # Fallback for non-Homebrew installs
    NODE_SYMLINK="$(which node 2>/dev/null || true)"
    if [ -z "$NODE_SYMLINK" ]; then
        echo -e "${RED}Error: node not found${NC}"
        exit 1
    fi
fi
NODE_PATH="$(readlink -f "$NODE_SYMLINK" 2>/dev/null || realpath "$NODE_SYMLINK" 2>/dev/null || echo "$NODE_SYMLINK")"

# --check mode: just report current signing status
if [ "$1" = "--check" ]; then
    AUTHORITY=$(codesign -dvv "$NODE_PATH" 2>&1 | grep "^Authority=" | head -1 | cut -d= -f2)
    if [ "$AUTHORITY" = "$CERT_NAME" ]; then
        echo -e "${GREEN}Node is signed with $CERT_NAME${NC}"
        echo "  Binary: $NODE_PATH"
        exit 0
    elif echo "$AUTHORITY" | grep -q "adhoc"; then
        echo -e "${YELLOW}Node has ad-hoc signature (TCC prompts will repeat)${NC}"
        echo "  Binary: $NODE_PATH"
        exit 1
    else
        echo -e "${YELLOW}Node signed by: ${AUTHORITY:-unknown}${NC}"
        echo "  Binary: $NODE_PATH"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# TCC trigger: run op through node so macOS attributes the access to node
# ---------------------------------------------------------------------------
trigger_tcc_prompt() {
    # Check if op is installed
    if ! command -v op &>/dev/null; then
        echo -e "  ${YELLOW}1Password CLI (op) not found - skipping TCC trigger${NC}"
        return 0
    fi

    echo -e "${YELLOW}Triggering macOS TCC permission for 1Password access...${NC}"
    echo -e "  (If a macOS dialog appears, click Allow to grant permission)"

    # Run op through node so macOS attributes the IPC access to node's code identity.
    # This mirrors what hourly-automation.js does with execFileSync('op', ...).
    TCC_RESULT=$("$NODE_PATH" -e "
        const { execFileSync } = require('child_process');
        try {
            execFileSync('op', ['vault', 'list', '--format', 'json'], {
                encoding: 'utf-8',
                timeout: 30000,
                stdio: 'pipe',
            });
            process.stdout.write('ok');
        } catch (err) {
            process.stderr.write(err.message || 'failed');
            process.exit(1);
        }
    " 2>/dev/null) || true

    if [ "$TCC_RESULT" = "ok" ]; then
        echo -e "  ${GREEN}TCC permission granted - verifying persistence...${NC}"
        # Run a second time to confirm no new prompt appears
        VERIFY_RESULT=$("$NODE_PATH" -e "
            const { execFileSync } = require('child_process');
            try {
                execFileSync('op', ['vault', 'list', '--format', 'json'], {
                    encoding: 'utf-8',
                    timeout: 15000,
                    stdio: 'pipe',
                });
                process.stdout.write('persisted');
            } catch {
                process.stdout.write('failed');
            }
        " 2>/dev/null) || true

        if [ "$VERIFY_RESULT" = "persisted" ]; then
            echo -e "  ${GREEN}TCC permission verified and persisted - no future prompts expected${NC}"
        else
            echo -e "  ${YELLOW}TCC verification inconclusive - permission may need re-granting${NC}"
        fi
    else
        echo -e "  ${YELLOW}1Password access check failed (may not be signed in)${NC}"
        echo -e "  ${YELLOW}TCC prompt will appear on first automation run instead${NC}"
    fi
}

# --trigger-tcc mode: just trigger and verify TCC without re-signing
if [ "$1" = "--trigger-tcc" ]; then
    trigger_tcc_prompt
    exit 0
fi

echo -e "${YELLOW}Re-signing node for macOS TCC persistence...${NC}"
echo "  Binary: $NODE_PATH"

# Check if certificate exists
CERT_EXISTS=$(security find-identity -v -p codesigning 2>&1 | grep "$CERT_NAME" || true)

if [ -z "$CERT_EXISTS" ]; then
    echo -e "  ${YELLOW}Creating self-signed codesigning certificate '$CERT_NAME'...${NC}"

    # Generate certificate with openssl
    TMPDIR_CERT="$(mktemp -d)"
    openssl req -x509 -newkey rsa:2048 \
        -keyout "$TMPDIR_CERT/key.pem" \
        -out "$TMPDIR_CERT/cert.pem" \
        -days 3650 \
        -nodes \
        -subj "/CN=$CERT_NAME/O=LocalDev" \
        -addext "keyUsage=digitalSignature" \
        -addext "extendedKeyUsage=codeSigning" \
        2>/dev/null

    # Create PKCS12 bundle and import into login keychain
    openssl pkcs12 -export \
        -out "$TMPDIR_CERT/cert.p12" \
        -inkey "$TMPDIR_CERT/key.pem" \
        -in "$TMPDIR_CERT/cert.pem" \
        -passout pass:temp123 \
        2>/dev/null

    security import "$TMPDIR_CERT/cert.p12" \
        -k ~/Library/Keychains/login.keychain-db \
        -P temp123 \
        -T /usr/bin/codesign \
        -T /usr/bin/security \
        2>/dev/null

    # Trust the certificate for code signing
    security add-trusted-cert -d -r trustRoot -p codeSign \
        -k ~/Library/Keychains/login.keychain-db \
        "$TMPDIR_CERT/cert.pem" \
        2>/dev/null

    # Clean up temp files
    rm -rf "$TMPDIR_CERT"

    echo -e "  ${GREEN}Certificate '$CERT_NAME' created and trusted${NC}"
fi

# Check current signature
CURRENT_AUTHORITY=$(codesign -dvv "$NODE_PATH" 2>&1 | grep "^Authority=" | head -1 | cut -d= -f2)
if [ "$CURRENT_AUTHORITY" = "$CERT_NAME" ]; then
    echo -e "  ${GREEN}Already signed with $CERT_NAME - no re-signing needed${NC}"
    trigger_tcc_prompt
    exit 0
fi

# Re-sign the node binary
codesign -fs "$CERT_NAME" "$NODE_PATH" 2>&1
echo -e "  ${GREEN}Signed: $NODE_PATH${NC}"

# Verify
VERIFY=$(codesign -dvv "$NODE_PATH" 2>&1 | grep "^Authority=" | head -1)
echo -e "  ${GREEN}Verified: $VERIFY${NC}"
echo ""
echo -e "${GREEN}Done. Node re-signed with $CERT_NAME.${NC}"

# Trigger TCC prompt so the user grants permission now (during setup),
# not randomly later during background automation.
trigger_tcc_prompt
