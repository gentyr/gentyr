/**
 * Steel.dev Cloud Browser Runner
 *
 * Generic REST API client for Steel.dev cloud browser sessions.
 * Pure HTTP calls — no target project imports.
 *
 * Steel provides stealth cloud browsers with residential proxies,
 * CAPTCHA solving, and undetectable Chromium for scenarios requiring
 * anti-bot evasion.
 *
 * Connection model: Steel sessions expose a CDP WebSocket URL.
 * Playwright connects via `chromium.connectOverCDP(wsUrl)`.
 * GENTYR passes STEEL_CDP_URL as an env var; target project test
 * code handles the actual connection.
 *
 * API base: https://api.steel.dev
 * Auth: `steel-api-key` header
 * CDP WebSocket: wss://connect.steel.dev?apiKey={key}&sessionId={id}
 */

// ============================================================================
// Types
// ============================================================================

export interface SteelConfig {
  /** Resolved Steel API key (plaintext, NOT an op:// reference) */
  apiKey: string;
  /** Steel.dev organization ID (optional) */
  orgId?: string;
  /** Default session timeout in ms (default: 300000 = 5 min) */
  defaultTimeout?: number;
  /** Pre-uploaded extension ID to load in sessions */
  extensionId?: string;
  /** Proxy configuration */
  proxyConfig?: {
    enabled: boolean;
    country?: string;
  };
  /** Default region (e.g. 'iad', 'lax'). Steel picks one automatically when omitted. */
  region?: string;
}

export interface SteelSessionHandle {
  /** Steel session ID */
  sessionId: string;
  /** CDP WebSocket URL for Playwright connection */
  cdpUrl: string;
  /** Live session viewer URL (for debugging) */
  sessionViewerUrl?: string;
  /** Session status */
  status: string;
  /** When the session was created */
  createdAt: string;
  /** Profile ID associated with this session (set when persistProfile was used or profileId was loaded) */
  profileId?: string;
}

export interface SteelSessionInfo {
  sessionId: string;
  status: string;
  createdAt: string;
}

export interface CreateSessionOptions {
  /** Session timeout in ms (default: from config or 300000) */
  timeout?: number;
  /** Enable residential proxy */
  useProxy?: boolean;
  /** Proxy country code (e.g., 'US') */
  proxyCountry?: string;
  /** Enable automatic CAPTCHA solving */
  solveCaptcha?: boolean;
  /** Extension IDs to load in the session */
  extensions?: string[];
  /** Custom user agent */
  userAgent?: string;
  /** Steel region (overrides config.region for this session) */
  region?: string;
  /**
   * Load a previously saved profile (cookies/localStorage/extensions/fingerprint).
   * When set, the session starts in the state the profile was last saved at.
   */
  profileId?: string;
  /**
   * Persist this session's state as a Steel Profile on release. The returned
   * SteelSessionHandle will include the assigned `profileId` once Steel
   * confirms the persistence, so callers can wire it back into a scenario
   * for the next run.
   */
  persistProfile?: boolean;
  /**
   * Caller-provided sessionContext object passed directly to Steel at session
   * create. Use to inject cookies/localStorage captured elsewhere (e.g.
   * Playwright `storageState`) without going through the Profiles API.
   * Transient — Steel does NOT persist this between sessions.
   */
  sessionContext?: Record<string, unknown>;
}

// ============================================================================
// Internal helpers
// ============================================================================

const STEEL_API_BASE = 'https://api.steel.dev';

function steelHeaders(apiKey: string): Record<string, string> {
  return {
    'steel-api-key': apiKey,
    'Content-Type': 'application/json',
  };
}

function buildCdpUrl(apiKey: string, sessionId: string): string {
  return `wss://connect.steel.dev?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(sessionId)}`;
}

async function steelFetch(
  apiKey: string,
  path: string,
  options: RequestInit = {},
  timeoutMs: number = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${STEEL_API_BASE}${path}`, {
      ...options,
      headers: {
        ...steelHeaders(apiKey),
        ...(options.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Session Lifecycle
// ============================================================================

/**
 * Create a new Steel cloud browser session.
 *
 * Returns a handle with the session ID and CDP WebSocket URL.
 * The CDP URL can be passed to target project test code as an
 * environment variable (STEEL_CDP_URL) — GENTYR never connects
 * to the browser directly.
 */
export async function createSteelSession(
  config: SteelConfig,
  options: CreateSessionOptions = {},
): Promise<SteelSessionHandle> {
  const body: Record<string, unknown> = {
    timeout: options.timeout ?? config.defaultTimeout ?? 300000,
  };

  if (options.useProxy ?? config.proxyConfig?.enabled) {
    body.useProxy = true;
  }
  if (options.solveCaptcha) {
    body.solveCaptcha = true;
  }
  if (options.userAgent) {
    body.userAgent = options.userAgent;
  }
  if (options.extensions && options.extensions.length > 0) {
    body.extensions = options.extensions;
  } else if (config.extensionId) {
    body.extensions = [config.extensionId];
  }
  const region = options.region ?? config.region;
  if (region) {
    body.region = region;
  }
  if (options.profileId) {
    // Load a previously saved Profile
    body.profileId = options.profileId;
  }
  if (options.persistProfile) {
    // Save this session's state as a Profile on release
    body.persistProfile = true;
  }
  if (options.sessionContext) {
    // Inject caller-supplied cookies/localStorage at session create time.
    body.sessionContext = options.sessionContext;
  }

  const response = await steelFetch(config.apiKey, '/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Steel session creation failed (${response.status}): ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const sessionId = data.id as string;

  if (!sessionId) {
    throw new Error('Steel session creation returned no session ID');
  }

  return {
    sessionId,
    cdpUrl: buildCdpUrl(config.apiKey, sessionId),
    sessionViewerUrl: data.sessionViewerUrl as string | undefined,
    status: (data.status as string) || 'active',
    createdAt: (data.createdAt as string) || new Date().toISOString(),
    profileId: (data.profileId as string | undefined) ?? options.profileId,
  };
}

/**
 * Get the current status of a Steel session.
 */
export async function getSteelSession(
  config: SteelConfig,
  sessionId: string,
): Promise<{ sessionId: string; status: string; alive: boolean }> {
  try {
    const response = await steelFetch(config.apiKey, `/v1/sessions/${sessionId}`, {
      method: 'GET',
    }, 10000);

    if (!response.ok) {
      return { sessionId, status: 'unknown', alive: false };
    }

    const data = await response.json() as Record<string, unknown>;
    const status = (data.status as string) || 'unknown';

    return {
      sessionId,
      status,
      alive: status === 'live' || status === 'active',
    };
  } catch {
    return { sessionId, status: 'unreachable', alive: false };
  }
}

/**
 * Release (stop) a Steel session.
 *
 * Non-fatal — logs a warning if release fails but does not throw.
 * Sessions auto-release after their timeout, so this is best-effort cleanup.
 */
export async function releaseSteelSession(
  config: SteelConfig,
  sessionId: string,
): Promise<void> {
  try {
    const response = await steelFetch(config.apiKey, `/v1/sessions/${sessionId}/release`, {
      method: 'POST',
    }, 10000);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[steel-runner] Failed to release session ${sessionId} (${response.status}): ${text}`);
    }
  } catch (err) {
    console.error(`[steel-runner] Error releasing session ${sessionId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * List active Steel sessions for capacity checks.
 */
export async function listActiveSteelSessions(
  config: SteelConfig,
): Promise<SteelSessionInfo[]> {
  try {
    const response = await steelFetch(config.apiKey, '/v1/sessions', {
      method: 'GET',
    }, 10000);

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as Record<string, unknown>;
    const sessions = (data.sessions ?? data.data ?? data) as Array<Record<string, unknown>>;

    if (!Array.isArray(sessions)) {
      return [];
    }

    return sessions
      .filter(s => {
        const status = s.status as string;
        return status === 'live' || status === 'active';
      })
      .map(s => ({
        sessionId: s.id as string,
        status: s.status as string,
        createdAt: (s.createdAt as string) || '',
      }));
  } catch {
    return [];
  }
}

// ============================================================================
// Extensions
// ============================================================================

/**
 * Upload a Chrome extension to Steel.dev (ZIP or CRX format).
 *
 * Returns the extension ID for use in session creation.
 * Extensions are stored at the organization level — upload once, use in many sessions.
 */
export async function uploadSteelExtension(
  config: SteelConfig,
  zipPath: string,
): Promise<{ extensionId: string }> {
  const fs = await import('fs');
  const path = await import('path');

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Extension file not found: ${zipPath}`);
  }

  const fileBuffer = fs.readFileSync(zipPath);
  const fileName = path.basename(zipPath);

  // Steel expects multipart/form-data for file uploads
  const boundary = `----SteelUpload${Date.now()}`;
  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: application/zip\r\n\r\n`,
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Close boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await steelFetch(config.apiKey, '/v1/extensions', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  }, 60000);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Extension upload failed (${response.status}): ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const extensionId = (data.id ?? data.extensionId) as string;

  if (!extensionId) {
    throw new Error('Extension upload returned no extension ID');
  }

  return { extensionId };
}

// ============================================================================
// Recording Download
// ============================================================================

/**
 * Download the MP4 recording for a finished Steel session.
 *
 * Steel records every session natively (WebRTC → MP4). The recording is
 * available after the session enters a terminal state. This function:
 *
 *   1. Polls `GET /v1/sessions/{id}` until the session reaches a terminal
 *      status or the deadline elapses.
 *   2. Probes a small set of plausible recording endpoints and follows
 *      `Location` redirects for any 3xx response (Steel often hands out a
 *      pre-signed CDN URL rather than streaming the bytes directly).
 *   3. Streams the response body to `outputPath`.
 *
 * Returns the absolute path on success, or `null` if the recording is not
 * yet available, the endpoint is missing, or the response is empty. All
 * errors are non-fatal — callers degrade gracefully to "no recording".
 *
 * The exact endpoint shape varies by Steel version, so this implementation
 * is permissive: it tries `/v1/sessions/{id}/recording.mp4`,
 * `/v1/sessions/{id}/recording`, and `/v1/sessions/{id}/replay` in order.
 * The first one to return a 2xx response with a non-empty body wins.
 */
export async function downloadSteelRecording(
  config: SteelConfig,
  sessionId: string,
  outputPath: string,
  opts: { waitForTerminalMs?: number } = {},
): Promise<string | null> {
  const fs = await import('fs');
  const fsp = await import('fs/promises');
  const path = await import('path');
  const { Readable } = await import('stream');
  const { pipeline } = await import('stream/promises');

  // Step 1 — wait for the session to reach a terminal state. Steel doesn't
  // produce a playable MP4 while the session is still live.
  const deadline = Date.now() + (opts.waitForTerminalMs ?? 30000);
  const TERMINAL_STATUSES = new Set(['released', 'completed', 'expired', 'failed', 'stopped']);
  while (Date.now() < deadline) {
    const status = await getSteelSession(config, sessionId);
    if (TERMINAL_STATUSES.has(status.status) || !status.alive) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Step 2 — try plausible recording endpoints in order.
  const candidatePaths = [
    `/v1/sessions/${sessionId}/recording.mp4`,
    `/v1/sessions/${sessionId}/recording`,
    `/v1/sessions/${sessionId}/replay`,
  ];

  for (const candidatePath of candidatePaths) {
    let response: Response;
    try {
      response = await steelFetch(config.apiKey, candidatePath, {
        method: 'GET',
        redirect: 'follow',
      }, 60000);
    } catch (err) {
      console.error(`[steel-runner] Recording fetch ${candidatePath} failed:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (!response.ok) {
      // 404 → endpoint shape differs; try next candidate. Other errors → log and try next.
      if (response.status !== 404) {
        const text = await response.text().catch(() => '');
        console.error(`[steel-runner] Recording fetch ${candidatePath} returned ${response.status}: ${text.slice(0, 200)}`);
      }
      continue;
    }

    if (!response.body) {
      continue;
    }

    // Step 3 — stream to disk
    try {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      const writeStream = fs.createWriteStream(outputPath);
      // Node 18+ exposes ReadableStream on Response; cast through unknown.
      await pipeline(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]), writeStream);
      const stat = await fsp.stat(outputPath).catch(() => null);
      if (!stat || stat.size === 0) {
        // Empty file — Steel returned 200 but no bytes. Clean up and try next candidate.
        try { await fsp.unlink(outputPath); } catch { /* */ }
        continue;
      }
      return outputPath;
    } catch (err) {
      console.error(`[steel-runner] Failed to write recording to ${outputPath}:`, err instanceof Error ? err.message : err);
      try { await fsp.unlink(outputPath); } catch { /* */ }
      // Don't keep trying — disk error is unlikely to be transient.
      return null;
    }
  }

  return null;
}

// Note: checkSteelHealth() lives in execution-target.ts (alongside checkFlyHealth)
// to keep the routing module self-contained. Import it from there.
