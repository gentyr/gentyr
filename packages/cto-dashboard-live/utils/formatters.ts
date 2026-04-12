/**
 * Formatting utilities (adapted from @gentyr/cto-dashboard)
 */

export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

export function formatTokens(total: number | null): string {
  if (total == null) return '-';
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(0)}K`;
  return String(total);
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds > 0 ? ` ${seconds.toString().padStart(2, '0')}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes.toString().padStart(2, '0')}m` : ''}`;
}

export function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return `${mins}m${remainSecs > 0 ? `${remainSecs}s` : ''}`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins > 0 ? `${remainMins}m` : ''}`;
}

export function formatTimeAgo(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  return formatElapsed(diffMs) + ' ago';
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatTime12h(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '');
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    return '??:??';
  }
}

export function formatPercent(pct: number): string {
  return `${Math.round(pct)}%`;
}

export function formatDelta(seconds: number): string {
  if (seconds < 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

export function calculateCacheRate(cacheRead: number, input: number): number {
  const totalInput = cacheRead + input;
  if (totalInput === 0) return 0;
  return Math.round((cacheRead / totalInput) * 100);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

/** Strip redundant prefixes from session titles (Monitor:, Force-spawn:, [Persistent], etc.) */
export function cleanTitle(title: string): string {
  return title
    .replace(/^\[Persistent\]\s*/i, '')
    .replace(/^Monitor revival:\s*/i, '')
    .replace(/^Stale-pause revival:\s*/i, '')
    .replace(/^Monitor:\s*/i, '')
    .replace(/^Force-spawn:\s*\S+\s*-\s*/i, '')
    .replace(/^\[Revival\]\s*/i, '');
}