/**
 * Logger the ISR handlers report failures to (pino, winston and console all fit)
 */
export interface CacheHandlerLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export const consoleLogger: CacheHandlerLogger = {
  warn(message, details) {
    console.warn(message, details ?? "");
  },
};

/**
 * A failing cache backend fails every operation, and an ioredis client emits
 * an error on every reconnect attempt. Reports each kind of failure at most
 * once per interval, with how many were suppressed since the last report.
 */
export class RateLimitedWarner {
  private readonly lastReported = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly logger: CacheHandlerLogger,
    private readonly message: string,
    private readonly intervalMs = 60_000,
  ) {}

  warn(operation: string, error: unknown): void {
    const now = Date.now();
    const last = this.lastReported.get(operation);
    if (last && now - last.at < this.intervalMs) {
      last.suppressed++;
      return;
    }
    this.lastReported.set(operation, { at: now, suppressed: 0 });
    this.logger.warn(this.message, {
      operation,
      error: error instanceof Error ? error.message : String(error),
      suppressed: last?.suppressed ?? 0,
    });
  }
}
