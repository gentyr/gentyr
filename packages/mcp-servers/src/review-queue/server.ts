#!/usr/bin/env node
/**
 * Review Queue MCP Server
 *
 * Provides a non-blocking review queue for schema mappings that require
 * human oversight. Items are queued but never block - the user can
 * check and act on them at their convenience.
 *
 * @see specs/global/G018-schema-mapping.md
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListPendingReviewsArgsSchema,
  GetReviewDetailsArgsSchema,
  ApproveReviewArgsSchema,
  RejectReviewArgsSchema,
  GetReviewStatsArgsSchema,
  REVIEW_REASONS,
  REVIEW_STATUS,
  type ListPendingReviewsArgs,
  type GetReviewDetailsArgs,
  type ApproveReviewArgs,
  type RejectReviewArgs,
  type ListPendingReviewsResult,
  type GetReviewDetailsResult,
  type ApproveReviewResult,
  type RejectReviewResult,
  type ReviewStats,
  type ReviewQueue,
  type ReviewItem,
  type ListReviewItem,
  type AddToQueueItem,
  type ErrorResult,
  type ReviewReason,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const QUEUE_FILE = path.join(PROJECT_DIR, '.claude', 'hooks', 'review-queue.json');
const MAX_QUEUE_SIZE = 100;

// ============================================================================
// Queue Management
// ============================================================================

/**
 * Read the review queue from disk
 * @throws {Error} If file exists but is corrupted (G001 compliance)
 */
function readQueue(): ReviewQueue {
  // File doesn't exist - use default (OK per G001)
  if (!fs.existsSync(QUEUE_FILE)) {
    return { items: [], stats: { totalAdded: 0, totalApproved: 0, totalRejected: 0 } };
  }

  // File exists - must read successfully or throw (G001: no silent corruption)
  try {
    const content = fs.readFileSync(QUEUE_FILE, 'utf8');
    return JSON.parse(content) as ReviewQueue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[review-queue] Queue file corrupted at ${QUEUE_FILE}: ${message}. Delete file to reset.`);
  }
}

/**
 * Write the review queue to disk
 */
function writeQueue(queue: ReviewQueue): void {
  try {
    const dir = path.dirname(QUEUE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[review-queue] Failed to write queue: ${message}\n`);
  }
}

/**
 * Generate unique review ID
 */
function generateReviewId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `review-${timestamp}-${random}`;
}

/**
 * Get human-readable reason description
 */
function getReasonDescription(reason: ReviewReason, item: AddToQueueItem): string {
  switch (reason) {
    case REVIEW_REASONS.FIRST_PLATFORM_MAPPING:
      return `First mapping for platform "${item.platform}" - security review required`;
    case REVIEW_REASONS.LOW_CONFIDENCE:
      return `Mapping confidence ${((item.confidence ?? 0) * 100).toFixed(0)}% is below 70% threshold`;
    case REVIEW_REASONS.SENSITIVE_FIELDS:
      return `Sensitive fields detected: ${(item.sensitiveFields ?? []).join(', ')}`;
    case REVIEW_REASONS.SCHEMA_CHANGE:
      return `Schema change detected from previous fingerprint`;
    case REVIEW_REASONS.MANUAL_REQUEST:
      return `Manual review requested`;
    default:
      return reason;
  }
}

/**
 * Get human-readable age string
 */
function getAge(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {return `${days}d ago`;}
  if (hours > 0) {return `${hours}h ago`;}
  if (minutes > 0) {return `${minutes}m ago`;}
  return 'just now';
}

/**
 * Add item to review queue (exported for use by registry or hook)
 */
export function addToQueue(item: AddToQueueItem): string {
  const queue = readQueue();

  const reviewItem: ReviewItem = {
    id: generateReviewId(),
    status: REVIEW_STATUS.PENDING,
    reason: item.reason,
    reasonDescription: getReasonDescription(item.reason, item),
    platform: item.platform,
    entity: item.entity,
    schemaFingerprint: item.fingerprint,
    confidence: item.confidence,
    sensitiveFields: item.sensitiveFields ?? [],
    mappingPath: item.mappingPath ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: item.metadata ?? {},
  };

  // Add to beginning of queue
  queue.items.unshift(reviewItem);
  queue.stats.totalAdded = (queue.stats.totalAdded || 0) + 1;

  // Enforce max queue size (remove oldest resolved items)
  while (queue.items.length > MAX_QUEUE_SIZE) {
    const resolvedIndex = queue.items.findIndex(i =>
      i.status === REVIEW_STATUS.APPROVED ||
      i.status === REVIEW_STATUS.REJECTED ||
      i.status === REVIEW_STATUS.EXPIRED
    );
    if (resolvedIndex >= 0) {
      queue.items.splice(resolvedIndex, 1);
    } else {
      // Remove oldest pending if no resolved items
      queue.items.pop();
    }
  }

  writeQueue(queue);
  return reviewItem.id;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all pending reviews
 */
function listPendingReviews(args: ListPendingReviewsArgs): ListPendingReviewsResult {
  const queue = readQueue();
  let {items} = queue;

  // Filter by status (default: pending only)
  const status = args.status ?? REVIEW_STATUS.PENDING;
  if (status !== 'all') {
    items = items.filter(i => i.status === status);
  }

  // Filter by platform
  if (args.platform) {
    items = items.filter(i => i.platform === args.platform);
  }

  // Filter by reason
  if (args.reason) {
    items = items.filter(i => i.reason === args.reason);
  }

  // Apply limit
  const limit = args.limit ?? 20;
  items = items.slice(0, limit);

  // Format for display
  const formatted: ListReviewItem[] = items.map(item => ({
    id: item.id,
    status: item.status,
    platform: item.platform,
    entity: item.entity,
    reason: item.reason,
    reasonDescription: item.reasonDescription,
    confidence: item.confidence !== null ? `${(item.confidence * 100).toFixed(0)}%` : 'N/A',
    sensitiveFieldCount: item.sensitiveFields?.length ?? 0,
    createdAt: item.createdAt,
    age: getAge(item.createdAt),
  }));

  return {
    total: formatted.length,
    pendingCount: queue.items.filter(i => i.status === REVIEW_STATUS.PENDING).length,
    items: formatted,
    availableReasons: Object.values(REVIEW_REASONS),
  };
}

/**
 * Get full details of a review item
 */
function getReviewDetails(args: GetReviewDetailsArgs): GetReviewDetailsResult | ErrorResult {
  const queue = readQueue();
  const item = queue.items.find(i => i.id === args.reviewId);

  if (!item) {
    return { error: `Review not found: ${args.reviewId}` };
  }

  // Try to read the mapping file for more context
  let mappingContent: unknown = null;
  let mappingReadError: string | null = null;

  if (item.mappingPath) {
    if (!fs.existsSync(item.mappingPath)) {
      mappingReadError = `Mapping file not found: ${item.mappingPath}`;
    } else {
      try {
        mappingContent = JSON.parse(fs.readFileSync(item.mappingPath, 'utf8'));
      } catch (err) {
        // G001: Report read errors instead of silent ignore
        const message = err instanceof Error ? err.message : String(err);
        mappingReadError = `Failed to read mapping file: ${message}`;
      }
    }
  }

  return {
    ...item,
    mapping: mappingContent,
    mappingReadError,
    actions: item.status === REVIEW_STATUS.PENDING ? ['approve', 'reject'] : [],
  };
}

/**
 * Approve a review
 */
function approveReview(args: ApproveReviewArgs): ApproveReviewResult | ErrorResult {
  const queue = readQueue();
  const item = queue.items.find(i => i.id === args.reviewId);

  if (!item) {
    return { error: `Review not found: ${args.reviewId}` };
  }

  if (item.status !== REVIEW_STATUS.PENDING) {
    return { error: `Review already resolved: ${item.status}` };
  }

  item.status = REVIEW_STATUS.APPROVED;
  item.updatedAt = new Date().toISOString();
  item.approvedBy = args.approver ?? 'user';
  item.approvalNote = args.note ?? null;

  queue.stats.totalApproved = (queue.stats.totalApproved || 0) + 1;

  writeQueue(queue);

  return {
    success: true,
    reviewId: args.reviewId,
    status: REVIEW_STATUS.APPROVED,
    message: `Mapping ${item.platform}:${item.entity} approved`,
  };
}

/**
 * Reject a review
 */
function rejectReview(args: RejectReviewArgs): RejectReviewResult | ErrorResult {
  const queue = readQueue();
  const item = queue.items.find(i => i.id === args.reviewId);

  if (!item) {
    return { error: `Review not found: ${args.reviewId}` };
  }

  if (item.status !== REVIEW_STATUS.PENDING) {
    return { error: `Review already resolved: ${item.status}` };
  }

  item.status = REVIEW_STATUS.REJECTED;
  item.updatedAt = new Date().toISOString();
  item.rejectedBy = args.rejector ?? 'user';
  item.rejectionReason = args.reason;

  queue.stats.totalRejected = (queue.stats.totalRejected || 0) + 1;

  writeQueue(queue);

  return {
    success: true,
    reviewId: args.reviewId,
    status: REVIEW_STATUS.REJECTED,
    message: `Mapping ${item.platform}:${item.entity} rejected: ${args.reason}`,
  };
}

/**
 * Get queue statistics
 */
function getReviewStats(): ReviewStats {
  const queue = readQueue();
  const {items} = queue;

  const stats: ReviewStats = {
    total: items.length,
    byStatus: {},
    byReason: {},
    byPlatform: {},
    oldestPending: null,
    totalAdded: queue.stats.totalAdded ?? 0,
    totalApproved: queue.stats.totalApproved ?? 0,
    totalRejected: queue.stats.totalRejected ?? 0,
  };

  for (const item of items) {
    // Count by status
    stats.byStatus[item.status] = (stats.byStatus[item.status] || 0) + 1;

    // Count by reason
    stats.byReason[item.reason] = (stats.byReason[item.reason] || 0) + 1;

    // Count by platform
    stats.byPlatform[item.platform] = (stats.byPlatform[item.platform] || 0) + 1;

    // Track oldest pending
    if (item.status === REVIEW_STATUS.PENDING) {
      if (!stats.oldestPending || new Date(item.createdAt) < new Date(stats.oldestPending)) {
        stats.oldestPending = item.createdAt;
      }
    }
  }

  return stats;
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'list_pending_reviews',
    description: 'List schema mapping reviews awaiting human oversight. Non-blocking queue for security/quality reviews.',
    schema: ListPendingReviewsArgsSchema,
    handler: listPendingReviews,
  },
  {
    name: 'get_review_details',
    description: 'Get full details of a review item including the mapping content and field mappings',
    schema: GetReviewDetailsArgsSchema,
    handler: getReviewDetails,
  },
  {
    name: 'approve_review',
    description: 'Approve a pending mapping review. Marks the mapping as safe to use.',
    schema: ApproveReviewArgsSchema,
    handler: approveReview,
  },
  {
    name: 'reject_review',
    description: 'Reject a pending mapping review. The mapping should not be used.',
    schema: RejectReviewArgsSchema,
    handler: rejectReview,
  },
  {
    name: 'get_review_stats',
    description: 'Get statistics about the review queue: counts by status, reason, platform',
    schema: GetReviewStatsArgsSchema,
    handler: getReviewStats,
  },
];

const server = new McpServer({
  name: 'review-queue',
  version: '2.0.0',
  tools,
});

server.start();
