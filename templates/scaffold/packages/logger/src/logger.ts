/**
 * Core structured logger with JSON output.
 *
 * Features:
 * - Structured JSON logging (ECS-compatible) for machine parsing
 * - Log levels (debug, info, warn, error) with environment-aware defaults
 * - Optional output callback for external consumers (e.g., Elastic shipping)
 * - Sensitive data redaction via redact() utility
 */

import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  '@timestamp': string;
  level: LogLevel;
  service: string;
  message: string;
  module?: string;
  requestId?: string;
  userId?: string;
  error?: { message: string; stack?: string; type?: string };
  data?: unknown;
  [key: string]: unknown;
}

export interface LoggerConfig {
  level?: LogLevel;
  service?: string;
  module?: string;
  /** Custom output handler — receives each log entry for external shipping (e.g., Elastic) */
  output?: (entry: LogEntry) => void;
}

export interface Logger {
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getDefaultLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) return envLevel as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export function createLogger(config: LoggerConfig & { service: string }): Logger {
  const { level = getDefaultLevel(), service, module: mod, output } = config;
  const minLevel = LOG_LEVELS[level];

  function log(lvl: LogLevel, message: string, context?: Record<string, unknown>) {
    if (LOG_LEVELS[lvl] < minLevel) return;

    const entry: LogEntry = {
      '@timestamp': new Date().toISOString(),
      level: lvl,
      service,
      message,
      ...(mod ? { module: mod } : {}),
      ...(context ? redact(context) : {}),
    };

    if (output) {
      output(entry);
    } else {
      const json = JSON.stringify(entry);
      if (lvl === 'error' || lvl === 'warn') {
        process.stderr.write(json + '\n');
      } else {
        process.stdout.write(json + '\n');
      }
    }
  }

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
  };
}
