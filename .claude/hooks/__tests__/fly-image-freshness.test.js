/**
 * Tests for fly-image-freshness.js
 *
 * These tests validate:
 * 1. computeInfraHashes() - SHA-256 hash computation for infra files
 * 2. resolveInfraDir() - Infra directory resolution in both install contexts
 * 3. readImageMetadata() - Metadata file reading
 * 4. checkImageStaleness() - Full staleness check combining all above
 *
 * Uses vitest
 * Run with: vitest run .claude/hooks/__tests__/fly-image-freshness.test.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the module under test — works from both worktree and main repo
const MODULE_PATH = path.resolve(__dirname, '../lib/fly-image-freshness.js');

const {
  computeInfraHashes,
  resolveInfraDir,
  readImageMetadata,
  checkImageStaleness,
} = await import(MODULE_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp directory with the three required infra files.
 * Returns the path to the infra dir.
 */
function createFakeInfraDir(baseDir, opts = {}) {
  const infraDir = path.join(baseDir, 'infra', 'fly-playwright');
  fs.mkdirSync(infraDir, { recursive: true });
  fs.writeFileSync(path.join(infraDir, 'Dockerfile'), opts.dockerfileContent ?? 'FROM node:20\n');
  fs.writeFileSync(path.join(infraDir, 'remote-runner.sh'), opts.remoteRunnerContent ?? '#!/bin/bash\necho hello\n');
  fs.writeFileSync(path.join(infraDir, 'fly.toml.template'), opts.flyTomlContent ?? 'app = "test"\n');
  return infraDir;
}

/**
 * SHA-256 hash of a string (same algorithm as the module).
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// computeInfraHashes
// ---------------------------------------------------------------------------

describe('computeInfraHashes()', () => {
  it('returns correct SHA-256 hashes for actual infra files', () => {
    // Resolve the actual infra directory from the gentyr repo root.
    // The module resolves two candidates; the local repo path is the second one
    // (node_modules/gentyr path is the first).  Use the repo root directly.
    const repoRoot = path.resolve(__dirname, '../../../../');
    const infraDir = path.join(repoRoot, 'infra', 'fly-playwright');

    // Ensure the infra directory exists before running this test.
    if (!fs.existsSync(infraDir)) {
      // Skip gracefully if the infra dir is missing in this environment.
      return;
    }

    const result = computeInfraHashes(infraDir);

    // Validate structure — all three hashes must be 64-char hex strings.
    expect(typeof result.dockerfileHash).toBe('string');
    expect(result.dockerfileHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.dockerfileHash)).toBe(true);

    expect(typeof result.remoteRunnerHash).toBe('string');
    expect(result.remoteRunnerHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.remoteRunnerHash)).toBe(true);

    expect(typeof result.flyTomlTemplateHash).toBe('string');
    expect(result.flyTomlTemplateHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.flyTomlTemplateHash)).toBe(true);

    // Validate correctness — each hash must match independent computation.
    const expectedDockerfile = sha256(fs.readFileSync(path.join(infraDir, 'Dockerfile')));
    const expectedRemoteRunner = sha256(fs.readFileSync(path.join(infraDir, 'remote-runner.sh')));
    const expectedFlyToml = sha256(fs.readFileSync(path.join(infraDir, 'fly.toml.template')));

    expect(result.dockerfileHash).toBe(expectedDockerfile);
    expect(result.remoteRunnerHash).toBe(expectedRemoteRunner);
    expect(result.flyTomlTemplateHash).toBe(expectedFlyToml);
  });
});

// ---------------------------------------------------------------------------
// resolveInfraDir
// ---------------------------------------------------------------------------

describe('resolveInfraDir()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-freshness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the infra dir when it exists at node_modules/gentyr/infra/fly-playwright (npm link context)', () => {
    // Create the npm-link candidate path
    const infraDir = path.join(tmpDir, 'node_modules', 'gentyr', 'infra', 'fly-playwright');
    fs.mkdirSync(infraDir, { recursive: true });

    const result = resolveInfraDir(tmpDir);

    expect(result).toBe(infraDir);
  });

  it('finds the infra dir when it exists at infra/fly-playwright (local repo context)', () => {
    // Create only the local repo candidate (no node_modules/gentyr)
    const infraDir = path.join(tmpDir, 'infra', 'fly-playwright');
    fs.mkdirSync(infraDir, { recursive: true });

    const result = resolveInfraDir(tmpDir);

    expect(result).toBe(infraDir);
  });

  it('returns null when neither candidate directory exists', () => {
    // tmpDir is empty — no infra dirs created
    const result = resolveInfraDir(tmpDir);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readImageMetadata
// ---------------------------------------------------------------------------

describe('readImageMetadata()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-freshness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the metadata file does not exist', () => {
    // tmpDir has no .claude/state/fly-image-metadata.json
    const result = readImageMetadata(tmpDir);

    expect(result).toBeNull();
  });

  it('returns parsed JSON when the metadata file exists', () => {
    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const meta = {
      dockerfileHash: 'abc123',
      remoteRunnerHash: 'def456',
      flyTomlTemplateHash: 'ghi789',
      deployedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(stateDir, 'fly-image-metadata.json'),
      JSON.stringify(meta),
    );

    const result = readImageMetadata(tmpDir);

    expect(result).not.toBeNull();
    expect(result).toEqual(meta);
    expect(result.dockerfileHash).toBe('abc123');
    expect(result.remoteRunnerHash).toBe('def456');
    expect(result.flyTomlTemplateHash).toBe('ghi789');
    expect(result.deployedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// checkImageStaleness
// ---------------------------------------------------------------------------

describe('checkImageStaleness()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-freshness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns { hasMeta: false, stale: null } when no metadata file exists', () => {
    // No .claude/state/fly-image-metadata.json, no infra dir
    const result = checkImageStaleness(tmpDir);

    expect(result.hasMeta).toBe(false);
    expect(result.stale).toBeNull();
  });

  it('returns { stale: false } when all hashes match (fresh image)', () => {
    // Create infra dir with known content
    const infraDir = createFakeInfraDir(tmpDir);

    // Compute the current hashes so we can record them as the "deployed" hashes
    const hashes = computeInfraHashes(infraDir);

    // Write metadata with matching hashes
    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'fly-image-metadata.json'),
      JSON.stringify({
        ...hashes,
        deployedAt: new Date().toISOString(),
      }),
    );

    const result = checkImageStaleness(tmpDir);

    expect(result.hasMeta).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.changedFiles.dockerfile).toBe(false);
    expect(result.changedFiles.remoteRunner).toBe(false);
    expect(result.changedFiles.flyTomlTemplate).toBe(false);
  });

  it('returns { stale: true } when Dockerfile or remote-runner.sh hashes differ', () => {
    // Create infra dir
    const infraDir = createFakeInfraDir(tmpDir);
    const hashes = computeInfraHashes(infraDir);

    // Write metadata with a stale Dockerfile hash (simulate rebuild)
    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'fly-image-metadata.json'),
      JSON.stringify({
        dockerfileHash: 'stale_hash_that_does_not_match',
        remoteRunnerHash: hashes.remoteRunnerHash,
        flyTomlTemplateHash: hashes.flyTomlTemplateHash,
        deployedAt: new Date().toISOString(),
      }),
    );

    const result = checkImageStaleness(tmpDir);

    expect(result.hasMeta).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.changedFiles.dockerfile).toBe(true);
    expect(result.changedFiles.remoteRunner).toBe(false);
  });

  it('computes ageHours correctly based on deployedAt timestamp', () => {
    // Create infra dir with matching hashes so staleness is false
    const infraDir = createFakeInfraDir(tmpDir);
    const hashes = computeInfraHashes(infraDir);

    // Deploy time: exactly 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);

    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'fly-image-metadata.json'),
      JSON.stringify({
        ...hashes,
        deployedAt: threeHoursAgo.toISOString(),
      }),
    );

    const result = checkImageStaleness(tmpDir);

    expect(result.hasMeta).toBe(true);
    expect(typeof result.ageHours).toBe('number');
    expect(result.ageHours).not.toBeNaN();
    // Allow ±1 hour tolerance for timing jitter in CI
    expect(result.ageHours).toBeGreaterThanOrEqual(2);
    expect(result.ageHours).toBeLessThanOrEqual(4);
  });
});
