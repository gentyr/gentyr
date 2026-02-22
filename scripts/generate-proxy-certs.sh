#!/bin/bash
# Generate TLS certificates for GENTYR rotation proxy.
# One-time setup, idempotent (skips if certs already exist).
#
# Usage:
#   scripts/generate-proxy-certs.sh          # Generate certs
#   scripts/generate-proxy-certs.sh --remove # Remove certs and untrust CA

set -euo pipefail

CERT_DIR="${HOME}/.claude/proxy-certs"
CA_KEY="${CERT_DIR}/ca-key.pem"
CA_CERT="${CERT_DIR}/ca.pem"
SERVER_KEY="${CERT_DIR}/server-key.pem"
SERVER_CERT="${CERT_DIR}/server.pem"
SERVER_CSR="${CERT_DIR}/server.csr"
SAN_CONFIG="${CERT_DIR}/san.cnf"
SRLFILE="${CERT_DIR}/ca.srl"

# ---------------------------------------------------------------------------
# --remove: untrust and delete
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--remove" ]]; then
  echo "[generate-proxy-certs] Removing proxy certs..."

  if [[ -f "${CA_CERT}" ]]; then
    echo "[generate-proxy-certs] Untrusting CA from System Keychain (requires sudo)..."
    sudo security remove-trusted-cert -d "${CA_CERT}" 2>/dev/null || true
    echo "[generate-proxy-certs] CA untrusted."
  fi

  if [[ -d "${CERT_DIR}" ]]; then
    rm -rf "${CERT_DIR}"
    echo "[generate-proxy-certs] Deleted ${CERT_DIR}"
  else
    echo "[generate-proxy-certs] Nothing to remove (${CERT_DIR} does not exist)."
  fi

  echo "[generate-proxy-certs] Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------

if [[ -f "${CA_CERT}" && -f "${SERVER_KEY}" && -f "${SERVER_CERT}" ]]; then
  echo "[generate-proxy-certs] Certs already exist in ${CERT_DIR} — skipping generation."
  echo "[generate-proxy-certs] To regenerate, run: scripts/generate-proxy-certs.sh --remove && scripts/generate-proxy-certs.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# Require openssl
# ---------------------------------------------------------------------------

if ! command -v openssl &>/dev/null; then
  echo "[generate-proxy-certs] ERROR: openssl is not installed or not on PATH." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Generate certs
# ---------------------------------------------------------------------------

echo "[generate-proxy-certs] Creating cert directory: ${CERT_DIR}"
mkdir -p "${CERT_DIR}"

# 1. Generate CA private key
echo "[generate-proxy-certs] Generating CA key..."
openssl genrsa -out "${CA_KEY}" 2048 2>/dev/null

# 2. Generate CA self-signed certificate (valid 10 years)
echo "[generate-proxy-certs] Generating CA certificate..."
openssl req -new -x509 \
  -key "${CA_KEY}" \
  -out "${CA_CERT}" \
  -days 3650 \
  -subj "/CN=GENTYR Rotation Proxy CA/O=GENTYR/OU=Proxy" \
  2>/dev/null

# 3. Generate server private key
echo "[generate-proxy-certs] Generating server key..."
openssl genrsa -out "${SERVER_KEY}" 2048 2>/dev/null

# 4. Generate CSR
echo "[generate-proxy-certs] Generating server CSR..."
openssl req -new \
  -key "${SERVER_KEY}" \
  -out "${SERVER_CSR}" \
  -subj "/CN=api.anthropic.com/O=GENTYR/OU=Proxy" \
  2>/dev/null

# 5. Write SAN config
cat > "${SAN_CONFIG}" <<EOF
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = api.anthropic.com
DNS.2 = mcp-proxy.anthropic.com
DNS.3 = *.anthropic.com
EOF

# 6. Sign server certificate with CA (valid 10 years, with SAN)
echo "[generate-proxy-certs] Signing server certificate..."
openssl x509 -req \
  -in "${SERVER_CSR}" \
  -CA "${CA_CERT}" \
  -CAkey "${CA_KEY}" \
  -CAcreateserial \
  -out "${SERVER_CERT}" \
  -days 3650 \
  -extensions v3_req \
  -extfile "${SAN_CONFIG}" \
  2>/dev/null

# 7. Trust CA in macOS System Keychain
echo "[generate-proxy-certs] Trusting CA in macOS System Keychain (requires sudo)..."
sudo security add-trusted-cert \
  -d \
  -r trustRoot \
  -k /Library/Keychains/System.keychain \
  "${CA_CERT}"
echo "[generate-proxy-certs] CA trusted in System Keychain."

# 8. Clean up temporary files
echo "[generate-proxy-certs] Cleaning up temporary files..."
rm -f "${SERVER_CSR}" "${SAN_CONFIG}" "${SRLFILE}"

# 9. Set permissions
chmod 600 "${CA_KEY}" "${SERVER_KEY}"
chmod 644 "${CA_CERT}" "${SERVER_CERT}"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "[generate-proxy-certs] SUCCESS — certificates generated:"
echo "  CA cert:     ${CA_CERT}"
echo "  CA key:      ${CA_KEY}"
echo "  Server cert: ${SERVER_CERT}"
echo "  Server key:  ${SERVER_KEY}"
echo ""
echo "[generate-proxy-certs] Next steps:"
echo "  1. Start the proxy:  CLAUDE_PROJECT_DIR=/path/to/project node scripts/rotation-proxy.js"
echo "  2. Configure Claude: export HTTPS_PROXY=http://localhost:18080"
echo "  3. Health check:     curl http://localhost:18080/__health"
