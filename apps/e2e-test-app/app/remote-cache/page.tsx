import { cacheTag } from "next/cache";

// Simulates a database query that returns a unique value
async function fetchDatabaseData(id: string) {
  "use cache: remote";
  cacheTag("db-query", `id:${id}`);

  // Simulate DB query delay
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Return unique value that should be cached
  const uniqueId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  return {
    id,
    uniqueId,
    timestamp,
    message: "This should be cached in remote cache",
  };
}

export default async function RemoteCachePage({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id || "default";
  const data = await fetchDatabaseData(id);

  return (
    <div>
      <h1>Remote Cache Test</h1>
      <div data-testid="remote-cache-content">
        <p>ID: {data.id}</p>
        <p>Unique ID: {data.uniqueId}</p>
        <p>Timestamp: {data.timestamp}</p>
        <p>{data.message}</p>
      </div>
      <p className="instruction">
        If caching works, the Unique ID and Timestamp should NOT change on page reload
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
