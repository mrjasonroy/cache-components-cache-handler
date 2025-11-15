import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
} from "../types.js";

export interface CompositeHandlerOptions extends CacheHandlerOptions {
  /**
   * Array of cache handlers to use (ordered by priority)
   * First handler is checked first for reads
   */
  handlers: CacheHandler[];

  /**
   * Strategy function to determine which handler to use for set operations
   * Returns the index of the handler to use
   *
   * @default - Write to all handlers
   */
  setStrategy?: (data: CacheHandlerValue) => number;
}

/**
 * Composite cache handler that orchestrates multiple cache handlers
 * Enables multi-tier caching strategies (e.g., memory -> Redis)
 *
 * Features:
 * - First-match read strategy (fast fallback)
 * - Configurable write strategy
 * - Fault tolerance with Promise.allSettled()
 * - Parallel revalidation across all handlers
 *
 * @example
 * ```typescript
 * // Memory + Redis two-tier cache
 * const handler = createCompositeHandler({
 *   handlers: [memoryHandler, redisHandler],
 *   // Only cache small items in memory, everything in Redis
 *   setStrategy: (data) => {
 *     const size = JSON.stringify(data).length;
 *     return size < 10000 ? 0 : 1; // 0 = memory, 1 = redis
 *   }
 * });
 * ```
 */
export class CompositeHandler implements CacheHandler {
  public readonly name = "composite";

  private readonly handlers: CacheHandler[];
  private readonly setStrategy?: (data: CacheHandlerValue) => number;

  constructor(options: CompositeHandlerOptions) {
    if (!options.handlers || options.handlers.length === 0) {
      throw new Error("CompositeHandler requires at least one handler");
    }

    this.handlers = options.handlers;
    this.setStrategy = options.setStrategy;
  }

  async get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null> {
    // Try handlers in order, return first hit
    for (const handler of this.handlers) {
      try {
        const value = await handler.get(key, meta);
        if (value !== null) {
          return value;
        }
      } catch (error) {
        // Log error but continue to next handler
        console.error(`Handler ${handler.name} failed:`, error);
      }
    }

    return null;
  }

  async set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void> {
    // Build the full cache handler value for strategy function
    const now = Date.now();
    const cacheHandlerValue: CacheHandlerValue = {
      lastModified: now,
      lifespan: null, // Simplified - handlers will calculate their own
      tags: context?.tags ?? [],
      value,
    };

    // Determine which handler(s) to write to
    if (this.setStrategy) {
      const handlerIndex = this.setStrategy(cacheHandlerValue);
      if (handlerIndex >= 0 && handlerIndex < this.handlers.length) {
        await this.handlers[handlerIndex].set(key, value, context);
      }
    } else {
      // Default: write to all handlers with fault tolerance
      const results = await Promise.allSettled(
        this.handlers.map((handler) => handler.set(key, value, context)),
      );

      // Log failures but don't throw (fault tolerance)
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(`Handler ${this.handlers[index].name} set failed:`, result.reason);
        }
      });
    }
  }

  async revalidateTag(tag: string, profile?: string | { expire?: number }): Promise<void> {
    // Revalidate on all handlers in parallel with fault tolerance
    const results = await Promise.allSettled(
      this.handlers.map((handler) => handler.revalidateTag(tag, profile)),
    );

    // Log failures but don't throw
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Handler ${this.handlers[index].name} revalidateTag failed:`, result.reason);
      }
    });
  }

  async delete(key: string): Promise<void> {
    // Delete from all handlers that support it
    const deletePromises = this.handlers
      .filter((handler) => typeof handler.delete === "function")
      .map((handler) => handler.delete?.(key));

    const results = await Promise.allSettled(deletePromises);

    // Log failures but don't throw
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Handler ${this.handlers[index].name} delete failed:`, result.reason);
      }
    });
  }
}

/**
 * Create a composite cache handler instance
 *
 * @example
 * ```typescript
 * // Route based on tags
 * const handler = createCompositeHandler({
 *   handlers: [memoryHandler, redisHandler],
 *   setStrategy: (data) => {
 *     // Use memory for items tagged with "memory-cache"
 *     if (data.tags.includes("memory-cache")) {
 *       return 0; // memory handler
 *     }
 *     return 1; // redis handler
 *   }
 * });
 * ```
 */
export function createCompositeHandler(options: CompositeHandlerOptions): CompositeHandler {
  return new CompositeHandler(options);
}
