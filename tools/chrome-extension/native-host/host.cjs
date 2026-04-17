#!/usr/bin/env node
/**
 * Gentyr Native Messaging Host
 *
 * Bridges Chrome native messaging (stdin/stdout) to Unix domain sockets.
 * MCP servers connect to the socket; tool requests/responses are relayed
 * bidirectionally between the Chrome extension and socket clients.
 *
 * Protocol (both channels): 4-byte little-endian uint32 length prefix + UTF-8 JSON
 *
 * Socket location: /tmp/claude-mcp-browser-bridge-{username}/{pid}.sock
 *
 * Message wrapping: Socket clients send bare requests like
 *   { method: 'execute_tool', params: { tool, args, client_id } }
 * The native host wraps these into Chrome native messaging format:
 *   { type: 'tool_request', method: 'execute_tool', params: { ... } }
 * Responses from Chrome are unwrapped (type/tool_response stripped) before
 * being relayed back to the requesting socket client.
 */

const { createServer } = require('net');
const { mkdirSync, rmSync, readdirSync, statSync, existsSync, chmodSync, writeFileSync } = require('fs');
const { join } = require('path');
const { userInfo } = require('os');

// --- Config -------------------------------------------------------------------

const username = userInfo().username || 'default';
const socketDir = join('/tmp', `claude-mcp-browser-bridge-${username}`);
const socketPath = join(socketDir, `${process.pid}.sock`);

// Chrome native messaging enforces a 1MB message size limit
const MAX_NATIVE_MESSAGE_SIZE = 1024 * 1024;

// --- Chrome Native Messaging (stdin/stdout) -----------------------------------

function readNativeMessage(callback) {
  let buffer = Buffer.alloc(0);
  let expectedLength = null;

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (expectedLength === null) {
        if (buffer.length < 4) return;
        expectedLength = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }

      if (buffer.length < expectedLength) return;

      const jsonBuf = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);
      expectedLength = null;

      try {
        const msg = JSON.parse(jsonBuf.toString('utf-8'));
        callback(msg);
      } catch {
        // Malformed message — skip
      }
    }
  });

  process.stdin.on('end', () => {
    cleanup();
    process.exit(0);
  });
}

function writeNativeMessage(msg) {
  const json = JSON.stringify(msg);
  const data = Buffer.from(json, 'utf-8');
  if (data.length > MAX_NATIVE_MESSAGE_SIZE) {
    // Chrome will silently drop messages exceeding 1MB
    // Send a truncated error response instead
    const errorMsg = {
      type: 'tool_response',
      error: { content: [{ type: 'text', text: 'Response too large for native messaging (>1MB)' }] },
    };
    const errorData = Buffer.from(JSON.stringify(errorMsg), 'utf-8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(errorData.length, 0);
    process.stdout.write(Buffer.concat([header, errorData]));
    return;
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([header, data]));
}

// --- Socket Protocol ----------------------------------------------------------

function encodeSocketMessage(msg) {
  const json = JSON.stringify(msg);
  const data = Buffer.from(json, 'utf-8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(data.length, 0);
  return Buffer.concat([header, data]);
}

function createSocketReader(onMessage) {
  let buffer = Buffer.alloc(0);
  let expectedLength = null;

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (expectedLength === null) {
        if (buffer.length < 4) return;
        expectedLength = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }

      if (buffer.length < expectedLength) return;

      const jsonBuf = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);
      expectedLength = null;

      try {
        const msg = JSON.parse(jsonBuf.toString('utf-8'));
        onMessage(msg);
      } catch {
        // Malformed message — skip
      }
    }
  };
}

// --- Socket Server ------------------------------------------------------------

const socketClients = new Map(); // id -> socket
let nextClientId = 1;

// Request routing: track which socket client is awaiting a response.
// Tool execution is serialized — one request at a time through Chrome.
const requestQueue = []; // Array of { clientId, resolve? }
let pendingClientId = null; // The client currently awaiting a response

function cleanupStaleSocket(dir) {
  if (!existsSync(dir)) return;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.sock')) continue;
      const pid = parseInt(file.replace('.sock', ''), 10);
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch {
        // PID is dead — remove stale socket
        try { rmSync(join(dir, file)); } catch {}
      }
    }
  } catch {}
}

function startSocketServer() {
  // Ensure socket directory exists with secure permissions
  try {
    mkdirSync(socketDir, { mode: 0o700, recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      process.exit(1);
    }
  }

  // Validate directory ownership and permissions
  try {
    const stats = statSync(socketDir);
    if (stats.uid !== process.getuid()) {
      process.exit(1);
    }
    // Fix overly-permissive directory
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      chmodSync(socketDir, 0o700);
    }
  } catch {
    process.exit(1);
  }

  // Clean up stale sockets from dead processes
  cleanupStaleSocket(socketDir);

  // Remove our own socket if it exists
  try { rmSync(socketPath); } catch {}

  const server = createServer((socket) => {
    const clientId = nextClientId++;
    socketClients.set(clientId, socket);

    // Notify Chrome extension — only on first client connection
    if (socketClients.size === 1) {
      writeNativeMessage({ type: 'mcp_connected' });
    }

    const reader = createSocketReader((msg) => {
      // Socket clients send bare requests: { method: 'execute_tool', params: {...} }
      // Wrap in tool_request envelope for Chrome native messaging protocol
      enqueueRequest(clientId, msg);
    });

    socket.on('data', reader);

    socket.on('close', () => {
      socketClients.delete(clientId);
      // Clear any pending request from this client
      if (pendingClientId === clientId) {
        pendingClientId = null;
        processNextRequest();
      }
      // Notify Chrome only when ALL clients disconnect
      if (socketClients.size === 0) {
        writeNativeMessage({ type: 'mcp_disconnected' });
      }
    });

    socket.on('error', () => {
      socketClients.delete(clientId);
      if (pendingClientId === clientId) {
        pendingClientId = null;
        processNextRequest();
      }
    });
  });

  server.listen(socketPath, () => {
    // Socket ready
  });

  server.on('error', () => {
    process.exit(1);
  });

  return server;
}

// --- Request Queue & Routing --------------------------------------------------

function enqueueRequest(clientId, msg) {
  requestQueue.push({ clientId, msg });
  if (pendingClientId === null) {
    processNextRequest();
  }
}

function processNextRequest() {
  if (requestQueue.length === 0) return;
  const { clientId, msg } = requestQueue.shift();

  // Verify client is still connected
  if (!socketClients.has(clientId)) {
    processNextRequest();
    return;
  }

  pendingClientId = clientId;

  // Wrap bare socket message in tool_request envelope for Chrome
  writeNativeMessage({ type: 'tool_request', ...msg });
}

// --- Message Routing ----------------------------------------------------------

function handleChromeMessage(msg) {
  // Handle demo interrupt signal — write signal file for MCP server to detect
  if (msg.type === 'demo_interrupt') {
    const signalPath = join('/tmp', 'gentyr-demo-interrupt.signal');
    try {
      writeFileSync(signalPath, new Date().toISOString());
    } catch { /* best-effort */ }
    writeNativeMessage({ type: 'demo_interrupt_ack' });
    return;
  }

  // Handle ping/pong handshake
  if (msg.type === 'ping') {
    writeNativeMessage({ type: 'pong' });
    return;
  }

  if (msg.type === 'get_status') {
    writeNativeMessage({
      type: 'status_response',
      nativeHostInstalled: true,
      mcpConnected: socketClients.size > 0,
    });
    return;
  }

  // Route tool responses to the requesting socket client only
  if (msg.type === 'tool_response' || msg.result || msg.error) {
    if (pendingClientId !== null) {
      const socket = socketClients.get(pendingClientId);
      if (socket && !socket.destroyed) {
        // Strip the native messaging envelope — send bare result/error
        const response = {};
        if (msg.result) response.result = msg.result;
        if (msg.error) response.error = msg.error;
        socket.write(encodeSocketMessage(response));
      }
      pendingClientId = null;
    }
    // Process next queued request
    processNextRequest();
    return;
  }
}

// --- Cleanup ------------------------------------------------------------------

function cleanup() {
  for (const [, socket] of socketClients) {
    try { socket.destroy(); } catch {}
  }
  socketClients.clear();

  try { rmSync(socketPath); } catch {}

  try {
    const remaining = readdirSync(socketDir);
    if (remaining.length === 0) {
      rmSync(socketDir, { recursive: true });
    }
  } catch {}
}

// --- Main ---------------------------------------------------------------------

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

const server = startSocketServer();
readNativeMessage(handleChromeMessage);
