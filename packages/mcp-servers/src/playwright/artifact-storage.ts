/**
 * Tigris Object Storage Integration for Remote Demo Artifacts
 *
 * Uses Tigris (Fly.io's S3-compatible storage) to reliably transfer binary
 * artifacts (MP4 recordings, Playwright traces, .webm videos) from ephemeral
 * Fly.io demo machines. The Fly exec API returns stdout as UTF-8 text, which
 * corrupts binary data. Tigris presigned URLs let the machine upload via `curl`
 * and the MCP server download via the S3 SDK — zero Docker image changes needed.
 *
 * Credential resolution:
 *   1. services.json `fly.tigris*` fields (op:// refs resolved at runtime)
 *   2. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *      AWS_ENDPOINT_URL_S3, BUCKET_NAME
 *
 * Key format: `demos/{runId}/{filename}`
 * Presigned URL expiry: 1 hour
 *
 * All functions are non-fatal — callers fall back to the exec-based artifact
 * pull when Tigris is unavailable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ============================================================================
// Types
// ============================================================================

export interface TigrisConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

export interface ArtifactUploadUrls {
  /** Map of filename -> presigned PUT URL */
  urls: Record<string, string>;
  /** The bucket name (for logging) */
  bucket: string;
  /** The key prefix (e.g., "demos/dr-xxx-123-abc") */
  keyPrefix: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Presigned URL expiry in seconds (1 hour) */
const PRESIGN_EXPIRY_SECONDS = 3600;

/** Standard artifact filenames expected from remote demos */
const STANDARD_ARTIFACTS = [
  'recording.mp4',
  'trace.zip',
  'stdout.log',
  'stderr.log',
  'exit-code',
  'progress.jsonl',
  'ffmpeg.log',
  'error.log',
  'devserver.log',
];

/** Content-Type mapping for artifact filenames */
const CONTENT_TYPE_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.log': 'text/plain',
  '.jsonl': 'application/x-ndjson',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.html': 'text/html',
};

// ============================================================================
// Internal: S3 client creation
// ============================================================================

function createS3Client(config: TigrisConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
}

// ============================================================================
// Exported: isTigrisConfigured
// ============================================================================

export function isTigrisConfigured(servicesJsonPath?: string): boolean {
  if (servicesJsonPath) {
    try {
      if (fs.existsSync(servicesJsonPath)) {
        const raw = JSON.parse(fs.readFileSync(servicesJsonPath, 'utf-8'));
        const fly = raw?.fly;
        if (fly?.tigrisBucket && fly?.tigrisAccessKey && fly?.tigrisSecretKey && fly?.tigrisEndpoint) {
          return true;
        }
      }
    } catch { /* fall through */ }
  }
  return !!(process.env.BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ENDPOINT_URL_S3);
}

// ============================================================================
// Exported: resolveTigrisConfig
// ============================================================================

export function resolveTigrisConfig(
  resolveOpRef: (ref: string) => string,
  servicesJsonPath?: string,
): TigrisConfig | null {
  if (servicesJsonPath) {
    try {
      if (fs.existsSync(servicesJsonPath)) {
        const raw = JSON.parse(fs.readFileSync(servicesJsonPath, 'utf-8'));
        const fly = raw?.fly;
        if (fly?.tigrisBucket && fly?.tigrisAccessKey && fly?.tigrisSecretKey && fly?.tigrisEndpoint) {
          const bucket = fly.tigrisBucket;
          const endpoint = typeof fly.tigrisEndpoint === 'string' && fly.tigrisEndpoint.startsWith('op://')
            ? resolveOpRef(fly.tigrisEndpoint) : fly.tigrisEndpoint;
          const accessKeyId = typeof fly.tigrisAccessKey === 'string' && fly.tigrisAccessKey.startsWith('op://')
            ? resolveOpRef(fly.tigrisAccessKey) : fly.tigrisAccessKey;
          const secretAccessKey = typeof fly.tigrisSecretKey === 'string' && fly.tigrisSecretKey.startsWith('op://')
            ? resolveOpRef(fly.tigrisSecretKey) : fly.tigrisSecretKey;
          return { bucket, accessKeyId, secretAccessKey, endpoint };
        }
      }
    } catch (err) {
      process.stderr.write(`[artifact-storage] Failed to resolve Tigris config: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (process.env.BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ENDPOINT_URL_S3) {
    return {
      bucket: process.env.BUCKET_NAME,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
    };
  }
  return null;
}

// ============================================================================
// Exported: generatePresignedUploadUrl
// ============================================================================

export async function generatePresignedUploadUrl(
  config: TigrisConfig, runId: string, filename: string,
): Promise<string> {
  const client = createS3Client(config);
  const key = `demos/${runId}/${filename}`;
  const command = new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: getContentType(filename) });
  const url = await getSignedUrl(client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
  client.destroy();
  return url;
}

// ============================================================================
// Exported: generateArtifactUploadUrls
// ============================================================================

export async function generateArtifactUploadUrls(
  config: TigrisConfig, runId: string,
): Promise<ArtifactUploadUrls> {
  const client = createS3Client(config);
  const keyPrefix = `demos/${runId}`;
  const urls: Record<string, string> = {};
  try {
    for (const filename of STANDARD_ARTIFACTS) {
      const key = `${keyPrefix}/${filename}`;
      const command = new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: getContentType(filename) });
      urls[filename] = await getSignedUrl(client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
    }
  } finally { client.destroy(); }
  return { urls, bucket: config.bucket, keyPrefix };
}

// ============================================================================
// Exported: downloadArtifact
// ============================================================================

export async function downloadArtifact(
  config: TigrisConfig, runId: string, filename: string, destPath: string,
): Promise<boolean> {
  const client = createS3Client(config);
  const key = `demos/${runId}/${filename}`;
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    if (!response.Body) { process.stderr.write(`[artifact-storage] Empty body for ${key}\n`); return false; }
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const bodyStream = response.Body as Readable;
    const fileStream = fs.createWriteStream(destPath);
    await pipeline(bodyStream, fileStream);
    const stat = fs.statSync(destPath);
    process.stderr.write(`[artifact-storage] Downloaded ${key} -> ${destPath} (${stat.size} bytes)\n`);
    return stat.size > 0;
  } catch (err) {
    process.stderr.write(`[artifact-storage] Failed to download ${key}: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally { client.destroy(); }
}

// ============================================================================
// Exported: listRunArtifacts
// ============================================================================

export async function listRunArtifacts(
  config: TigrisConfig, runId: string,
): Promise<string[]> {
  const client = createS3Client(config);
  const prefix = `demos/${runId}/`;
  try {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }));
    if (!response.Contents) return [];
    return response.Contents.map(obj => obj.Key?.replace(prefix, '') ?? '').filter(name => name.length > 0);
  } catch (err) {
    process.stderr.write(`[artifact-storage] Failed to list artifacts for ${runId}: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  } finally { client.destroy(); }
}

// ============================================================================
// Exported: deleteRunArtifacts
// ============================================================================

export async function deleteRunArtifacts(
  config: TigrisConfig, runId: string,
): Promise<void> {
  const client = createS3Client(config);
  const prefix = `demos/${runId}/`;
  try {
    const listResponse = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }));
    if (!listResponse.Contents || listResponse.Contents.length === 0) return;
    const objectsToDelete = listResponse.Contents.filter(obj => obj.Key).map(obj => ({ Key: obj.Key! }));
    if (objectsToDelete.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objectsToDelete } }));
      process.stderr.write(`[artifact-storage] Deleted ${objectsToDelete.length} artifacts for run ${runId}\n`);
    }
  } catch (err) {
    process.stderr.write(`[artifact-storage] Failed to delete artifacts for ${runId}: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally { client.destroy(); }
}

// ============================================================================
// Exported: downloadAllRunArtifacts
// ============================================================================

export async function downloadAllRunArtifacts(
  config: TigrisConfig, runId: string, destDir: string,
): Promise<string[]> {
  const filenames = await listRunArtifacts(config, runId);
  if (filenames.length === 0) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const downloaded: string[] = [];
  for (const filename of filenames) {
    const destPath = path.join(destDir, filename);
    const ok = await downloadArtifact(config, runId, filename, destPath);
    if (ok) downloaded.push(filename);
  }
  process.stderr.write(`[artifact-storage] Downloaded ${downloaded.length}/${filenames.length} artifacts for ${runId} to ${destDir}\n`);
  return downloaded;
}
