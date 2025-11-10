import { cacheTag } from "next/cache";
import { Suspense } from "react";

// Simulates a slow database query (10 seconds)
// Uses stable ID passed via function parameter
async function getTopUserFromDB(testId: string) {
  "use cache: remote";
  cacheTag("top-user");

  // Simulate slow DB query
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Use stable ID for verification, timestamp for cache detection
  const timestamp = Date.now();

  return {
    userId: testId,
    name: `User-${testId}`,
    timestamp,
    source: "database",
    fetchedAt: new Date(timestamp).toISOString(),
  };
}

// Dynamic content component that awaits searchParams
async function DynamicContent({
  searchParams,
}: {
  searchParams: Promise<{ testId?: string }>;
}) {
  // Await searchParams in the child component
  const params = await searchParams;
  const testId = params.testId || `default-${Date.now()}`;
  const user = await getTopUserFromDB(testId);

  return (
    <div data-testid="db-content">
      <p data-testid="user-id">User ID: {user.userId}</p>
      <p>Name: {user.name}</p>
      <p data-testid="timestamp">Timestamp: {user.timestamp}</p>
      <p>Fetched At: {user.fetchedAt}</p>
      <p>Source: {user.source}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return <div data-testid="loading">Loading database query...</div>;
}

export default function SlowDBPage({
  searchParams,
}: {
  searchParams: Promise<{ testId?: string }>;
}) {
  // Don't await searchParams here - pass the Promise down
  return (
    <div>
      <h1>Slow Database Query Test</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <DynamicContent searchParams={searchParams} />
      </Suspense>
      <p className="instruction">
        First load takes 3+ seconds (DB query). Reload should be instant (&lt; 1s) if cached.
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
