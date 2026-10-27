# Set it up with a coding agent

Paste this prompt into Claude Code, Cursor, Codex or another coding agent, from the root of your
Next.js app. It installs and configures the handler, then reports what it changed.

````text
Install and configure @mrjasonroy/cache-components-cache-handler in this Next.js app.
Docs: https://github.com/mrjasonroy/cache-components-cache-handler/tree/v<installed version>/docs
(the tag of the version you install in step 2; main if the tag is missing).

1. Check the versions.
   - Read the installed Next.js version (node_modules/next/package.json, else package.json).
     It must be 16.x. If it is not, stop and tell me.
   - Run `node --version`. It must be 22.3 or later. If it is not, stop and tell me.

2. Install the handler release with the same major.minor as Next.js, pinned exact, with this
   project's package manager. For Next 16.4.x:
     npm install --save-exact @mrjasonroy/cache-components-cache-handler@16.4
     pnpm add --save-exact @mrjasonroy/cache-components-cache-handler@16.4
     yarn add --exact @mrjasonroy/cache-components-cache-handler@16.4
     bun add --exact @mrjasonroy/cache-components-cache-handler@16.4
   Never save a ^ or ~ range: the 16.5 releases remove APIs.

3. Configure next.config (.mjs, .js or .ts):
   - Wrap the exported config: `export default withCache({ ...config, cacheComponents: true })`,
     importing `withCache` from "@mrjasonroy/cache-components-cache-handler". A config function
     can be wrapped as it is. `experimental.useCache` also works if the app already uses it.
   - Remove `cacheHandler`, `cacheHandlers` and `cacheMaxMemorySize` from the config:
     withCache sets them and throws if `cacheHandler` or `cacheHandlers` is already set.
   - If those pointed at handler files from this package (16.4.2) or from
     @neshca/cache-handler or @fortedigital/nextjs-cache-handler, follow docs/migrating.md and
     delete the old handler files.
   - Do not put connection settings in next.config. The handlers read them from the
     environment of the running app.

4. Work out the backing store from the app's env files and deployment config (.env*,
   Dockerfile, docker-compose, Kubernetes manifests, Terraform, the hosting platform's settings).
   Follow the matching path and do nothing else:
   - Nothing configured, or a single instance: no Redis. Everything stays in memory. Done.
   - REDIS_URL or VALKEY_URL: nothing to add. Done.
   - ELASTICACHE_ENDPOINT with ELASTICACHE_AUTH_TOKEN (Serverless or cluster mode disabled):
     nothing to add. Done.
   - ElastiCache with IAM (ELASTICACHE_IAM_USER) on Serverless or cluster mode disabled:
     install @smithy/signature-v4, @aws-crypto/sha256-js and @aws-sdk/credential-provider-node,
     and make sure ELASTICACHE_CACHE_NAME and a region (ELASTICACHE_REGION or AWS_REGION) are
     set. See "IAM authentication" in docs/redis.md.
   - ElastiCache with cluster mode enabled (a `clustercfg.` endpoint), Redis Cluster or
     Sentinel: write custom handler files with one shared ioredis client, as in
     docs/custom-handlers.md; for IAM there, follow "IAM on your own client" in docs/redis.md.
   If it is unclear which applies, ask me instead of guessing.

5. Do not use the deprecated API. These still work in 16.4.x but are removed in 16.5:
   createCacheHandler, createCacheConfig, createCacheConfigWithProfiles,
   createRedisDataCacheHandler, createMemoryDataCacheHandler, createIoredisAdapter,
   createCompositeHandler, CompositeHandler, createMemoryCacheHandler, MemoryCacheHandler,
   RedisCacheHandler#close(), the page handler's `redis` and `tagPrefix` options, and the
   helpers bufferToString, stringToBuffer, jsonReplacer, jsonReviver, isImplicitTag,
   calculateLifespan, isExpired and IMPLICIT_TAG_PREFIX. The current API is withCache, plus
   createPageCacheHandler, createRemoteCacheHandler, createLocalCacheHandler,
   attachElastiCacheIamAuth, flushCache, closeCache and setCacheLogger for custom setups.

6. Verify.
   - Run `next build`. It never connects to Redis, so it needs no Redis. Turning on
     cacheComponents can surface errors in routes that read request data outside a Suspense
     boundary. Report those to me with the routes named; do not rewrite pages to silence them.
   - If a Redis is reachable, run `REDIS_URL=<url> CACHE_DEBUG=1 next start`, load a cached page
     twice and check the log shows `[PageCache]: set ... redis` and then
     `[PageCache]: get ... hit` (a prerendered page's first read logs `build output`). Check
     `redis-cli --scan --pattern 'nextjs:*'` lists keys.

7. Tell me what you changed: the files, the package and version installed, the path you chose
   in step 4 and why, and anything you could not verify.
````

The steps follow [Installation](./installation.md), [Redis Configuration](./redis.md) and
[Migrating](./migrating.md). The agent reads the docs at the tag of the version it installs.
