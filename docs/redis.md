# Redis Configuration

Install a Redis client as a peer dependency:

```bash
npm install ioredis
# or, if you prefer node-redis:
npm install redis
```

## Which client and how to pass it

`createRedisDataCacheHandler` expects a **node-redis-style** `RedisClient` — its
`set()` takes options as an object (`set(key, value, { EX: seconds })`).

- **node-redis** (`redis`) speaks this natively — pass the client directly.
- **ioredis** uses positional args (`set(key, value, "EX", seconds)`), so wrap it
  with `createIoredisAdapter()`. Passing a raw ioredis client will make Redis
  reject writes with `ERR syntax error` and silently break TTLs.

The zero-config `createCacheHandler({ type: "redis" })` uses ioredis internally
and applies this adapter for you.

## Basic Setup (for "use cache" directive)

Using **ioredis** (wrap with `createIoredisAdapter`):

```javascript
// data-cache-handler.mjs
import Redis from "ioredis";
import {
  createRedisDataCacheHandler,
  createIoredisAdapter,
} from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

export default createRedisDataCacheHandler({
  redis: createIoredisAdapter(redis),
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
});
```

Using **node-redis** (pass the client directly):

```javascript
// data-cache-handler.mjs
import { createClient } from "redis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
await redis.connect();

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
});
```

```javascript
// next.config.js
export default {
  cacheComponents: true,
  cacheHandlers: {
    default: "./data-cache-handler.mjs",
  },
};
```

## Connection Options

### URL Format (Recommended)

```javascript
const redis = new Redis(process.env.REDIS_URL);
// Examples:
// redis://localhost:6379
// redis://:password@host:6379/0
// rediss://host:6380 (TLS)
```

### Object Configuration

```javascript
const redis = new Redis({
  host: "localhost",
  port: 6379,
  password: "your-password",
  db: 0,
});
```

## TLS/SSL

```javascript
const redis = new Redis({
  host: "your-host.com",
  port: 6380,
  tls: {
    rejectUnauthorized: false, // For self-signed certs
  },
});
```

Or use `rediss://` protocol:

```javascript
const redis = new Redis("rediss://your-host.com:6380");
```

## Error Handling

```javascript
const redis = new Redis(process.env.REDIS_URL);

redis.on("error", (err) => {
  console.error("Redis Error:", err);
});

redis.on("connect", () => {
  console.log("Redis Connected");
});

redis.on("ready", () => {
  console.log("Redis Ready");
});
```

## Handler Options

```javascript
export default createRedisDataCacheHandler({
  redis,                          // node-redis client, or createIoredisAdapter(ioredisClient)
  keyPrefix: "myapp:cache:",      // Namespace for cache keys
  tagPrefix: "myapp:tags:",       // Namespace for cache tags
  defaultTTL: 86400,              // Default TTL in seconds (24 hours)
  debug: false,                   // Enable debug logging
});
```

## Local Development with Docker

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

Or use docker-compose.yml:

```yaml
version: "3"
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

Start:

```bash
docker compose up -d
```

## Production Considerations

### Connection Pooling

`ioredis` handles connection pooling automatically. No additional configuration needed.

### Redis Sentinel (High Availability)

For automatic failover, configure ioredis and wrap it with `createIoredisAdapter`:

```javascript
import Redis from "ioredis";
import {
  createRedisDataCacheHandler,
  createIoredisAdapter,
} from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis({
  sentinels: [
    { host: "sentinel-1", port: 26379 },
    { host: "sentinel-2", port: 26379 },
    { host: "sentinel-3", port: 26379 },
  ],
  name: "mymaster",
});

export default createRedisDataCacheHandler({ redis: createIoredisAdapter(redis) });
```

### Redis Cluster (Horizontal Scaling)

For distributed deployments (`Cluster` also satisfies `createIoredisAdapter`):

```javascript
import { Cluster } from "ioredis";
import {
  createRedisDataCacheHandler,
  createIoredisAdapter,
} from "@mrjasonroy/cache-components-cache-handler";

const redis = new Cluster([
  { host: "node1", port: 6379 },
  { host: "node2", port: 6379 },
  { host: "node3", port: 6379 },
]);

export default createRedisDataCacheHandler({ redis: createIoredisAdapter(redis) });
```

### Key Expiration

Keys are automatically expired based on cache lifetime settings. Monitor Redis memory usage.

### Monitoring

```bash
# Redis CLI
redis-cli info memory
redis-cli info stats

# Check cache keys
redis-cli --scan --pattern "myapp:cache:*" | wc -l

# Check tag keys
redis-cli --scan --pattern "myapp:tags:*" | wc -l
```

## AWS ElastiCache

For ElastiCache you typically get a hostname + token instead of a URI. Use the zero-config factory and let it wire TLS/passwords for you:

```javascript
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "elasticache",
  endpoint: process.env.ELASTICACHE_ENDPOINT,
  port: Number(process.env.ELASTICACHE_PORT ?? 6379),
  tls: process.env.ELASTICACHE_TLS !== "false",
  password: process.env.ELASTICACHE_AUTH_TOKEN ?? process.env.REDIS_PASSWORD,
  keyPrefix: "prod:cache:",
  tagPrefix: "prod:tags:",
});
```

## Valkey

Valkey is a Redis-compatible open source fork. Switch the `type` to `"valkey"` (or set `CACHE_BACKEND=valkey`) and point at your cluster URL:

```javascript
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "valkey",
  url: process.env.VALKEY_URL ?? "redis://valkey.internal:6379",
  password: process.env.REDIS_PASSWORD,
});
```

## Upstash

```javascript
const redis = createClient({
  url: process.env.UPSTASH_REDIS_REST_URL,
  password: process.env.UPSTASH_REDIS_REST_TOKEN,
  socket: {
    tls: true,
  },
});
```

## Vercel KV (Upstash-based)

```javascript
const redis = createClient({
  url: process.env.KV_URL,
  token: process.env.KV_REST_API_TOKEN,
  socket: {
    tls: true,
  },
});
```
