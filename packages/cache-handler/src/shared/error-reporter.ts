/**
 * Rate-limited error logging for cache backends.
 *
 * A cache handler must degrade to a miss rather than throw, but a backend that
 * is down or misconfigured must still be visible in production logs. Errors
 * are always logged (the cache logger's `error`, or `console.error`), at most once per `intervalMs` per
 * operation, so an outage produces a steady trickle of log lines rather than
 * one per request. Each logged line reports how many errors were suppressed
 * since the previous one.
 */

import { nowMs } from "./clock.js";
import { type LoggerSource, processLogger, writeLog } from "./logger.js";

/**
 * Report an error for the named operation (e.g. "get", "set", "connection").
 */
export type ErrorReporter = (operation: string, error: unknown) => void;

/**
 * Default minimum time between two logged errors for the same operation.
 */
export const DEFAULT_ERROR_LOG_INTERVAL_MS = 60_000;

interface OperationState {
  lastLoggedAt: number;
  suppressed: number;
}

/**
 * Create an {@link ErrorReporter} that logs errors under `prefix` (see `shared/logger.ts`),
 * at most once per `intervalMs` for each operation.
 */
export function createErrorReporter(
  prefix: string,
  intervalMs: number = DEFAULT_ERROR_LOG_INTERVAL_MS,
  logger: LoggerSource = processLogger,
): ErrorReporter {
  const operations = new Map<string, OperationState>();

  return (operation, error) => {
    const now = nowMs();
    const state = operations.get(operation);

    if (state && now - state.lastLoggedAt < intervalMs) {
      state.suppressed += 1;
      return;
    }

    const suppressed = state?.suppressed ?? 0;
    operations.set(operation, { lastLoggedAt: now, suppressed: 0 });

    const seconds = Math.round(intervalMs / 1000);
    const note =
      suppressed > 0
        ? ` (${suppressed} similar errors suppressed in the last ${seconds}s)`
        : ` (further ${operation} errors suppressed for ${seconds}s)`;

    writeLog(logger, "error", `${prefix} ${operation} failed${note}`, { operation, error });
  };
}
