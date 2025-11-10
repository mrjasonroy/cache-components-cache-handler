# Redis Configuration

## Basic Setup

```javascript
import { createClient } from "redis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

await redis.connect();

export default createRedisDataCacheHandler({
  redis,
});
```

## Connection Options

### URL Format

```javascript
const redis = createClient({
  url: "redis://username:password@host:port/db",
});
```

### Object Configuration

```javascript
const redis = createClient({
  socket: {
    host: "localhost",
    port: 6379,
  },
  password: "your-password",
  database: 0,
});
```

## TLS/SSL

```javascript
const redis = createClient({
  url: "rediss://host:port", // Note the 'rediss://' protocol
  socket: {
    tls: true,
    rejectUnauthorized: false, // For self-signed certificates
  },
});
```

## Error Handling

```javascript
const redis = createClient({ url: process.env.REDIS_URL });

redis.on("error", (err) => {
  console.error("Redis Client Error", err);
});

redis.on("connect", () => {
  console.log("Redis Client Connected");
});

redis.on("ready", () => {
  console.log("Redis Client Ready");
});

await redis.connect();
```

## Cache Handler Options

```javascript
export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "myapp:cache:",      // Namespace your keys
  tagPrefix: "myapp:tags:",        // Namespace your tags
  defaultTTL: 86400,               // 24 hours in seconds
  debug: process.env.NODE_ENV === "development",
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

The `redis` client handles connection pooling automatically.

### Sentinel

For high availability:

```javascript
import { createClient } from "redis";

const redis = createClient({
  sentinels: [
    { host: "sentinel-1", port: 26379 },
    { host: "sentinel-2", port: 26379 },
  ],
  name: "mymaster",
});
```

### Cluster

For horizontal scaling:

```javascript
import { createCluster } from "redis";

const redis = createCluster({
  rootNodes: [
    { url: "redis://node1:6379" },
    { url: "redis://node2:6379" },
    { url: "redis://node3:6379" },
  ],
});
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

```javascript
const redis = createClient({
  socket: {
    host: "your-cluster.cache.amazonaws.com",
    port: 6379,
  },
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
