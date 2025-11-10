# Critical Code Patterns from Old Implementation

This document highlights key patterns and code snippets that MUST be replicated in the new implementation.

## 1. Handler Interface & Type Definitions

### Core Handler Type (from cache-handler.types.ts)
```typescript
export type Handler = {
  name: string;
  get(key: string, meta: HandlerGetMeta): Promise<CacheHandlerValue | null | undefined>;
  set(key: string, value: CacheHandlerValue): Promise<void>;
  revalidateTag(tag: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type HandlerGetMeta = {
  implicitTags: string[];
};

export type CacheHandlerValue = {
  lastModified: number;
  lifespan: LifespanParameters | null;
  tags: Readonly<string[]>;
  value: IncrementalCacheValue;
};

export type LifespanParameters = {
  lastModifiedAt: number;  // seconds
  staleAt: number;  // seconds
  expireAt: number;  // seconds
  staleAge: number;  // seconds
  expireAge: number;  // seconds
  revalidate: Revalidate | undefined;
};
```

## 2. Timeout Pattern with AbortSignal

### Pattern: Every Redis operation uses timeout (from redis-strings.ts)
```typescript
// With timeout
const result = await client
  .withAbortSignal(AbortSignal.timeout(timeoutMs))
  .get(keyPrefix + key);

// Multiple parallel operations
await Promise.all([
  operation1.withAbortSignal(AbortSignal.timeout(timeoutMs)),
  operation2.withAbortSignal(AbortSignal.timeout(timeoutMs)),
]);
```

### withAbortSignal Helper Implementation
```typescript
export function withAbortSignal<T>(
  promiseFn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promiseFn();

  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      return reject(new Error("Aborted"));
    }

    let settled = false;

    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Operation aborted"));
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promiseFn()
      .then((res) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(res);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      });
  });
}
```

### withAbortSignalProxy Pattern
```typescript
export function withAbortSignalProxy<T extends object>(
  obj: T,
  defaultSignal?: AbortSignal,
): WithAbortSignalProxy<T> {
  function createProxy(signal?: AbortSignal): WithAbortSignalProxy<T> {
    const handler: ProxyHandler<T> = {
      get(target, prop, receiver) {
        if (prop === "withAbortSignal") {
          return (s: AbortSignal) => createProxy(s);
        }

        const orig = Reflect.get(target, prop, receiver);
        if (typeof orig !== "function") return orig;

        return (...args: unknown[]) =>
          withAbortSignal(() => orig.apply(receiver, args), signal);
      },
    };

    return new Proxy(obj, handler) as WithAbortSignalProxy<T>;
  }

  return createProxy(defaultSignal);
}
```

## 3. Cursor-Based Iteration Pattern (Prevents Memory Leaks)

### Pattern: HSCAN with cursor for large tag maps
```typescript
async function revalidateTag(tag: string) {
  const tagsMap: Map<string, string[]> = new Map();
  let cursor = "0";
  const hScanOptions = { COUNT: revalidateTagQuerySize };

  do {
    const remoteTagsPortion = await client
      .withAbortSignal(AbortSignal.timeout(timeoutMs))
      .hScan(keyPrefix + sharedTagsKey, cursor, hScanOptions);

    for (const { field, value } of remoteTagsPortion.entries) {
      tagsMap.set(field, JSON.parse(value));
    }

    cursor = remoteTagsPortion.cursor;
  } while (cursor !== "0");

  // Process all collected entries...
}
```

## 4. Multi-Handler Fault Tolerance Pattern

### Pattern: Promise.allSettled for handlers
```typescript
// In merged handler for set operation
const operationsResults = await Promise.allSettled(
  handlersList.map((handler) => handler.set(key, cacheValue)),
);

// Log results but don't fail
operationsResults.forEach((handlerResult, index) => {
  if (handlerResult.status === "rejected") {
    console.warn(
      "[CacheHandler] [handler: %s] Error: %s",
      handlersList[index]?.name,
      handlerResult.reason,
    );
  }
});
```

### Pattern: Sequential get (first match)
```typescript
async get(key: string, meta: HandlerGetMeta) {
  for (const handler of handlersList) {
    try {
      const cacheValue = await handler.get(key, meta);
      if (cacheValue) {
        return cacheValue;
      }
    } catch (error) {
      console.warn(`Handler ${handler.name} failed:`, error);
      // Continue to next handler
    }
  }
  return null;
}
```

## 5. Buffer/String Conversion Pattern (Next.js 15+)

### Pattern: APP_ROUTE conversion
```typescript
export function parseBuffersToStrings(cacheHandlerValue: CacheHandlerValue) {
  const value = cacheHandlerValue.value;
  if (value?.kind === "APP_ROUTE") {
    const appRouteData = value as unknown as RedisCompliantCachedRouteValue;
    const appRouteValue = value as unknown as CachedRouteValue;

    if (appRouteValue?.body) {
      // Convert Buffer to base64 string for Redis storage
      appRouteData.body = appRouteValue.body.toString("base64");
    }
  }
  // Similar for APP_PAGE...
}

export function convertStringsToBuffers(cacheValue: CacheHandlerValue) {
  const value = cacheValue.value;
  if (value?.kind === "APP_ROUTE") {
    const appRouteData = value as unknown as RedisCompliantCachedRouteValue;
    const appRouteValue = value as unknown as CachedRouteValue;

    if (appRouteData?.body) {
      // Convert base64 string back to Buffer for Next.js
      appRouteValue.body = Buffer.from(appRouteData.body, "base64");
    }
  }
}
```

## 6. Implicit Tag Tracking Pattern

### Pattern: Separate storage for implicit vs explicit tags
```typescript
// Implicit tags stored with millisecond timestamp
if (isImplicitTag(tag)) {
  await client
    .withAbortSignal(AbortSignal.timeout(timeoutMs))
    .hSet(revalidatedTagsKey, tag, Date.now());
}

// On get, check if ANY tag was revalidated after lastModified
const revalidationTimes = await client
  .withAbortSignal(AbortSignal.timeout(timeoutMs))
  .hmGet(revalidatedTagsKey, Array.from(combinedTags));

for (const timeString of revalidationTimes) {
  if (timeString && Number.parseInt(timeString, 10) > cacheValue.lastModified) {
    // Entry was invalidated, delete it
    await client.unlink(keyPrefix + key);
    return null;
  }
}
```

## 7. Tag Extraction Pattern

### Pattern: Extract from headers or context
```typescript
export function getTagsFromHeaders(headers: OutgoingHttpHeaders): string[] {
  const tagsHeader = headers["x-next-cache-tags"];

  if (Array.isArray(tagsHeader)) {
    return tagsHeader;
  }

  if (typeof tagsHeader === "string") {
    return tagsHeader.split(",");
  }

  return [];
}
```

## 8. TTL Calculation Pattern

### Pattern: Lifespan parameters from revalidate
```typescript
static #getLifespanParameters(
  lastModified: number,
  revalidate?: Revalidate,
): LifespanParameters {
  const lastModifiedAt = Math.floor(lastModified / 1000);  // Convert to seconds
  const staleAge = revalidate || CacheHandler.#defaultStaleAge;
  const staleAt = lastModifiedAt + staleAge;
  const expireAge = CacheHandler.#estimateExpireAge(staleAge);  // 1.5x multiplier
  const expireAt = lastModifiedAt + expireAge;

  return {
    expireAge,
    expireAt,
    lastModifiedAt,
    revalidate,
    staleAge,
    staleAt,
  };
}
```

### Pattern: Validated age estimation
```typescript
export function createValidatedAgeEstimationFunction(
  callback = getInitialExpireAge,
): (staleAge: number) => number {
  return function estimateExpireAge(staleAge: number): number {
    const rawExpireAge = callback(staleAge);
    const expireAge = Math.min(Math.floor(rawExpireAge), MAX_INT32);

    assert(
      Number.isInteger(expireAge) && expireAge > 0,
      `The expire age must be a positive integer but got ${expireAge}.`,
    );

    return expireAge;
  };
}
```

## 9. Expiration Check Pattern

### Pattern: Check expireAt on get (times in SECONDS)
```typescript
if (
  cacheHandlerValue?.lifespan &&
  cacheHandlerValue.lifespan.expireAt < Math.floor(Date.now() / 1000)
) {
  // Entry is expired, delete and return null
  cacheHandlerValue = null;
  
  // Delete in background (non-blocking)
  removeEntryFromHandlers(handlersList, key, CacheHandler.#debug);
}
```

## 10. LRU Handler Revalidation Pattern

### Pattern: In-memory tag timestamp tracking
```typescript
export default function createHandler(options: LruCacheOptions): Handler {
  const lruCacheStore = createConfiguredCache<CacheHandlerValue>(...);
  const revalidatedTags = new Map<string, number>();

  return {
    get(key, { implicitTags }) {
      const cacheValue = lruCacheStore.get(key);
      if (!cacheValue) return Promise.resolve(null);

      const combinedTags = new Set([...cacheValue.tags, ...implicitTags]);

      // Check each tag against revalidation times
      for (const tag of combinedTags) {
        const revalidationTime = revalidatedTags.get(tag);
        if (revalidationTime && revalidationTime > cacheValue.lastModified) {
          lruCacheStore.delete(key);
          return Promise.resolve(null);
        }
      }

      return Promise.resolve(cacheValue);
    },

    revalidateTag(tag) {
      // Track revalidation time
      if (tag.startsWith(NEXT_CACHE_IMPLICIT_TAG_ID)) {
        revalidatedTags.set(tag, Date.now());
      }

      // Delete all entries with this tag
      for (const [key, { tags }] of lruCacheStore.entries()) {
        if (tags.includes(tag)) {
          lruCacheStore.delete(key);
        }
      }

      return Promise.resolve();
    },
  };
}
```

## 11. Composite Handler Pattern

### Pattern: First-match read, strategy-based write
```typescript
export default function createHandler({
  handlers,
  setStrategy: strategy,
}: CreateCompositeHandlerOptions): Handler {
  if (handlers?.length < 2) {
    throw new Error("Composite requires at least two handlers");
  }

  return {
    name: "composite",

    // Read: try each handler in order until one succeeds
    async get(key, ctx) {
      for (const handler of handlers) {
        const value = await handler.get(key, ctx);
        if (value !== null) {
          return value;
        }
      }
      return null;
    },

    // Write: use strategy to pick handler
    async set(key, data) {
      const index = strategy?.(data) ?? 0;
      const handler = handlers[index] ?? handlers[0]!;
      await handler.set(key, data);
    },

    // Revalidate: all handlers
    async revalidateTag(tag) {
      await Promise.all(handlers.map((h) => h.revalidateTag(tag)));
    },

    // Delete: all handlers
    async delete(key) {
      await Promise.all(handlers.map((h) => h.delete?.(key)));
    },
  };
}
```

## 12. Debug Logging Pattern

### Pattern: Conditional debug output
```typescript
const debug = typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== "undefined";

if (debug) {
  console.info(
    "[CacheHandler] [handler: %s] [method: %s] [key: %s] %s",
    handler.name,
    "get",
    key,
    "Started retrieving value.",
  );
}

// ... operation ...

if (debug) {
  console.info(
    "[CacheHandler] [handler: %s] [method: %s] [key: %s] %s",
    handler.name,
    "get",
    key,
    "Successfully retrieved value.",
  );
} else if (error) {
  console.warn(
    "[CacheHandler] [handler: %s] [method: %s] [key: %s] %s",
    handler.name,
    "get",
    key,
    `Error: ${error}`,
  );
}
```

## 13. Redis Cluster Adapter Pattern

### Pattern: Wrap cluster with isReady property
```typescript
export function withAdapter<T extends RedisClusterType>(
  cluster: RedisClusterType,
): RedisClusterCacheAdapter {
  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      if (prop === "isReady") {
        return cluster.replicas.every((s) => s.client?.isReady);
      }
      return Reflect.get(target, prop, receiver);
    },
  };

  return new Proxy(cluster, handler) as RedisClusterCacheAdapter;
}
```

## 14. onCreation Hook Pattern

### Pattern: CacheHandler singleton with lazy initialization
```typescript
export class CacheHandler implements NextCacheHandler {
  static #onCreationHook: OnCreationHook;
  static #mergedHandler: Omit<Handler, "name">;

  static onCreation(onCreationHook: OnCreationHook): void {
    CacheHandler.#onCreationHook = onCreationHook;
  }

  static async #configureCacheHandler(): Promise<void> {
    if (CacheHandler.#mergedHandler) {
      return; // Already configured
    }

    const config = await CacheHandler.#onCreationHook({
      serverDistDir: CacheHandler.#context.serverDistDir,
      dev: CacheHandler.#context.dev,
      buildId,
    });

    const handlersList = config.handlers.filter((h) => !!h);
    // Merge handlers into single #mergedHandler
  }

  constructor(context: FileSystemCacheContext) {
    CacheHandler.#context = context;
  }

  async get(key: string, ctx?: any): Promise<CacheHandlerValue | null> {
    await CacheHandler.#configureCacheHandler();
    return CacheHandler.#mergedHandler.get(key, { implicitTags: ctx?.softTags ?? [] });
  }
}
```

## 15. Redis Set Operations Pattern

### Pattern: Batch operations with parallel execution
```typescript
// On set: parallel operations for tags and TTL
const setTagsOperation = client
  .withAbortSignal(AbortSignal.timeout(timeoutMs))
  .hSet(keyPrefix + sharedTagsKey, key, JSON.stringify(tags));

const setSharedTtlOperation = lifespan
  ? client
      .withAbortSignal(AbortSignal.timeout(timeoutMs))
      .hSet(keyPrefix + sharedTagsTtlKey, key, lifespan.expireAt)
  : undefined;

await Promise.all([setTagsOperation, setSharedTtlOperation]);

// Then set the actual cache value
const setOperation = client
  .withAbortSignal(AbortSignal.timeout(timeoutMs))
  .set(keyPrefix + key, JSON.stringify(cacheHandlerValue), {
    EXAT: lifespan?.expireAt,
  });

await setOperation;
```

## Critical Rules to Follow

1. **Always validate expireAt in SECONDS**: `Math.floor(Date.now() / 1000)`
2. **Always use AbortSignal.timeout() for Redis**: No exceptions
3. **Always use Promise.allSettled() for multiple handlers**: Fault tolerance is critical
4. **Always handle Buffer conversion**: Both directions (to/from Redis)
5. **Always track implicit tags separately**: Different revalidation logic
6. **Always clean up event listeners**: Memory leak prevention in loops
7. **Always use cursor-based HSCAN**: Prevents Redis memory issues
8. **Always check isReady before operations**: Connection safety
9. **Always log errors at production level**: Essential for debugging
10. **Always run revalidateTag + revalidateSharedKeys**: Complete cache cleanup

