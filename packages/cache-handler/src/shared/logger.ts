/**
 * Where the package's log lines go: a {@link CacheLogger} the application gives, or the console.
 *
 * The logger is set for the process with {@link setCacheLogger}, kept on `globalThis` so every
 * module graph Next loads the handlers in sees it (DEC-5), or passed as `logger` to a handler
 * factory; that one wins for what the handler logs. Without either, every line goes to the
 * console exactly as before there was a logger. A logger that throws never fails a cache call:
 * the line goes to the console instead.
 *
 * Nothing logged carries a Redis URL or the connection options: they can hold a password. Every
 * line also goes through {@link redactForLog} on its way out, because errors from Redis can carry
 * credentials of their own: ioredis attaches the failed command, arguments included, to a reply
 * error, so a rejected `AUTH` carries the password it tried. The guarantee covers structured
 * fields, error causes, URL user information and the signature, credential and session token of
 * an AWS presigned URL (an ElastiCache IAM token), not arbitrary free text in a message.
 */

/**
 * A logger for the package's warnings, errors and `CACHE_DEBUG` output. winston and `console`
 * fit as they are; pino and bunyan take the fields first, so wrap them:
 * `warn: (message, meta) => pino.warn(meta ?? {}, message)`. `info` and `debug` are optional;
 * without them those lines are dropped.
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
 *   if (process.env.NEXT_RUNTIME === "nodejs") setCacheLogger(logger);
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
      method.call(logger, redactText(message), redactForLog(meta));
      return;
    } catch (error) {
      const state = getState();
      if (!state.reportedThrow) {
        state.reportedThrow = true;
        console.error(
          "[RedisCache]: the cache logger threw; its lines go to the console",
          redactForLog(error),
        );
      }
    }
  }
  console[level](...consoleArgs.map((arg) => redactForLog(arg)));
}

/**
 * Properties that can hold credentials, or the Redis command that carried them (ioredis's
 * `error.command`, with its `args`); never logged.
 */
const SECRET_KEYS = new Set([
  "command",
  "options",
  "password",
  "pass",
  "username",
  "user",
  "auth",
  "credentials",
  "token",
  "redisOptions",
]);

/**
 * The user information of a URL (`redis://user:password@`), through the last `@` of the
 * authority: a password may itself hold an `@` (`redis://user:pre@fix@host`).
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;

/** Error properties kept besides name, message, stack and cause: none can hold a credential. */
const SAFE_ERROR_FIELDS = ["code", "errno", "syscall", "address", "port"] as const;

/**
 * The secret parts of an AWS SigV4 presigned query, which is what an ElastiCache IAM token is.
 */
const PRESIGNED_SECRETS = /(X-Amz-(?:Signature|Security-Token|Credential)=)[^&\s"']*/gi;

const REDACTED = "[redacted]";

function redactText(text: string): string {
  return text.replace(URL_USERINFO, `$1${REDACTED}@`).replace(PRESIGNED_SECRETS, `$1${REDACTED}`);
}

/**
 * `value` safe to log, never the value itself:
 * - an error (or error-like object) as a new `Error` with only its name, message, stack,
 *   {@link SAFE_ERROR_FIELDS} and a cause redacted the same way;
 * - plain objects and arrays copied without {@link SECRET_KEYS};
 * - URLs in strings without their user information, and presigned AWS queries without their
 *   signature, credential and session token;
 * - anything else (a `Buffer`, a typed array, a class instance) as a placeholder such as
 *   `[Buffer 12 bytes]` or `[ClassName]`.
 *
 * Free text is not scrubbed beyond URL user information: a credential written into a message
 * some other way reaches the log.
 */
export function redactForLog<T>(value: T): T {
  return redact(value, 0, new WeakSet()) as T;
}

/** {@link redactForLog} below `depth`; `ancestors` are the objects being copied around it. */
function redact(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value) || depth > 8) return "[omitted]";
  ancestors.add(value);
  try {
    return redactObject(value, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function isErrorLike(value: object): value is Error {
  if (value instanceof Error) return true;
  const { name, message } = value as { name?: unknown; message?: unknown };
  return typeof name === "string" && typeof message === "string";
}

/** What stands in for a value that is neither an error, an array nor a plain object. */
function placeholder(value: object): string {
  if (ArrayBuffer.isView(value)) {
    const kind =
      typeof Buffer !== "undefined" && Buffer.isBuffer(value) ? "Buffer" : value.constructor.name;
    return `[${kind} ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  const name = (value.constructor as { name?: unknown } | undefined)?.name;
  return `[${typeof name === "string" && name ? name : "object"}]`;
}

function redactObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  const prototype = Object.getPrototypeOf(value);
  const plain = prototype === Object.prototype || prototype === null;
  if (!Array.isArray(value) && !plain && isErrorLike(value)) {
    const cause = value.cause === undefined ? {} : { cause: redact(value.cause, depth + 1, seen) };
    const safe = new Error(redactText(value.message), cause);
    // As on any error: not enumerable, so the copy prints like the original.
    Object.defineProperty(safe, "name", { value: value.name, configurable: true, writable: true });
    safe.stack = typeof value.stack === "string" ? redactText(value.stack) : undefined;
    for (const field of SAFE_ERROR_FIELDS) {
      const item = (value as unknown as Record<string, unknown>)[field];
      if (typeof item === "number") Object.assign(safe, { [field]: item });
      else if (typeof item === "string") Object.assign(safe, { [field]: redactText(item) });
    }
    return safe;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (!plain) return placeholder(value);
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SECRET_KEYS.has(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return copy;
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
