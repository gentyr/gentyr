/**
 * Account Overview section — deduplicated per-account status and event history.
 *
 * Groups keys by email and shows one row per account with:
 * - email (keys without an email are skipped)
 * - token validity
 * - usage availability
 * - current 5h/7d percentages
 *
 * Per-account quota bars are shown in the USAGE TRAJECTORY section below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTime12h } from '../utils/formatters.js';
import type { AccountOverviewData, AccountKeyDetail, AccountEvent } from '../utils/account-overview-reader.js';

export interface AccountOverviewSectionProps {
  data: AccountOverviewData;
  tip?: string;
}

// Status priority: lower = better (used to pick best key per account)
const STATUS_PRIORITY: Record<AccountKeyDetail['status'], number> = {
  active: 0,
  exhausted: 1,
  expired: 2,
  invalid: 3,
  tombstone: 4,
};

interface DeduplicatedAccount {
  email: string;
  isCurrent: boolean;
  bestStatus: AccountKeyDetail['status'];
  keyCount: number;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  hasValidToken: boolean;
  hasUsage: boolean;
}

export function deduplicateAccounts(accounts: AccountKeyDetail[]): DeduplicatedAccount[] {
  const map = new Map<string, { keys: AccountKeyDetail[]; isCurrent: boolean }>();

  for (const acct of accounts) {
    if (!acct.email) continue; // Skip keys without an email (orphaned/duplicate entries)
    const key = acct.email;
    const existing = map.get(key);
    if (existing) {
      existing.keys.push(acct);
      if (acct.isCurrent) existing.isCurrent = true;
    } else {
      map.set(key, { keys: [acct], isCurrent: acct.isCurrent });
    }
  }

  const result: DeduplicatedAccount[] = [];
  for (const [email, { keys, isCurrent }] of map) {
    // Pick the best key (lowest status priority) for display values
    keys.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
    const best = keys[0];

    const hasValidToken = keys.some(k => k.status === 'active' || k.status === 'exhausted');
    const hasUsage = keys.some(k =>
      k.status === 'active' &&
      (k.fiveHourPct == null || k.fiveHourPct < 100) &&
      (k.sevenDayPct == null || k.sevenDayPct < 100)
    );

    result.push({
      email,
      isCurrent,
      bestStatus: best.status,
      keyCount: keys.length,
      fiveHourPct: best.fiveHourPct,
      sevenDayPct: best.sevenDayPct,
      hasValidToken,
      hasUsage,
    });
  }

  // Sort: current first, then by status priority
  result.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return STATUS_PRIORITY[a.bestStatus] - STATUS_PRIORITY[b.bestStatus];
  });

  return result;
}

function eventColor(event: string): string {
  switch (event) {
    case 'key_switched': return 'cyan';
    case 'key_exhausted': return 'red';
    case 'key_added': return 'green';
    case 'account_nearly_depleted': return 'yellow';
    case 'account_quota_refreshed': return 'green';
    case 'account_auth_failed': return 'red';
    case 'account_removed': return 'yellow';
    default: return 'gray';
  }
}

function authLabel(status: AccountKeyDetail['status']): { text: string; color: string } {
  switch (status) {
    case 'active':
    case 'exhausted':
      return { text: 'OK', color: 'green' };
    case 'expired':
      return { text: 'expired', color: 'yellow' };
    case 'invalid':
      return { text: 'failed', color: 'red' };
    case 'tombstone':
      return { text: 'removed', color: 'gray' };
  }
}

function quotaLabel(account: DeduplicatedAccount): { text: string; color: string } {
  if (account.bestStatus === 'invalid' || account.bestStatus === 'expired' || account.bestStatus === 'tombstone') {
    return { text: '-', color: 'gray' };
  }
  if (account.hasUsage) {
    return { text: 'available', color: 'green' };
  }
  return { text: 'depleted', color: 'red' };
}

function AccountHeader(): React.ReactElement {
  return (
    <Box>
      <Text color="gray">{'  '}</Text>
      <Text color="gray" bold>{'Account'.padEnd(26)}</Text>
      <Text color="gray" bold>{'Auth'.padEnd(10)}</Text>
      <Text color="gray" bold>{'Quota'.padEnd(11)}</Text>
      <Text color="gray" bold>{'Usage'}</Text>
    </Box>
  );
}

function AccountRow({ account }: { account: DeduplicatedAccount }): React.ReactElement {
  const marker = account.isCurrent ? '* ' : '  ';
  const isTombstone = account.bestStatus === 'tombstone';
  const prefix = isTombstone ? '[x] ' : '';
  const maxEmailLen = 26 - prefix.length;
  const emailDisplay = account.email.length > maxEmailLen
    ? account.email.slice(0, maxEmailLen - 3) + '...'
    : account.email;
  const emailPad = (prefix + emailDisplay).padEnd(26);

  const auth = authLabel(account.bestStatus);
  const quota = quotaLabel(account);

  const fiveH = account.fiveHourPct != null ? `${account.fiveHourPct}%` : '-';
  const sevenD = account.sevenDayPct != null ? `${account.sevenDayPct}%` : '-';

  return (
    <Box>
      <Text color={account.isCurrent ? 'cyan' : 'gray'}>{marker}</Text>
      <Text color="white">{emailPad}</Text>
      <Text color={auth.color}>{auth.text.padEnd(10)}</Text>
      <Text color={quota.color}>{quota.text.padEnd(11)}</Text>
      <Text color="gray">{`5h:${fiveH.padStart(4)}  7d:${sevenD.padStart(4)}`}</Text>
    </Box>
  );
}

function EventRow({ evt }: { evt: AccountEvent }): React.ReactElement {
  const timeStr = formatTime12h(evt.timestamp).padStart(8);
  return (
    <Box>
      <Text color="gray">{timeStr}  </Text>
      <Text color={eventColor(evt.event)}>{evt.description}</Text>
    </Box>
  );
}

export function AccountOverviewSection({ data, tip }: AccountOverviewSectionProps): React.ReactElement {
  const deduplicated = deduplicateAccounts(data.accounts);
  const title = `ACCOUNT OVERVIEW (${deduplicated.length} account${deduplicated.length !== 1 ? 's' : ''} | ${data.totalRotations24h} rotation${data.totalRotations24h !== 1 ? 's' : ''} 24h)`;

  return (
    <Section title={title} tip={tip}>
      <Box flexDirection="column">
        <AccountHeader />
        {deduplicated.map((account, idx) => (
          <AccountRow key={`${account.email}-${idx}`} account={account} />
        ))}

        <Box marginTop={1}>
          <Text color="gray">  Per-account quota bars in USAGE TRAJECTORY below.</Text>
        </Box>

        {data.events.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan" bold>  EVENT HISTORY (last 24h)</Text>
            {data.events.map((evt, idx) => (
              <EventRow key={idx} evt={evt} />
            ))}
          </Box>
        )}
      </Box>
    </Section>
  );
}
