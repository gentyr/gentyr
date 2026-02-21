/**
 * Account Overview reader — reads per-account details and rotation events
 * from ~/.claude/api-key-rotation.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

function getKeyRotationStatePath(): string {
  return path.join(os.homedir(), '.claude', 'api-key-rotation.json');
}

// ============================================================================
// Public interfaces
// ============================================================================

export interface AccountKeyDetail {
  keyId: string;
  status: 'active' | 'exhausted' | 'invalid' | 'expired';
  isCurrent: boolean;
  subscriptionType: string;
  email: string | null;
  expiresAt: Date | null;
  addedAt: Date | null;
  lastUsedAt: Date | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  sevenDaySonnetPct: number | null;
}

export interface AccountEvent {
  timestamp: Date;
  event: string;
  keyId: string;
  description: string;
  usageSnapshot: { fiveHour: number; sevenDay: number } | null;
}

export interface AccountOverviewData {
  hasData: boolean;
  accounts: AccountKeyDetail[];
  activeKeyId: string | null;
  events: AccountEvent[];
  totalRotations24h: number;
}

// ============================================================================
// Zod schemas for the expanded key rotation state
// ============================================================================

const KeyUsageSchema = z.object({
  five_hour: z.number(),
  seven_day: z.number(),
  seven_day_sonnet: z.number().optional(),
  checked_at: z.number().optional(),
  resets_at: z.unknown().optional(),
}).nullable().optional();

const KeyDataSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
  added_at: z.number().optional(),
  last_used_at: z.number().nullable().optional(),
  last_health_check: z.number().nullable().optional(),
  last_usage: KeyUsageSchema,
  status: z.enum(['active', 'exhausted', 'invalid', 'expired']),
  account_uuid: z.string().nullable().optional(),
  account_email: z.string().nullable().optional(),
}).passthrough();

const RotationLogEntrySchema = z.object({
  timestamp: z.number(),
  event: z.string(),
  key_id: z.string().optional(),
  reason: z.string().optional(),
  usage_snapshot: z.object({
    five_hour: z.number(),
    seven_day: z.number(),
    seven_day_sonnet: z.number().optional(),
  }).optional(),
}).passthrough();

const KeyRotationFileSchema = z.object({
  version: z.number(),
  active_key_id: z.string().nullable(),
  keys: z.record(z.string(), KeyDataSchema),
  rotation_log: z.array(RotationLogEntrySchema),
}).passthrough();

// ============================================================================
// Helpers
// ============================================================================

function truncateKeyId(keyId: string): string {
  return keyId.length > 8 ? `${keyId.slice(0, 8)}...` : keyId;
}

function deriveDescription(event: string, reason: string | undefined, keyId: string, email?: string | null): string | null {
  const short = truncateKeyId(keyId);
  const displayName = email || short;

  switch (event) {
    case 'key_added':
      if (reason && reason.startsWith('token_refreshed'))
        return `Token refreshed for ${short}`;
      return `New account added: ${displayName}`;

    case 'key_switched': {
      const extra = reason ? ` (${reason})` : '';
      return `Switched to ${short}${extra}`;
    }

    case 'key_exhausted':
      return `Account ${short} exhausted`;

    case 'key_removed':
      if (reason === 'refresh_token_invalid_grant')
        return `Refresh token revoked for ${short}`;
      if (reason === 'token_expired' || reason === 'token_expired_refresh_failed')
        return `Token expired for ${short}`;
      if (reason && reason.startsWith('health_check_failed'))
        return `Health check failed for ${short}`;
      return `Key removed: ${short}`;

    case 'health_check':
      return null; // too noisy

    default:
      return `${event}: ${short}`;
  }
}

// ============================================================================
// Main reader
// ============================================================================

export function getAccountOverviewData(): AccountOverviewData {
  const empty: AccountOverviewData = {
    hasData: false,
    accounts: [],
    activeKeyId: null,
    events: [],
    totalRotations24h: 0,
  };

  const filePath = getKeyRotationStatePath();
  if (!fs.existsSync(filePath)) return empty;

  let state: z.infer<typeof KeyRotationFileSchema>;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    state = KeyRotationFileSchema.parse(JSON.parse(raw));
  } catch {
    return empty;
  }

  if (state.version !== 1) return empty;

  // Build accounts
  const accounts: AccountKeyDetail[] = [];
  for (const [keyId, keyData] of Object.entries(state.keys)) {
    accounts.push({
      keyId: truncateKeyId(keyId),
      status: keyData.status,
      isCurrent: keyId === state.active_key_id,
      subscriptionType: keyData.subscriptionType ?? 'unknown',
      email: keyData.account_email ?? null,
      expiresAt: keyData.expiresAt ? new Date(keyData.expiresAt) : null,
      addedAt: keyData.added_at ? new Date(keyData.added_at) : null,
      lastUsedAt: keyData.last_used_at ? new Date(keyData.last_used_at) : null,
      fiveHourPct: keyData.last_usage?.five_hour ?? null,
      sevenDayPct: keyData.last_usage?.seven_day ?? null,
      sevenDaySonnetPct: keyData.last_usage?.seven_day_sonnet ?? null,
    });
  }

  // Sort: current first, then active, then by addedAt desc
  accounts.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const statusOrder = { active: 0, exhausted: 1, expired: 2, invalid: 3 };
    if (a.status !== b.status) return statusOrder[a.status] - statusOrder[b.status];
    return (b.addedAt?.getTime() ?? 0) - (a.addedAt?.getTime() ?? 0);
  });

  // Build events from rotation_log (last 24h, filter health_check, cap 20)
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  let rotationCount = 0;

  // Build a set of emails seen across all keys to detect genuinely new accounts
  const allEmails = new Set<string>();
  for (const keyData of Object.values(state.keys)) {
    if (keyData.account_email) allEmails.add(keyData.account_email);
  }

  // Track emails we've already seen a "New account added" event for
  // (scan chronologically to suppress duplicate additions for the same email)
  const seenAddedEmails = new Set<string>();

  const events: AccountEvent[] = [];
  for (const entry of state.rotation_log) {
    if (entry.timestamp < cutoff24h) continue;
    if (entry.event === 'key_switched') rotationCount++;

    const keyId = entry.key_id ?? 'unknown';
    const email = keyId !== 'unknown' ? state.keys[keyId]?.account_email ?? null : null;
    const desc = deriveDescription(entry.event, entry.reason, keyId, email);
    if (!desc) continue;

    // Suppress duplicate "New account added" events for the same email
    if (entry.event === 'key_added' && !(entry.reason && entry.reason.startsWith('token_refreshed'))) {
      const dedupeKey = email ?? keyId;
      if (seenAddedEmails.has(dedupeKey)) continue;
      seenAddedEmails.add(dedupeKey);
    }

    events.push({
      timestamp: new Date(entry.timestamp),
      event: entry.event,
      keyId: truncateKeyId(keyId),
      description: desc,
      usageSnapshot: entry.usage_snapshot
        ? { fiveHour: entry.usage_snapshot.five_hour, sevenDay: entry.usage_snapshot.seven_day }
        : null,
    });
  }

  // Sort newest first, cap at 20
  events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const cappedEvents = events.slice(0, 20);

  const activeKeyId = state.active_key_id ? truncateKeyId(state.active_key_id) : null;

  return {
    hasData: accounts.length > 0,
    accounts,
    activeKeyId,
    events: cappedEvents,
    totalRotations24h: rotationCount,
  };
}
