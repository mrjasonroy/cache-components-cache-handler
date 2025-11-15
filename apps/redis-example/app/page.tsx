import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

// Cached function - demonstrates "use cache" directive
async function getCachedData() {
  "use cache";
  cacheLife("minutes"); // Cache for 15 minutes
  cacheTag("homepage-data");

  // Simulate slow database query
  await new Promise((resolve) => setTimeout(resolve, 1000));

  return {
    message: "This data is cached in Redis!",
    timestamp: new Date().toISOString(),
    randomNumber: Math.random(),
  };
}

export default async function HomePage() {
  const data = await getCachedData();

  return (
    <div>
      <h1>Redis Cache Example</h1>

      <div
        style={{ background: "#f0f0f0", padding: "1rem", margin: "1rem 0", borderRadius: "4px" }}
      >
        <h2>Cached Data:</h2>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </div>

      <div
        style={{ background: "#e3f2fd", padding: "1rem", margin: "1rem 0", borderRadius: "4px" }}
      >
        <h3>📝 What's happening:</h3>
        <ul>
          <li>
            <strong>First request:</strong> Waits 1 second (simulated DB query) then caches in Redis
          </li>
          <li>
            <strong>Subsequent requests:</strong> Returns instantly from Redis cache
          </li>
          <li>
            <strong>Cache location:</strong> Redis at <code>example:cache:*</code>
          </li>
          <li>
            <strong>Cache lifetime:</strong> 15 minutes
          </li>
          <li>
            <strong>Cache tags:</strong> <code>homepage-data</code>
          </li>
        </ul>
      </div>

      <div
        style={{ background: "#fff3cd", padding: "1rem", margin: "1rem 0", borderRadius: "4px" }}
      >
        <h3>🔄 Try this:</h3>
        <ol>
          <li>Refresh this page multiple times - notice the timestamp doesn't change</li>
          <li>
            Check Redis:{" "}
            <code>docker exec -it redis-example-redis-1 redis-cli KEYS "example:*"</code>
          </li>
          <li>
            Clear cache: <code>docker exec -it redis-example-redis-1 redis-cli FLUSHDB</code>
          </li>
          <li>Refresh again - timestamp updates (cache was rebuilt)</li>
        </ol>
      </div>

      <div>
        <h3>More Examples:</h3>
        <ul>
          <li>
            <Link href="/products">Products Page (with tag revalidation)</Link>
          </li>
        </ul>
      </div>

      <div
        style={{ marginTop: "2rem", padding: "1rem", background: "#f9f9f9", borderRadius: "4px" }}
      >
        <p>
          <strong>💡 Note:</strong> During <code>next build</code>, this page is pre-rendered and
          the cache is populated. When you <code>next start</code>, the cached data is served from
          Redis!
        </p>
      </div>
    </div>
  );
}
