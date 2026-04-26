/**
 * Fly Machines API Client
 *
 * Manages ephemeral Fly.io machines that run Playwright tests and demos
 * remotely. Uses the Fly Machines REST API directly via fetch() — no flyctl
 * CLI dependency at runtime.
 *
 * All functions are stateless and can throw FlyAPIError on failure.
 * Debug output goes to stderr only (never stdout — that is the MCP protocol).
 *
 * @see https://fly.io/docs/machines/api/
 */

import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

// ============================================================================
// Constants
// ============================================================================

const FLY_API_BASE = 'https://api.machines.dev/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const MACHINE_START_POLL_INTERVAL_MS = 2_000;
const MACHINE_START_TIMEOUT_MS = 60_000;
const MACHINE_STOP_WAIT_MS = 10_000;

// ============================================================================
// Exported Types
// ============================================================================

export interface FlyConfig {
  /** Resolved FLY_API_TOKEN value (never from agent context) */
  apiToken: string;
  /** From services.json fly.appName */
  appName: string;
  /** From services.json fly.region */
  region: string;
  /** From services.json fly.machineSize */
  machineSize: string;
  /** From services.json fly.machineRam (MB) */
  machineRam: number;
  /** Cache volume ID for dep caching */
  volumeId?: string;
  maxConcurrentMachines: number;
}

export interface RemoteDemoRequest {
  /** e.g., "git@github.com:org/project.git" */
  gitRemote: string;
  /** Branch name or commit SHA */
  gitRef: string;
  /** Relative path to .demo.ts or test file */
  testFile: string;
  /** Pre-resolved secrets + demo env vars */
  env: Record<string, string>;
  /** Max runtime in ms */
  timeout: number;
  slowMo: number;
  /** From devServices config */
  devServerCmd?: string;
  devServerPort?: number;
  devServerHealthCheck?: string;
  /** From worktreeBuildCommand */
  buildCmd?: string;
  buildHealthCheck?: string;
  /** For tracking */
  scenarioId?: string;
}

export interface RemoteDemoHandle {
  machineId: string;
  appName: string;
  region: string;
  /** Date.now() when machine was created */
  startedAt: number;
  scenarioId?: string;
}

export interface RemoteProgressEvent {
  type: 'test_start' | 'test_pass' | 'test_fail' | 'test_skip' | 'step' | 'error' | 'done';
  timestamp: string;
  data: Record<string, unknown>;
}

export interface RemoteArtifact {
  localPath: string;
  type: 'trace' | 'screenshot' | 'report' | 'video' | 'log';
}

export interface MachineState {
  id: string;
  state: 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'destroying' | 'destroyed';
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Error Types
// ============================================================================

export class FlyAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly machineId?: string,
  ) {
    super(message);
    this.name = 'FlyAPIError';
    // Maintain proper prototype chain in transpiled output
    Object.setPrototypeOf(this, FlyAPIError.prototype);
  }
}

// ============================================================================
// Internal Fly API Wire Types
// ============================================================================

interface FlyMachineResponse {
  id: string;
  state: MachineState['state'];
  region: string;
  name: string;
  created_at: string;
  updated_at: string;
  config?: {
    image?: string;
    env?: Record<string, string>;
    auto_destroy?: boolean;
  };
}

interface FlyExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}

// ============================================================================
// Internal: HTTP fetch wrapper
// ============================================================================

/**
 * Wrapper for all Fly API calls with auth, timeout, and retry on 5xx.
 * On 5xx: retries once after RETRY_DELAY_MS.
 * On 4xx: throws FlyAPIError immediately with descriptive message.
 * On network error: throws FlyAPIError.
 */
async function flyFetch(
  config: FlyConfig,
  urlPath: string,
  options?: RequestInit & { timeout?: number },
): Promise<Response> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const url = `${FLY_API_BASE}${urlPath}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined ?? {}),
  };

  const fetchOptions: RequestInit = {
    ...options,
    headers,
  };

  // Strip our custom `timeout` field before passing to fetch
  delete (fetchOptions as Record<string, unknown>)['timeout'];

  process.stderr.write(`[fly-runner] ${options?.method ?? 'GET'} ${url}\n`);

  const executeRequest = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      return response;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FlyAPIError(
        `Network error calling Fly API ${url}: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await executeRequest();

  // Retry once on 5xx
  if (response.status >= 500) {
    process.stderr.write(`[fly-runner] 5xx ${response.status} — retrying after ${RETRY_DELAY_MS}ms\n`);
    await delay(RETRY_DELAY_MS);
    response = await executeRequest();
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.text();
      if (body) {
        detail = `HTTP ${response.status}: ${body.slice(0, 500)}`;
      }
    } catch {
      // Ignore body read failure
    }
    throw new FlyAPIError(
      `Fly API error at ${url}: ${detail}`,
      response.status,
    );
  }

  return response;
}

// ============================================================================
// Internal: Utilities
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a safe machine name from scenarioId + timestamp.
 * Machine names must match [a-z0-9-] and be ≤ 63 chars.
 */
function buildMachineName(scenarioId?: string): string {
  const ts = Date.now().toString(36);
  if (scenarioId) {
    const safe = scenarioId.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
    return `pw-${safe}-${ts}`.slice(0, 63);
  }
  return `pw-${ts}`;
}

/**
 * Poll machine state until it reaches targetState or the timeout elapses.
 * Throws FlyAPIError if timeout is exceeded.
 */
async function waitForMachineState(
  config: FlyConfig,
  machineId: string,
  targetState: MachineState['state'],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await flyFetch(
      config,
      `/apps/${config.appName}/machines/${machineId}`,
    );
    const machine = await response.json() as FlyMachineResponse;
    process.stderr.write(`[fly-runner] machine ${machineId} state=${machine.state}\n`);

    if (machine.state === targetState) {
      return;
    }

    // Treat terminal states as immediate failures
    if (machine.state === 'destroying' || machine.state === 'destroyed') {
      throw new FlyAPIError(
        `Machine ${machineId} entered terminal state '${machine.state}' while waiting for '${targetState}'`,
        undefined,
        machineId,
      );
    }

    await delay(MACHINE_START_POLL_INTERVAL_MS);
  }

  throw new FlyAPIError(
    `Timeout waiting for machine ${machineId} to reach state '${targetState}' after ${timeoutMs}ms`,
    undefined,
    machineId,
  );
}

/**
 * Infer a RemoteArtifact type from a file path.
 */
function inferArtifactType(filePath: string): RemoteArtifact['type'] {
  const base = path.basename(filePath);
  if (base.endsWith('.zip') || base.includes('trace')) return 'trace';
  if (base.endsWith('.png') || base.endsWith('.jpg') || base.endsWith('.jpeg')) return 'screenshot';
  if (base.endsWith('.mp4') || base.endsWith('.webm')) return 'video';
  if (base.includes('report') || base.endsWith('.html')) return 'report';
  return 'log';
}

// ============================================================================
// Internal: resolveAppImage
// ============================================================================

/**
 * Resolve the current Docker image reference for a Fly app.
 *
 * Queries the OCI registry's tag list (FlyV1 auth) and picks the most recent
 * `deployment-*` tag. Falls back to `:latest` if the registry is unreachable.
 */
async function resolveAppImage(config: FlyConfig): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `https://registry.fly.io/v2/${config.appName}/tags/list`,
      {
        headers: { Authorization: `FlyV1 ${config.apiToken}` },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);

    if (resp.ok) {
      const data = (await resp.json()) as { tags?: string[] };
      if (data.tags && data.tags.length > 0) {
        // deployment- tags sort chronologically; pick the last (most recent)
        const deployTags = data.tags
          .filter((t: string) => t.startsWith('deployment-'))
          .sort();
        if (deployTags.length > 0) {
          const tag = deployTags[deployTags.length - 1];
          process.stderr.write(`[fly-runner] resolved image tag: ${tag}\n`);
          return `registry.fly.io/${config.appName}:${tag}`;
        }
        // No deployment- tags — use first available
        return `registry.fly.io/${config.appName}:${data.tags[0]}`;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] image resolution failed, falling back to :latest: ${msg}\n`);
  }

  return `registry.fly.io/${config.appName}:latest`;
}

// ============================================================================
// Exported: spawnRemoteMachine
// ============================================================================

/**
 * Create and start an ephemeral Fly machine for remote Playwright execution.
 *
 * Merges request fields into the machine env, POSTs to the Fly Machines API,
 * then polls until the machine reaches 'started' (timeout: 60s).
 *
 * @throws FlyAPIError on API failure or startup timeout
 */
export async function spawnRemoteMachine(
  config: FlyConfig,
  request: RemoteDemoRequest,
): Promise<RemoteDemoHandle> {
  // Build merged env — request.env provides pre-resolved secrets and demo vars.
  // Framework-level vars are layered on top so they cannot be overridden by
  // caller-supplied values (e.g. GIT_REMOTE must always reflect the request).
  const mergedEnv: Record<string, string> = {
    ...request.env,
    GIT_REMOTE: request.gitRemote,
    GIT_REF: request.gitRef,
    TEST_FILE: request.testFile,
    DEMO_HEADLESS: '1',
    DEMO_SLOW_MO: String(request.slowMo),
  };

  if (request.devServerCmd !== undefined) {
    mergedEnv['DEV_SERVER_CMD'] = request.devServerCmd;
  }
  if (request.devServerPort !== undefined) {
    mergedEnv['DEV_SERVER_PORT'] = String(request.devServerPort);
  }
  if (request.devServerHealthCheck !== undefined) {
    mergedEnv['DEV_SERVER_HEALTH_CHECK'] = request.devServerHealthCheck;
  }
  if (request.buildCmd !== undefined) {
    mergedEnv['WORKTREE_BUILD_CMD'] = request.buildCmd;
  }
  if (request.buildHealthCheck !== undefined) {
    mergedEnv['WORKTREE_BUILD_HEALTH_CHECK'] = request.buildHealthCheck;
  }
  // GIT_AUTH_TOKEN is passed through from pre-resolved env if present —
  // it is already in mergedEnv via the spread of request.env above.

  const machineName = buildMachineName(request.scenarioId);

  const mounts = config.volumeId
    ? [{ volume: config.volumeId, path: '/cache' }]
    : [];

  const body = {
    name: machineName,
    region: config.region,
    config: {
      image: await resolveAppImage(config),
      guest: {
        cpu_kind: 'shared',
        cpus: 2,
        memory_mb: config.machineRam,
      },
      env: mergedEnv,
      auto_destroy: true,
      restart: { policy: 'no' },
      mounts,
      stop_config: { timeout: '75s' },
    },
  };

  const createResponse = await flyFetch(
    config,
    `/apps/${config.appName}/machines`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );

  const machine = await createResponse.json() as FlyMachineResponse;
  process.stderr.write(`[fly-runner] created machine ${machine.id} (${machine.state})\n`);

  // Wait for machine to fully start
  await waitForMachineState(
    config,
    machine.id,
    'started',
    MACHINE_START_TIMEOUT_MS,
  );

  return {
    machineId: machine.id,
    appName: config.appName,
    region: config.region,
    startedAt: Date.now(),
    scenarioId: request.scenarioId,
  };
}

// ============================================================================
// Exported: pollRemoteProgress
// ============================================================================

/**
 * Read the progress JSONL file from a running machine.
 *
 * Executes `cat /app/.progress.jsonl` inside the machine, parses each line
 * as a JSON RemoteProgressEvent, and returns the array. Non-fatal — returns
 * an empty array if the machine has stopped or the file doesn't exist yet.
 */
export async function pollRemoteProgress(
  handle: RemoteDemoHandle,
  config: FlyConfig,
): Promise<RemoteProgressEvent[]> {
  let progressBuffer: Buffer;
  try {
    progressBuffer = await execInMachine(
      handle,
      config,
      ['cat', '/app/.progress.jsonl'],
    );
  } catch (err: unknown) {
    // File not yet written or machine stopped — non-fatal
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] pollRemoteProgress non-fatal error: ${message}\n`);
    return [];
  }

  const text = progressBuffer.toString('utf8');
  if (!text.trim()) {
    return [];
  }

  const events: RemoteProgressEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RemoteProgressEvent;
      events.push(parsed);
    } catch {
      process.stderr.write(`[fly-runner] skipping malformed progress line: ${trimmed.slice(0, 120)}\n`);
    }
  }

  return events;
}

// ============================================================================
// Exported: pollRemoteProgressRaw
// ============================================================================

/**
 * Read the raw JSONL text of the progress file from a running machine.
 *
 * Same as pollRemoteProgress but returns the raw UTF-8 string instead of
 * parsing events, so the caller can feed it to parseDemoProgressFromString
 * on the server side for structured DemoProgress extraction.
 *
 * Non-fatal — returns an empty string if the machine has stopped or the
 * file doesn't exist yet.
 */
export async function pollRemoteProgressRaw(
  handle: RemoteDemoHandle,
  config: FlyConfig,
): Promise<string> {
  let progressBuffer: Buffer;
  try {
    progressBuffer = await execInMachine(
      handle,
      config,
      ['cat', '/app/.progress.jsonl'],
    );
  } catch (err: unknown) {
    // File not yet written or machine stopped — non-fatal
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] pollRemoteProgressRaw non-fatal error: ${message}\n`);
    return '';
  }

  return progressBuffer.toString('utf8');
}

// ============================================================================
// Internal: execInMachine — run a command and return decoded stdout bytes
// ============================================================================

/**
 * Run a command inside a machine via the Fly exec API.
 *
 * The Fly Machines `/exec` endpoint returns a JSON envelope:
 *   { exit_code: number; stdout: string; stderr: string }
 * where `stdout` and `stderr` are base64-encoded.
 *
 * This function decodes `stdout` to a Buffer and throws FlyAPIError when the
 * command exits non-zero, so callers receive clean binary data or a clear error.
 *
 * @param timeoutMs - Command execution timeout in ms (default 30s). The HTTP
 *   request timeout is set to timeoutMs + 5s to give the API time to relay the
 *   result after the command finishes.
 * @throws FlyAPIError on non-zero exit code or API failure
 */
export async function execInMachine(
  handle: RemoteDemoHandle,
  config: FlyConfig,
  cmd: string[],
  timeoutMs: number = 30_000,
): Promise<Buffer> {
  const response = await flyFetch(
    config,
    `/apps/${handle.appName}/machines/${handle.machineId}/exec`,
    {
      method: 'POST',
      // Pass timeout to the Fly API so it kills the command server-side too
      body: JSON.stringify({ cmd, timeout: Math.ceil(timeoutMs / 1000) }),
      timeout: timeoutMs + 5_000,
    },
  );

  const result = await response.json() as FlyExecResponse;

  if (result.exit_code !== 0) {
    const stderrSnippet = result.stderr
      ? Buffer.from(result.stderr, 'base64').toString('utf8').slice(0, 500)
      : 'no stderr';
    throw new FlyAPIError(
      `Exec command failed (exit ${result.exit_code}): ${stderrSnippet}`,
      undefined,
      handle.machineId,
    );
  }

  // stdout from the exec API is base64-encoded binary data
  return Buffer.from(result.stdout ?? '', 'base64');
}

// ============================================================================
// Exported: pullRemoteArtifacts
// ============================================================================

/**
 * Download artifacts from a finished machine to a local directory.
 *
 * Steps:
 * 1. tar/gz the /app/.artifacts directory and extract it into destDir
 * 2. Pull individual log/metadata files: .stdout.log, .stderr.log, .exit-code,
 *    .progress.jsonl
 *
 * Non-fatal on individual file failures — pulls whatever it can.
 *
 * @throws FlyAPIError only if destDir cannot be created
 */
export async function pullRemoteArtifacts(
  handle: RemoteDemoHandle,
  config: FlyConfig,
  destDir: string,
): Promise<{ artifacts: RemoteArtifact[]; errors: string[] }> {
  await fsPromises.mkdir(destDir, { recursive: true });

  const artifacts: RemoteArtifact[] = [];
  const errors: string[] = [];

  // --- Step 1: Extract /app/.artifacts tarball ---
  let tarBuffer: Buffer | null = null;
  try {
    tarBuffer = await execInMachine(
      handle,
      config,
      ['tar', '-cz', '-C', '/app/.artifacts', '.'],
      60_000,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] artifact tar exec non-fatal error: ${message}\n`);
    errors.push(`tar exec failed: ${message}`);
  }

  if (tarBuffer && tarBuffer.length > 0) {
    const tempTar = path.join(os.tmpdir(), `fly-artifacts-${handle.machineId}-${Date.now()}.tar.gz`);
    try {
      await fsPromises.writeFile(tempTar, tarBuffer);
      // Extract using the system tar into destDir
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xz', '-C', destDir, '-f', tempTar], (err) => {
          if (err) {
            reject(new FlyAPIError(`tar extraction failed: ${err.message}`));
          } else {
            resolve();
          }
        });
      });

      // Walk destDir and register artifacts
      const walkDir = async (dir: string): Promise<void> => {
        let entries: fsSync.Dirent[];
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else {
            artifacts.push({
              localPath: fullPath,
              type: inferArtifactType(fullPath),
            });
          }
        }
      };
      await walkDir(destDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[fly-runner] artifact tar extraction non-fatal error: ${message}\n`);
      errors.push(`tar extraction failed: ${message}`);
    } finally {
      try {
        await fsPromises.unlink(tempTar);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // --- Step 2: Pull individual files ---
  const individualFiles: Array<{ remotePath: string; localName: string }> = [
    { remotePath: '/app/.stdout.log', localName: 'stdout.log' },
    { remotePath: '/app/.stderr.log', localName: 'stderr.log' },
    { remotePath: '/app/.exit-code', localName: 'exit-code' },
    { remotePath: '/app/.progress.jsonl', localName: 'progress.jsonl' },
    { remotePath: '/app/.recording.mp4', localName: 'recording.mp4' },
    { remotePath: '/app/.ffmpeg.log', localName: 'ffmpeg.log' },
  ];

  for (const { remotePath, localName } of individualFiles) {
    let fileBuffer: Buffer;
    try {
      fileBuffer = await execInMachine(handle, config, ['cat', remotePath]);
    } catch (err: unknown) {
      // File absent or command failed — non-fatal, skip this file
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[fly-runner] skipping ${remotePath}: ${message}\n`);
      errors.push(`${localName}: ${message}`);
      continue;
    }

    if (fileBuffer.length === 0) {
      continue;
    }

    const localPath = path.join(destDir, localName);
    try {
      await fsPromises.writeFile(localPath, fileBuffer);
      artifacts.push({
        localPath,
        type: inferArtifactType(localPath),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[fly-runner] failed to write ${localName}: ${message}\n`);
    }
  }

  process.stderr.write(`[fly-runner] pulled ${artifacts.length} artifacts to ${destDir} (${errors.length} error(s))\n`);
  return { artifacts, errors };
}

// ============================================================================
// Exported: stopRemoteMachine
// ============================================================================

/**
 * Gracefully stop and destroy a remote machine.
 *
 * Sends SIGTERM, waits up to 10s for 'stopped' state, then issues a DELETE.
 * Non-fatal — the machine may already be stopped or destroyed.
 */
export async function stopRemoteMachine(
  handle: RemoteDemoHandle,
  config: FlyConfig,
): Promise<void> {
  process.stderr.write(`[fly-runner] stopping machine ${handle.machineId}\n`);

  // Send SIGTERM stop request
  try {
    await flyFetch(
      config,
      `/apps/${handle.appName}/machines/${handle.machineId}/stop`,
      {
        method: 'POST',
        body: JSON.stringify({ signal: 'SIGTERM' }),
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] stop request non-fatal error: ${message}\n`);
    // Continue to attempt destroy even if stop request failed
  }

  // Wait for stopped state
  try {
    await waitForMachineState(
      config,
      handle.machineId,
      'stopped',
      MACHINE_STOP_WAIT_MS,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] wait-for-stopped non-fatal: ${message}\n`);
    // Continue to destroy regardless
  }

  // Destroy the machine
  try {
    await flyFetch(
      config,
      `/apps/${handle.appName}/machines/${handle.machineId}`,
      {
        method: 'DELETE',
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    process.stderr.write(`[fly-runner] machine ${handle.machineId} destroyed\n`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fly-runner] destroy non-fatal error: ${message}\n`);
  }
}

// ============================================================================
// Exported: isMachineAlive
// ============================================================================

/**
 * Check whether a machine is currently in the 'started' state.
 *
 * Returns false on any error (network, 404, etc.) — fail-safe for callers
 * that need to gate on machine liveness.
 */
export async function isMachineAlive(
  handle: RemoteDemoHandle,
  config: FlyConfig,
): Promise<boolean> {
  try {
    const response = await flyFetch(
      config,
      `/apps/${handle.appName}/machines/${handle.machineId}`,
      { timeout: DEFAULT_TIMEOUT_MS },
    );
    const machine = await response.json() as FlyMachineResponse;
    return machine.state === 'started';
  } catch {
    return false;
  }
}

// ============================================================================
// Exported: listActiveMachines
// ============================================================================

/**
 * List all currently active machines for the configured app.
 *
 * Returns only machines in 'created', 'starting', or 'started' state.
 *
 * @throws FlyAPIError on API failure
 */
export async function listActiveMachines(
  config: FlyConfig,
): Promise<MachineState[]> {
  const response = await flyFetch(
    config,
    `/apps/${config.appName}/machines`,
    { timeout: DEFAULT_TIMEOUT_MS },
  );

  const machines = await response.json() as FlyMachineResponse[];

  const activeStates = new Set<MachineState['state']>(['created', 'starting', 'started']);

  return machines
    .filter(m => activeStates.has(m.state))
    .map(m => ({
      id: m.id,
      state: m.state,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }));
}
