/**
 * Types for the Review Queue MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const REVIEW_REASONS = {
  FIRST_PLATFORM_MAPPING: 'first-platform-mapping',
  LOW_CONFIDENCE: 'low-confidence',
  SENSITIVE_FIELDS: 'sensitive-fields',
  SCHEMA_CHANGE: 'schema-change',
  MANUAL_REQUEST: 'manual-request',
} as const;

export type ReviewReason = typeof REVIEW_REASONS[keyof typeof REVIEW_REASONS];

export const REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;

export type ReviewStatus = typeof REVIEW_STATUS[keyof typeof REVIEW_STATUS];

export const REVIEW_REASON_VALUES = Object.values(REVIEW_REASONS) as [string, ...string[]];
export const REVIEW_STATUS_VALUES = Object.values(REVIEW_STATUS) as [string, ...string[]];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const ListPendingReviewsArgsSchema = z.object({
  status: z.enum([...REVIEW_STATUS_VALUES, 'all'])
    .optional()
    .default('pending')
    .describe('Filter by status: pending, approved, rejected, expired, or "all"'),
  platform: z.string()
    .optional()
    .describe('Filter by platform (e.g., "azure", "aws")'),
  reason: z.enum(REVIEW_REASON_VALUES)
    .optional()
    .describe('Filter by review reason'),
  limit: z.number()
    .optional()
    .default(20)
    .describe('Maximum items to return'),
});

export const GetReviewDetailsArgsSchema = z.object({
  reviewId: z.string().describe('The review ID from list_pending_reviews'),
});

export const ApproveReviewArgsSchema = z.object({
  reviewId: z.string().describe('The review ID to approve'),
  approver: z.string().optional().describe('Name/identifier of approver'),
  note: z.string().optional().describe('Optional approval note'),
});

export const RejectReviewArgsSchema = z.object({
  reviewId: z.string().describe('The review ID to reject'),
  reason: z.string().describe('Reason for rejection (required)'),
  rejector: z.string().optional().describe('Name/identifier of rejector'),
});

export const GetReviewStatsArgsSchema = z.object({});

// ============================================================================
// Type Definitions
// ============================================================================

export type ListPendingReviewsArgs = z.infer<typeof ListPendingReviewsArgsSchema>;
export type GetReviewDetailsArgs = z.infer<typeof GetReviewDetailsArgsSchema>;
export type ApproveReviewArgs = z.infer<typeof ApproveReviewArgsSchema>;
export type RejectReviewArgs = z.infer<typeof RejectReviewArgsSchema>;
export type GetReviewStatsArgs = z.infer<typeof GetReviewStatsArgsSchema>;

export interface ReviewItem {
  id: string;
  status: ReviewStatus;
  reason: ReviewReason;
  reasonDescription: string;
  platform: string;
  entity: string;
  schemaFingerprint: string;
  confidence: number | null;
  sensitiveFields: string[];
  mappingPath: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  approvedBy?: string;
  approvalNote?: string | null;
  rejectedBy?: string;
  rejectionReason?: string;
}

export interface ReviewQueue {
  items: ReviewItem[];
  stats: {
    totalAdded: number;
    totalApproved: number;
    totalRejected: number;
  };
}

export interface ListReviewItem {
  id: string;
  status: ReviewStatus;
  platform: string;
  entity: string;
  reason: ReviewReason;
  reasonDescription: string;
  confidence: string;
  sensitiveFieldCount: number;
  createdAt: string;
  age: string;
}

export interface ListPendingReviewsResult {
  total: number;
  pendingCount: number;
  items: ListReviewItem[];
  availableReasons: ReviewReason[];
}

export interface GetReviewDetailsResult extends ReviewItem {
  mapping: unknown;
  mappingReadError: string | null;
  actions: string[];
}

export interface ApproveReviewResult {
  success: boolean;
  reviewId: string;
  status: ReviewStatus;
  message: string;
}

export interface RejectReviewResult {
  success: boolean;
  reviewId: string;
  status: ReviewStatus;
  message: string;
}

export interface ReviewStats {
  total: number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  byPlatform: Record<string, number>;
  oldestPending: string | null;
  totalAdded: number;
  totalApproved: number;
  totalRejected: number;
}

export interface ErrorResult {
  error: string;
}

// Item to add to queue (used by registry or hook)
export interface AddToQueueItem {
  reason: ReviewReason;
  platform: string;
  entity: string;
  fingerprint: string;
  confidence: number | null;
  sensitiveFields?: string[];
  mappingPath?: string;
  metadata?: Record<string, unknown>;
}
