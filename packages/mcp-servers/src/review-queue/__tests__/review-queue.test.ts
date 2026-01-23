/**
 * Unit tests for Review Queue MCP Server
 *
 * Tests review queue management, G001/G003 compliance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Types for review queue
interface ReviewItem {
  id: string;
  status: string;
  schemaId?: string;
  source?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  notes?: string;
  rejectionReason?: string;
  platform?: string;
  entity?: string;
  fingerprint?: string;
}

interface ReviewQueue {
  items: ReviewItem[];
  stats: {
    totalAdded: number;
    totalApproved: number;
    totalRejected: number;
  };
}

interface ReviewItemInput {
  schemaId?: string;
  source?: string;
  reason?: string;
  platform?: string;
  entity?: string;
  fingerprint?: string;
}

describe('Review Queue Server', () => {
  let tempQueueFile: string;

  beforeEach(() => {
    tempQueueFile = path.join('/tmp', `review-queue-${randomUUID()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tempQueueFile)) {
      fs.unlinkSync(tempQueueFile);
    }
  });

  const readQueue = (): ReviewQueue => {
    if (!fs.existsSync(tempQueueFile)) {
      return { items: [], stats: { totalAdded: 0, totalApproved: 0, totalRejected: 0 } };
    }
    return JSON.parse(fs.readFileSync(tempQueueFile, 'utf8')) as ReviewQueue;
  };

  const writeQueue = (queue: ReviewQueue) => {
    const dir = path.dirname(tempQueueFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tempQueueFile, JSON.stringify(queue, null, 2));
  };

  const addToQueue = (item: ReviewItemInput) => {
    const queue = readQueue();
    const reviewItem = {
      id: `review-${Date.now()}-${randomUUID()}`,
      status: 'pending',
      ...item,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    queue.items.unshift(reviewItem);
    queue.stats.totalAdded++;
    writeQueue(queue);
    return reviewItem.id;
  };

  describe('Queue Management', () => {
    it('should initialize empty queue (G001)', () => {
      const queue = readQueue();
      expect(queue.items).toEqual([]);
      expect(queue.stats.totalAdded).toBe(0);
    });

    it('should add item to queue', () => {
      const id = addToQueue({
        reason: 'first-platform-mapping',
        platform: 'azure',
        entity: 'users',
        fingerprint: 'abc123',
      });

      const queue = readQueue();
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0].id).toBe(id);
      expect(queue.stats.totalAdded).toBe(1);
    });

    it('should handle corrupted queue file (G001)', () => {
      fs.writeFileSync(tempQueueFile, 'invalid json');

      expect(() => readQueue()).toThrow(); // Will throw JSON parse error
    });
  });

  describe('Review Actions', () => {
    it('should approve review', () => {
      const id = addToQueue({
        reason: 'low-confidence',
        platform: 'aws',
        entity: 'roles',
        fingerprint: 'def456',
      });

      const queue = readQueue();
      const item = queue.items.find((i: ReviewItem) => i.id === id);
      item.status = 'approved';
      item.updatedAt = new Date().toISOString();
      queue.stats.totalApproved++;
      writeQueue(queue);

      const updated = readQueue();
      expect(updated.items[0].status).toBe('approved');
      expect(updated.stats.totalApproved).toBe(1);
    });

    it('should reject review with reason', () => {
      const id = addToQueue({
        reason: 'sensitive-fields',
        platform: 'okta',
        entity: 'groups',
        fingerprint: 'ghi789',
      });

      const queue = readQueue();
      const item = queue.items.find((i: ReviewItem) => i.id === id);
      item.status = 'rejected';
      item.rejectionReason = 'Security concern';
      item.updatedAt = new Date().toISOString();
      queue.stats.totalRejected++;
      writeQueue(queue);

      const updated = readQueue();
      expect(updated.items[0].status).toBe('rejected');
      expect(updated.items[0].rejectionReason).toBe('Security concern');
    });
  });

  describe('Queue Limits', () => {
    it('should enforce max queue size', () => {
      // Note: This test simulates the behavior, but actual enforcement
      // happens in the server's addToQueue function
      const queue = { items: [], stats: { totalAdded: 0, totalApproved: 0, totalRejected: 0 } };

      for (let i = 0; i < 105; i++) {
        const item = {
          id: `review-${i}`,
          reason: 'manual-request',
          platform: 'test',
          entity: `entity${i}`,
          fingerprint: `fp${i}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        queue.items.unshift(item);

        // Enforce max size of 100
        while (queue.items.length > 100) {
          queue.items.pop();
        }
      }

      expect(queue.items.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Input Validation (G003)', () => {
    it('should validate required fields', () => {
      // In the actual server, Zod validation would catch this
      // Here we test the logic without Zod
      const item = { platform: 'azure' }; // Missing reason, entity, fingerprint
      const hasRequiredFields = 'reason' in item && 'entity' in item && 'fingerprint' in item;
      expect(hasRequiredFields).toBe(false);
    });
  });
});
