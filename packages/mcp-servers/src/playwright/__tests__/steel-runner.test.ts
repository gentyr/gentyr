/**
 * Unit tests for steel-runner.ts
 *
 * Tests the Steel.dev REST API client functions with mocked fetch.
 * Validates request construction, response parsing, error handling,
 * and non-fatal fallback semantics for each exported function.
 *
 * Real HTTP calls are NOT made — fetch is stubbed globally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSteelSession,
  getSteelSession,
  releaseSteelSession,
  listActiveSteelSessions,
  type SteelConfig,
  type CreateSessionOptions,
} from '../steel-runner.js';

// ============================================================================
// Helpers
// ============================================================================

const BASE_CONFIG: SteelConfig = {
  apiKey: 'test-api-key-abc123',
};

function makeFetchResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeFetchResponseText(text: string, status = 500, ok = false): Response {
  return {
    ok,
    status,
    json: async () => { throw new Error('not JSON'); },
    text: async () => text,
  } as unknown as Response;
}

// ============================================================================
// createSteelSession()
// ============================================================================

describe('createSteelSession()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should POST to /v1/sessions and return a session handle', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({
      id: 'sess-001',
      status: 'active',
      createdAt: '2026-04-27T10:00:00Z',
      sessionViewerUrl: 'https://app.steel.dev/sessions/sess-001',
    }));

    const handle = await createSteelSession(BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.steel.dev/v1/sessions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['steel-api-key']).toBe('test-api-key-abc123');

    expect(handle.sessionId).toBe('sess-001');
    expect(handle.status).toBe('active');
    expect(handle.createdAt).toBe('2026-04-27T10:00:00Z');
    expect(handle.sessionViewerUrl).toBe('https://app.steel.dev/sessions/sess-001');
  });

  it('should build CDP URL from apiKey and sessionId', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-abc', status: 'active', createdAt: '' }));

    const handle = await createSteelSession(BASE_CONFIG);

    expect(handle.cdpUrl).toContain('wss://connect.steel.dev');
    expect(handle.cdpUrl).toContain('apiKey=test-api-key-abc123');
    expect(handle.cdpUrl).toContain('sessionId=sess-abc');
  });

  it('should use config.defaultTimeout as the session timeout when not overridden', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-t', status: 'active', createdAt: '' }));
    const config: SteelConfig = { ...BASE_CONFIG, defaultTimeout: 600000 };

    await createSteelSession(config);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.timeout).toBe(600000);
  });

  it('should let options.timeout override config.defaultTimeout', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-ot', status: 'active', createdAt: '' }));
    const config: SteelConfig = { ...BASE_CONFIG, defaultTimeout: 600000 };
    const options: CreateSessionOptions = { timeout: 30000 };

    await createSteelSession(config, options);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.timeout).toBe(30000);
  });

  it('should include useProxy when options.useProxy is true', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-p', status: 'active', createdAt: '' }));

    await createSteelSession(BASE_CONFIG, { useProxy: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.useProxy).toBe(true);
  });

  it('should include useProxy from config.proxyConfig when options does not set it', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-cp', status: 'active', createdAt: '' }));
    const config: SteelConfig = { ...BASE_CONFIG, proxyConfig: { enabled: true, country: 'US' } };

    await createSteelSession(config);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.useProxy).toBe(true);
  });

  it('should include solveCaptcha when options.solveCaptcha is true', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-c', status: 'active', createdAt: '' }));

    await createSteelSession(BASE_CONFIG, { solveCaptcha: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.solveCaptcha).toBe(true);
  });

  it('should include userAgent when options.userAgent is set', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-ua', status: 'active', createdAt: '' }));
    const ua = 'Mozilla/5.0 (Test)';

    await createSteelSession(BASE_CONFIG, { userAgent: ua });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.userAgent).toBe(ua);
  });

  it('should include extensions from options when provided', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-ext', status: 'active', createdAt: '' }));

    await createSteelSession(BASE_CONFIG, { extensions: ['ext-id-1', 'ext-id-2'] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.extensions).toEqual(['ext-id-1', 'ext-id-2']);
  });

  it('should fall back to config.extensionId when options.extensions is empty', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ id: 'sess-cext', status: 'active', createdAt: '' }));
    const config: SteelConfig = { ...BASE_CONFIG, extensionId: 'config-ext-id' };

    await createSteelSession(config, { extensions: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.extensions).toEqual(['config-ext-id']);
  });

  it('should throw when the API returns a non-ok status', async () => {
    fetchMock.mockResolvedValue(makeFetchResponseText('Unauthorized', 401, false));

    await expect(createSteelSession(BASE_CONFIG)).rejects.toThrow(/Steel session creation failed \(401\)/);
  });

  it('should throw when the response contains no session ID', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 'active' })); // no id

    await expect(createSteelSession(BASE_CONFIG)).rejects.toThrow(/no session ID/);
  });

  it('should throw when fetch itself throws (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('Network unreachable'));

    await expect(createSteelSession(BASE_CONFIG)).rejects.toThrow(/Network unreachable/);
  });
});

// ============================================================================
// getSteelSession()
// ============================================================================

describe('getSteelSession()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return alive=true for status "live"', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 'live' }));

    const result = await getSteelSession(BASE_CONFIG, 'sess-123');

    expect(result.sessionId).toBe('sess-123');
    expect(result.status).toBe('live');
    expect(result.alive).toBe(true);
  });

  it('should return alive=true for status "active"', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 'active' }));

    const result = await getSteelSession(BASE_CONFIG, 'sess-456');

    expect(result.alive).toBe(true);
  });

  it('should return alive=false for status "ended"', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ status: 'ended' }));

    const result = await getSteelSession(BASE_CONFIG, 'sess-789');

    expect(result.status).toBe('ended');
    expect(result.alive).toBe(false);
  });

  it('should return alive=false and status="unknown" when API returns non-ok', async () => {
    fetchMock.mockResolvedValue(makeFetchResponseText('Not Found', 404, false));

    const result = await getSteelSession(BASE_CONFIG, 'sess-404');

    expect(result.status).toBe('unknown');
    expect(result.alive).toBe(false);
  });

  it('should return alive=false and status="unreachable" when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    const result = await getSteelSession(BASE_CONFIG, 'sess-err');

    expect(result.status).toBe('unreachable');
    expect(result.alive).toBe(false);
  });
});

// ============================================================================
// releaseSteelSession()
// ============================================================================

describe('releaseSteelSession()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should POST to /v1/sessions/{id}/release', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ ok: true }));

    await releaseSteelSession(BASE_CONFIG, 'sess-release-me');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/sessions/sess-release-me/release');
  });

  it('should not throw when the API returns non-ok (non-fatal, best-effort)', async () => {
    fetchMock.mockResolvedValue(makeFetchResponseText('Already released', 409, false));

    // Must not throw — sessions auto-release after timeout
    await expect(releaseSteelSession(BASE_CONFIG, 'sess-gone')).resolves.toBeUndefined();
  });

  it('should not throw when fetch itself fails (non-fatal)', async () => {
    fetchMock.mockRejectedValue(new Error('Timeout'));

    await expect(releaseSteelSession(BASE_CONFIG, 'sess-timeout')).resolves.toBeUndefined();
  });
});

// ============================================================================
// listActiveSteelSessions()
// ============================================================================

describe('listActiveSteelSessions()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return active sessions from the "sessions" envelope', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({
      sessions: [
        { id: 's1', status: 'live', createdAt: '2026-04-27T09:00:00Z' },
        { id: 's2', status: 'active', createdAt: '2026-04-27T09:05:00Z' },
        { id: 's3', status: 'ended', createdAt: '2026-04-27T08:00:00Z' },
      ],
    }));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toHaveLength(2); // only live and active
    expect(sessions[0].sessionId).toBe('s1');
    expect(sessions[1].sessionId).toBe('s2');
  });

  it('should return active sessions from the "data" envelope', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({
      data: [
        { id: 'd1', status: 'active', createdAt: '' },
      ],
    }));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('d1');
  });

  it('should return active sessions from a bare array response', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse([
      { id: 'a1', status: 'live', createdAt: '' },
    ]));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('a1');
  });

  it('should return empty array when API returns non-ok', async () => {
    fetchMock.mockResolvedValue(makeFetchResponseText('Forbidden', 403, false));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toEqual([]);
  });

  it('should return empty array when fetch throws (non-fatal)', async () => {
    fetchMock.mockRejectedValue(new Error('DNS failure'));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toEqual([]);
  });

  it('should return empty array when response data is not an array', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ sessions: 'not-an-array' }));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toEqual([]);
  });

  it('should filter out sessions without live or active status', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({
      sessions: [
        { id: 'done1', status: 'ended', createdAt: '' },
        { id: 'done2', status: 'failed', createdAt: '' },
        { id: 'done3', status: 'timeout', createdAt: '' },
      ],
    }));

    const sessions = await listActiveSteelSessions(BASE_CONFIG);

    expect(sessions).toHaveLength(0);
  });
});
