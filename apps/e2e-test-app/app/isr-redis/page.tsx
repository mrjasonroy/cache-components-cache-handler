import { cacheLife, cacheTag } from "next/cache";

// Stored by the ISR cacheHandler (RedisCacheHandler under CACHE_HANDLER=redis)
// with a revalidate period, so it can be served stale. Used only by
// isr-redis-handler.spec.ts, which revalidates it from another process.
export default async function IsrRedisPage() {
  "use cache";
  cacheLife({ stale: 60, revalidate: 60, expire: 3600 });
  cacheTag("isr-redis");

  return (
    <div>
      <h1>ISR Redis handler</h1>
      <p data-testid="rendered-at">{new Date().toISOString()}</p>
    </div>
  );
}
