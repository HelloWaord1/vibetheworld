type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatLog(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
  };
  if (data) Object.assign(entry, data);
  return JSON.stringify(entry);
}

export const logger = {
  debug(component: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('debug')) console.log(formatLog('debug', component, message, data));
  },
  info(component: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('info')) console.log(formatLog('info', component, message, data));
  },
  warn(component: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('warn')) console.warn(formatLog('warn', component, message, data));
  },
  error(component: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('error')) console.error(formatLog('error', component, message, data));
  },
};
