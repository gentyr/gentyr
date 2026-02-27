/**
 * Unit tests for AccountOverviewSection component
 *
 * Tests rendering behavior for the Account Overview dashboard:
 * - Account list with status, subscription type, email, expiry
 * - Current account marker (*) and color
 * - Quota bars (5h, 7d, 7d-sonnet)
 * - Event history (last 24h)
 * - Status color mapping
 * - Event type color mapping
 * - Conditional rendering based on data availability
 * - Title with account count and rotation count
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { AccountOverviewSection } from '../AccountOverviewSection.js';
import type { AccountOverviewData, AccountKeyDetail, AccountEvent } from '../../utils/account-overview-reader.js';

describe('AccountOverviewSection', () => {
  describe('Title Formatting', () => {
    it('should display deduplicated account count', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
          {
            keyId: 'key-2',
            status: 'invalid',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user@example.com', // Same email - should deduplicate
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('1 account');
      expect(output).not.toContain('2 account');
    });

    it('should use plural "accounts" for multiple accounts', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user1@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
          {
            keyId: 'key-2',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user2@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('2 accounts');
    });

    it('should display rotation count in title', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 5,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('5 rotations 24h');
    });

    it('should use singular "rotation" for count of 1', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 1,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('1 rotation 24h');
    });
  });

  describe('Account Rendering', () => {
    it('should render basic account information', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: 'test-key...',
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'test-key...',
            status: 'active',
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: new Date('2026-03-01'),
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 25,
            sevenDayPct: 50,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('test@example.com');
      expect(output).toContain('active');
      expect(output).toContain('valid');
      expect(output).toContain('available');
      expect(output).toContain('5h: 25%');
      expect(output).toContain('7d: 50%');
    });

    it('should display current account marker (*)', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: 'current-key',
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'current-key',
            status: 'active',
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: 'current@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
          {
            keyId: 'other-key',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'other@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      // Current account should have marker
      expect(output).toContain('*');
      expect(output).toContain('current@example.com');
    });

    it('should exclude accounts without email from deduplicated view', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      // Accounts without email are excluded from the deduplicated account list
      expect(output).toContain('0 accounts');
    });

    it('should display dash for null percentages', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('5h:   -');
      expect(output).toContain('7d:   -');
    });

    it('should render all status types with correct colors', () => {
      const statuses: Array<AccountKeyDetail['status']> = ['active', 'exhausted', 'expired', 'invalid'];

      statuses.forEach((status) => {
        const data: AccountOverviewData = {
          hasData: true,
          activeKeyId: null,
          totalRotations24h: 0,
          accounts: [
            {
              keyId: 'key-1',
              status,
              isCurrent: false,
              subscriptionType: 'claude_max',
              email: `${status}@example.com`,
              expiresAt: null,
              addedAt: null,
              lastUsedAt: null,
              fiveHourPct: null,
              sevenDayPct: null,
              sevenDaySonnetPct: null,
              fiveHourResetsAt: null,
              sevenDayResetsAt: null,
            },
          ],
          events: [],
        };

        const { lastFrame } = render(<AccountOverviewSection data={data} />);
        const output = lastFrame();

        expect(output).toContain(status);
      });
    });
  });

  describe('Usage Percentages', () => {
    it('should render 5h percentage when fiveHourPct is present', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 35,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('5h: 35%');
    });

    it('should render 7d percentage when sevenDayPct is present', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: 72,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('7d: 72%');
    });

    it('should display valid token status for active/exhausted accounts', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'exhausted',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 100,
            sevenDayPct: 100,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('valid');
      expect(output).toContain('exhausted');
    });

    it('should display invalid token status for expired/invalid accounts', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'invalid',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('invalid');
    });

    it('should display available usage for active non-exhausted accounts', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 50,
            sevenDayPct: 60,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('available');
    });

    it('should display dash for percentages when both are null', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('5h:   -');
      expect(output).toContain('7d:   -');
    });
  });

  describe('Event History', () => {
    it('should render event history section when events exist', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 1,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [
          {
            timestamp: new Date('2026-02-16T14:30:00'),
            event: 'key_switched',
            keyId: 'new-key...',
            description: 'Switched to new-key...',
            usageSnapshot: null,
          },
        ],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('EVENT HISTORY (last 24h)');
      expect(output).toContain('Switched to new-key...');
    });

    it('should not render event history section when events array is empty', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('EVENT HISTORY');
    });

    it('should render event timestamp in 12h format', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [
          {
            timestamp: new Date('2026-02-16T14:30:00'),
            event: 'key_switched',
            keyId: 'key-1',
            description: 'Switched to key-1',
            usageSnapshot: null,
          },
        ],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toMatch(/2:30\s*(PM|pm)/);
    });

    it('should render all event types with appropriate colors', () => {
      const events: Array<{ event: string; desc: string }> = [
        { event: 'key_switched', desc: 'Account selected: user@test.io' },
        { event: 'key_exhausted', desc: 'Account fully depleted: user@test.io' },
        { event: 'key_added', desc: 'New account added: user@test.io' },
        { event: 'account_nearly_depleted', desc: 'Account nearly depleted: user@test.io' },
        { event: 'account_quota_refreshed', desc: 'Account quota refreshed: user@test.io' },
        { event: 'account_auth_failed', desc: 'Account can no longer auth: user@test.io' },
        { event: 'account_removed', desc: 'Account removed by user: user@test.io' },
      ];

      events.forEach(({ event, desc }) => {
        const data: AccountOverviewData = {
          hasData: true,
          activeKeyId: null,
          totalRotations24h: 0,
          accounts: [
            {
              keyId: 'key-1',
              status: 'active',
              isCurrent: false,
              subscriptionType: 'claude_max',
              email: null,
              expiresAt: null,
              addedAt: null,
              lastUsedAt: null,
              fiveHourPct: null,
              sevenDayPct: null,
              sevenDaySonnetPct: null,
              fiveHourResetsAt: null,
              sevenDayResetsAt: null,
            },
          ],
          events: [
            {
              timestamp: new Date('2026-02-16T10:00:00'),
              event,
              keyId: 'key-1',
              description: desc,
              usageSnapshot: null,
            },
          ],
        };

        const { lastFrame } = render(<AccountOverviewSection data={data} />);
        const output = lastFrame();

        expect(output).toContain(desc);
      });
    });

    it('should render multiple events in order', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 2,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [
          {
            timestamp: new Date('2026-02-16T14:30:00'),
            event: 'key_switched',
            keyId: 'key-2',
            description: 'Switched to key-2',
            usageSnapshot: null,
          },
          {
            timestamp: new Date('2026-02-16T10:00:00'),
            event: 'key_added',
            keyId: 'key-3',
            description: 'New account added: key-3',
            usageSnapshot: null,
          },
        ],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Switched to key-2');
      expect(output).toContain('New account added: key-3');
    });
  });

  describe('Multiple Accounts', () => {
    it('should render multiple accounts with deduplication', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: 'key-2',
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user1@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 25,
            sevenDayPct: 50,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
          {
            keyId: 'key-2',
            status: 'active',
            isCurrent: true,
            subscriptionType: 'claude_pro',
            email: 'user2@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 60,
            sevenDayPct: 80,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('user1@example.com');
      expect(output).toContain('user2@example.com');
      expect(output).toContain('2 accounts');
    });

    it('should deduplicate accounts with same email', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'valid-key',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 25,
            sevenDayPct: 50,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
          {
            keyId: 'invalid-key',
            status: 'invalid',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'user@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      // Title should show 1 account (deduplicated by email)
      expect(output).toContain('1 account');

      // Should show the account with the better status (active)
      expect(output).toContain('user@example.com');
      expect(output).toContain('active');
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero accounts gracefully', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('0 accounts');
      expect(output).toBeTruthy();
    });

    it('should truncate very long email addresses to 26 characters', () => {
      const longEmail = 'very.long.email.address.that.might.wrap@example.com';
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: longEmail,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      // Email should be truncated to 23 chars + "..."
      expect(output).toContain('very.long.email.address...');
      expect(output).not.toContain(longEmail);
    });

    it('should handle 0% quota values', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'zero@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 0,
            sevenDayPct: 0,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('0%');
    });

    it('should handle 100% quota values', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'exhausted',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'maxed@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: 100,
            sevenDayPct: 100,
            sevenDaySonnetPct: 100,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('100%');
    });

    it('should handle special characters in event descriptions', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [
          {
            timestamp: new Date('2026-02-16T10:00:00'),
            event: 'custom_event',
            keyId: 'key-1',
            description: 'Event with <>&"\' special chars',
            usageSnapshot: null,
          },
        ],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Event with <>&"\' special chars');
    });

    it('should display note about per-account quota bars', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'test@example.com',
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<AccountOverviewSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Per-account quota bars in USAGE TRAJECTORY below');
    });
  });

  describe('Component Structure Validation', () => {
    it('should return a React element', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const result = render(<AccountOverviewSection data={data} />);

      expect(result).toBeDefined();
      expect(result.lastFrame()).toBeTruthy();
    });

    it('should maintain consistent structure across renders', () => {
      const data: AccountOverviewData = {
        hasData: true,
        activeKeyId: null,
        totalRotations24h: 0,
        accounts: [
          {
            keyId: 'key-1',
            status: 'active',
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null,
            expiresAt: null,
            addedAt: null,
            lastUsedAt: null,
            fiveHourPct: null,
            sevenDayPct: null,
            sevenDaySonnetPct: null,
            fiveHourResetsAt: null,
            sevenDayResetsAt: null,
          },
        ],
        events: [],
      };

      const render1 = render(<AccountOverviewSection data={data} />);
      const render2 = render(<AccountOverviewSection data={data} />);

      expect(render1.lastFrame()).toBe(render2.lastFrame());
    });
  });
});
