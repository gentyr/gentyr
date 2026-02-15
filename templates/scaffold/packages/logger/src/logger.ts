interface LogEntry {
  '@timestamp': string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  message: string;
  requestId?: string;
  userId?: string;
  module?: string;
  error?: { message: string; stack?: string; type?: string };
  data?: unknown;
  [key: string]: unknown;
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export function createLogger(service: string) {
  const minLevel = LOG_LEVELS[(process.env.LOG_LEVEL as keyof typeof LOG_LEVELS) || 'info'] ?? 1;

  function log(level: LogEntry['level'], message: string, context?: Record<string, unknown>) {
    if (LOG_LEVELS[level] < minLevel) return;

    const entry: LogEntry = {
      '@timestamp': new Date().toISOString(),
      level,
      service,
      message,
      ...context,
    };

    const output = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
  };
}
