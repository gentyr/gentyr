/**
 * Gentyr Browser Automation — Stripped Service Worker
 *
 * Handles native messaging only. No auth, no WebSocket bridge, no side panel,
 * no analytics, no scheduled tasks. All tool permissions auto-approved via
 * source:'bridge' + permissionMode:'skip_all_permission_checks'.
 *
 * Based on Claude Chrome Extension v1.0.66.
 */

// --- Imports ------------------------------------------------------------------
// Export mapping (v1.0.66 mcpPermissions-qqAoJjJ8.js):
//   _ = wn (tool executor)    Z = bn (error wrapper)    t = F (TabGroupManager)
import {
  _ as toolExecutor,
  Z as wrapError,
  t as tabGroupManager,
} from './mcpPermissions-qqAoJjJ8.js';

// Export mapping (v1.0.66 PermissionManager-9s959502.js):
//   s = storageSet function   S = STORAGE_KEYS constant
import {
  s as storageSet,
  S as STORAGE_KEYS,
} from './PermissionManager-9s959502.js';

// Leaf dependency — must be imported so mcpPermissions can resolve it
import './index-BVS4T5_D.js';

// --- State --------------------------------------------------------------------
let nativePort = null;
let isConnecting = false;
let mcpConnected = false;

// --- Native Messaging ---------------------------------------------------------

async function connectNativeHost() {
  if (nativePort || isConnecting) return false;
  isConnecting = true;
  try {
    const hasPermission = await chrome.permissions.contains({
      permissions: ['nativeMessaging'],
    });
    if (!hasPermission) return false;
    if (typeof chrome.runtime.connectNative !== 'function') return false;

    const port = chrome.runtime.connectNative('com.gentyr.chrome_browser_extension');

    const connected = await new Promise((resolve) => {
      let settled = false;
      const settle = (val) => {
        if (settled) return;
        settled = true;
        port.onDisconnect.removeListener(onDisconnect);
        port.onMessage.removeListener(onMessage);
        resolve(val);
      };
      const onDisconnect = () => settle(false);
      const onMessage = (msg) => {
        if (msg.type === 'pong') settle(true);
      };
      port.onDisconnect.addListener(onDisconnect);
      port.onMessage.addListener(onMessage);
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        settle(false);
        return;
      }
      setTimeout(() => settle(false), 10_000);
    });

    if (!connected) {
      port.disconnect();
      return false;
    }

    nativePort = port;

    nativePort.onMessage.addListener(async (msg) => {
      await handleNativeMessage(msg);
    });

    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      mcpConnected = false;
      storageSet(STORAGE_KEYS.MCP_CONNECTED, false);
    });

    // Ask native host for current status
    nativePort.postMessage({ type: 'get_status' });
    return true;
  } catch {
    return false;
  } finally {
    isConnecting = false;
  }
}

// --- Message Handling ---------------------------------------------------------

async function handleNativeMessage(msg) {
  switch (msg.type) {
    case 'tool_request':
      await handleToolRequest(msg);
      break;

    case 'mcp_connected':
      mcpConnected = true;
      storageSet(STORAGE_KEYS.MCP_CONNECTED, true);
      await tabGroupManager.initialize();
      tabGroupManager.startTabGroupChangeListener();
      break;

    case 'mcp_disconnected':
      mcpConnected = false;
      storageSet(STORAGE_KEYS.MCP_CONNECTED, false);
      tabGroupManager.stopTabGroupChangeListener();
      break;

    case 'status_response':
      // Informational only
      break;
  }
}

async function handleToolRequest(msg) {
  try {
    const { method, params } = msg;

    if (method !== 'execute_tool') {
      sendResponse({ content: `Unknown method: ${method}` });
      return;
    }

    if (!params?.tool) {
      sendResponse(wrapError('No tool specified'));
      return;
    }

    // Intercept wake_extension — it's not a tool the toolExecutor knows about.
    if (params.tool === 'wake_extension') {
      await handleWakeExtension(params.args || {}, params.client_id);
      return;
    }

    const clientId = params.client_id;

    // Parse tabGroupId
    const rawGroupId = params.args?.tabGroupId;
    const tabGroupId =
      typeof rawGroupId === 'number'
        ? rawGroupId
        : typeof rawGroupId === 'string'
          ? parseInt(rawGroupId, 10) || undefined
          : undefined;

    // Parse tabId
    const rawTabId = params.args?.tabId;
    const tabId =
      typeof rawTabId === 'number'
        ? rawTabId
        : typeof rawTabId === 'string'
          ? parseInt(rawTabId, 10) || undefined
          : undefined;

    // Execute tool with all permissions bypassed
    const result = await toolExecutor({
      toolName: params.tool,
      args: params.args || {},
      tabId,
      tabGroupId,
      clientId,
      source: 'bridge',
      permissionMode: 'skip_all_permission_checks',
      sessionScope: params.session_scope,
    });

    sendResponse(result, clientId);
  } catch (err) {
    sendResponse(
      wrapError(
        `Tool execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      ),
    );
  }
}

async function handleWakeExtension(args, clientId) {
  const extensionId = args.extension_id;

  if (typeof extensionId !== 'string' || extensionId.length === 0) {
    sendResponse(wrapError('wake_extension: extension_id is required'), clientId);
    return;
  }

  try {
    // chrome.runtime.sendMessage wakes the target SW if externally_connectable is configured.
    // Returns the target's onMessageExternal reply, or rejects if no listener / config missing.
    const response = await chrome.runtime.sendMessage(extensionId, { type: 'wake' });
    const result = {
      success: true,
      method: 'chrome.runtime.sendMessage',
      extension_id: extensionId,
      response_received: response !== undefined,
    };
    sendResponse({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }, clientId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const result = {
      success: false,
      extension_id: extensionId,
      error: errMsg,
      remediation: `Target extension must declare externally_connectable.ids containing "${chrome.runtime.id}" in its manifest.json. If this is the proxy-chrome extension, add:\n  "externally_connectable": { "ids": ["${chrome.runtime.id}"] }\nand a chrome.runtime.onMessageExternal listener that responds to { type: 'wake' }.`,
    };
    sendResponse(
      { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], is_error: true },
      clientId,
    );
  }
}

function sendResponse({ content, is_error }, clientId) {
  if (!nativePort) return;
  if (!content || (typeof content !== 'string' && !Array.isArray(content))) return;

  const msg = is_error
    ? { type: 'tool_response', error: { content } }
    : { type: 'tool_response', result: { content } };

  nativePort.postMessage(msg);
}

// --- Offscreen Document (keepalive) -------------------------------------------

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Keep service worker alive for browser automation',
    });
  } catch {
    // Already exists or not supported
  }
}

// --- Lifecycle ----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await tabGroupManager.initialize();
  connectNativeHost();
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await tabGroupManager.initialize();
  connectNativeHost();
  ensureOffscreen();
});

// Handle keepalive pings from offscreen document
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SW_KEEPALIVE') {
    sendResponse();
    return;
  }
  sendResponse();
});

// Clean up tab group state when tabs close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tabGroupManager.handleTabClosed(tabId);
});

// --- Startup ------------------------------------------------------------------

connectNativeHost();
ensureOffscreen();
