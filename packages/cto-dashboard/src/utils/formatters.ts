/**
 * Formatting utilities for the dashboard
 */

/**
 * Format a number with K/M/B suffixes
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1) + 'B';
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * Format a duration in milliseconds to human-readable
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format a percentage (0-100)
 */
export function formatPercent(pct: number): string {
  return `${Math.round(pct)}%`;
}

/**
 * Format a timestamp to HH:MM
 */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format a timestamp to h:mmAM/PM (e.g., "2:34PM")
 */
export function formatTime12h(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace(' ', '');
}

/**
 * Format seconds as compact duration (e.g., "5m23s", "1h2m", "45s")
 */
export function formatDelta(seconds: number): string {
  if (seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}

/**
 * Format a timestamp to YYYY-MM-DD HH:MM
 */
export function formatDateTime(date: Date): string {
  const dateStr = date.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const timeStr = formatTime(date);
  return `${dateStr} ${timeStr}`;
}

/**
 * Format an ISO timestamp as relative time (e.g., "5m ago", "2h ago", "3d ago")
 */
export function formatTimeAgo(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Calculate cache hit rate from token usage
 */
export function calculateCacheRate(cacheRead: number, input: number): number {
  const totalInput = cacheRead + input;
  if (totalInput === 0) return 0;
  return Math.round((cacheRead / totalInput) * 100);
}
