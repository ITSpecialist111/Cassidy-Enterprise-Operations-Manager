// ---------------------------------------------------------------------------
// Structured JSON Logger
// ---------------------------------------------------------------------------
// Replaces raw console.log/warn/error with structured JSON output for
// App Insights KQL queries and Azure Monitor log search.
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  module?: string;
  userId?: string;
  conversationId?: string;
  toolName?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function emit(entry: LogEntry): void {
  const json = JSON.stringify(entry);
  switch (entry.level) {
    case 'error': console.error(json); break;
    case 'warn':  console.warn(json);  break;
    default:      console.log(json);   break;
  }
}

export interface LogContext {
  module?: string;
  userId?: string;
  conversationId?: string;
  toolName?: string;
  durationMs?: number;
  [key: string]: unknown;
}

function buildEntry(level: LogLevel, message: string, ctx?: LogContext): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...ctx,
  };
}

export const logger = {
  debug(message: string, ctx?: LogContext): void {
    if (shouldLog('debug')) emit(buildEntry('debug', message, ctx));
  },
  info(message: string, ctx?: LogContext): void {
    if (shouldLog('info')) emit(buildEntry('info', message, ctx));
  },
  warn(message: string, ctx?: LogContext): void {
    if (shouldLog('warn')) emit(buildEntry('warn', message, ctx));
  },
  error(message: string, ctx?: LogContext): void {
    if (shouldLog('error')) emit(buildEntry('error', message, ctx));
  },
};
