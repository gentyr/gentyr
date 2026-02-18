/**
 * Account Overview section — per-account status, quotas, and event history.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { QuotaBar } from './QuotaBar.js';
import { formatTime12h } from '../utils/formatters.js';
import type { AccountOverviewData, AccountKeyDetail, AccountEvent } from '../utils/account-overview-reader.js';

export interface AccountOverviewSectionProps {
  data: AccountOverviewData;
}

function statusColor(status: AccountKeyDetail['status']): string {
  switch (status) {
    case 'active': return 'green';
    case 'exhausted': return 'red';
    case 'expired': return 'yellow';
    case 'invalid': return 'gray';
  }
}

function eventColor(event: string): string {
  switch (event) {
    case 'key_switched': return 'cyan';
    case 'key_exhausted': return 'red';
    case 'key_added': return 'green';
    case 'key_removed': return 'yellow';
    default: return 'gray';
  }
}

function formatExpiry(date: Date | null): string {
  if (!date) return 'no expiry';
  return `Exp: ${date.toLocaleDateString('en-CA')}`;
}

function AccountRow({ account }: { account: AccountKeyDetail }): React.ReactElement {
  const marker = account.isCurrent ? '* ' : '  ';
  const emailStr = account.email ?? 'no email';
  const statusPad = account.status.padEnd(9);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={account.isCurrent ? 'cyan' : 'gray'}>{marker}</Text>
        <Text color="white" bold>{account.keyId}</Text>
        <Text>  </Text>
        <Text color={statusColor(account.status)}>{statusPad}</Text>
        <Text>  </Text>
        <Text color="gray">{account.subscriptionType.padEnd(11)}</Text>
        <Text>  </Text>
        <Text color="gray">{emailStr}</Text>
        <Text>  </Text>
        <Text color="gray">{formatExpiry(account.expiresAt)}</Text>
      </Box>
      {(account.fiveHourPct !== null || account.sevenDayPct !== null) && (
        <Box marginLeft={2}>
          {account.fiveHourPct !== null && (
            <QuotaBar label="5h" percentage={account.fiveHourPct} width={12} />
          )}
          <Text>   </Text>
          {account.sevenDayPct !== null && (
            <QuotaBar label="7d" percentage={account.sevenDayPct} width={12} />
          )}
          {account.sevenDaySonnetPct !== null &&
           account.sevenDayPct !== null &&
           Math.abs(account.sevenDaySonnetPct - account.sevenDayPct) > 10 && (
            <>
              <Text>   </Text>
              <QuotaBar label="7d-son" percentage={account.sevenDaySonnetPct} width={12} />
            </>
          )}
        </Box>
      )}
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

export function AccountOverviewSection({ data }: AccountOverviewSectionProps): React.ReactElement {
  const nonInvalid = data.accounts.filter(a => a.status !== 'invalid');
  const title = `ACCOUNT OVERVIEW (${nonInvalid.length} account${nonInvalid.length !== 1 ? 's' : ''} | ${data.totalRotations24h} rotation${data.totalRotations24h !== 1 ? 's' : ''} 24h)`;

  return (
    <Section title={title}>
      <Box flexDirection="column">
        {data.accounts.map((account) => (
          <AccountRow key={account.keyId} account={account} />
        ))}

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
