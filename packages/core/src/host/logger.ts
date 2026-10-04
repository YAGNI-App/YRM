import type { Logger } from "../contracts/index.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  msg: string;
  /** Extension or subsystem name, set through `prefix()`. */
  scope?: string;
  data?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Writes one JSON object per line to stderr. Never stdout: hosts may own it (MCP over stdio). */
export const stderrSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** A logger that can produce scoped children. Every Logger in the host is one of these. */
export interface HostLogger extends Logger {
  prefix(name: string): HostLogger;
}

export function createLogger(level: LogLevel = "info", sink: LogSink = stderrSink, scope?: string): HostLogger {
  const min = ORDER[level];
  const write = (lvl: Exclude<LogLevel, "silent">, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[lvl] < min) return;
    const record: LogRecord = { ts: new Date().toISOString(), level: lvl, msg };
    if (scope !== undefined) record.scope = scope;
    if (data !== undefined) record.data = data;
    sink(record);
  };
  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    prefix: (name) => createLogger(level, sink, scope === undefined ? name : `${scope}:${name}`),
  };
}

/**
 * Scope any Logger to a name. HostLoggers nest scopes; plain Loggers get the
 * name folded into the message so nothing is lost.
 */
export function prefix(log: Logger, name: string): Logger {
  if (isHostLogger(log)) return log.prefix(name);
  return {
    debug: (msg, data) => log.debug(`[${name}] ${msg}`, data),
    info: (msg, data) => log.info(`[${name}] ${msg}`, data),
    warn: (msg, data) => log.warn(`[${name}] ${msg}`, data),
    error: (msg, data) => log.error(`[${name}] ${msg}`, data),
  };
}

function isHostLogger(log: Logger): log is HostLogger {
  return typeof (log as Partial<HostLogger>).prefix === "function";
}

/** A logger that drops everything. Useful for tests and embedded hosts. */
export const silentLogger: HostLogger = createLogger("silent", () => {});
