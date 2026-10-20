/**
 * Where the package's log lines go: a {@link CacheLogger} the application gives, or the console.
 *
 * The logger is set for the process with {@link setCacheLogger}, kept on `globalThis` so every
 * module graph Next loads the handlers in sees it (DEC-5), or passed as `logger` to a handler
 * factory; that one wins for what the handler logs. Without either, every line goes to the
 * console exactly as before there was a logger. A logger that throws never fails a cache call:
 * the line goes to the console instead.
 *
 * Nothing logged carries a Redis URL or the connection options: they can hold a password.
 */

/**
 * A logger for the package's warnings, errors and `CACHE_DEBUG` output (pino, winston, bunyan
 * and `console` fit as they are). `info` and `debug` are optional; without them those lines are
 * dropped.
 */
export interface CacheLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/** A log level: a method of {@link CacheLogger}. */
export type LogLevel = keyof CacheLogger;

/** The logger to use at the time of a line: a handler's own, else the process's, if any. */
export type LoggerSource = () => CacheLogger | undefined;

interface LoggerState {
  logger: CacheLogger | undefined;
  /** Set once a logger has thrown and the console said so. */
  reportedThrow: boolean;
}

const LOGGER_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/logger");

function getState(): LoggerState {
  const store = globalThis as unknown as Record<symbol, LoggerState | undefined>;
  let state = store[LOGGER_KEY];
  if (!state) {
    state = { logger: undefined, reportedThrow: false };
    store[LOGGER_KEY] = state;
  }
  return state;
}

/**
 * Send the package's log lines to `logger` in this process, or back to the console with
 * `undefined`. Call it before the cache is used, in `instrumentation.ts` or a custom handler file.
 * A `logger` passed to a handler factory wins over it for that handler.
 *
 * @example
 * ```ts
 * // instrumentation.ts
 * import { setCacheLogger } from "@mrjasonroy/cache-components-cache-handler";
 * import { logger } from "./lib/logger";
 *
 * export function register() {
 *   setCacheLogger(logger);
 * }
 * ```
 */
export function setCacheLogger(logger: CacheLogger | undefined): void {
  getState().logger = logger;
}

/** The process's logger, if one was set. */
export function processLogger(): CacheLogger | undefined {
  return getState().logger;
}

/** `logger` if given, else the process's at the time of each line. */
export function loggerSource(logger: CacheLogger | undefined): LoggerSource {
  return logger ? () => logger : processLogger;
}

/**
 * Write one line: to the logger as `message` and `meta`, or, without one, to the console as
 * `consoleArgs`, which is what the console got before there was a logger.
 */
export function writeLog(
  source: LoggerSource,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  consoleArgs: unknown[] = meta?.error === undefined ? [message] : [message, meta.error],
): void {
  const logger = source();
  if (logger) {
    const method = logger[level];
    if (!method) return;
    try {
      method.call(logger, message, meta);
      return;
    } catch (error) {
      const state = getState();
      if (!state.reportedThrow) {
        state.reportedThrow = true;
        console.error("[RedisCache]: the cache logger threw; its lines go to the console", error);
      }
    }
  }
  console[level](...consoleArgs);
}

/**
 * A debug log under `prefix`: each call is one line, `console.debug(prefix, ...args)` without a
 * logger.
 */
export function debugWriter(
  prefix: string,
  source: LoggerSource = processLogger,
): (...args: unknown[]) => void {
  return (...args) =>
    writeLog(source, "debug", `${prefix} ${formatArgs(args)}`, { args }, [prefix, ...args]);
}

/**
 * A debug line's arguments as text, for a logger: strings as they are, the rest as JSON (an
 * error by its message).
 */
export function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Forget the logger and the throw already reported. Test-only.
 * @internal
 */
export function resetCacheLoggerForTests(): void {
  const state = getState();
  state.logger = undefined;
  state.reportedThrow = false;
}
