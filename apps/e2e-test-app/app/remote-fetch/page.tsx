import { cacheTag } from "next/cache";

// Simulates fetching data from external API with remote caching
async function fetchExternalAPI(id: string) {
  "use cache: remote";
  cacheTag("api-fetch", `id:${id}`);

  // Simulate API call delay
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Generate unique value to verify caching
  const randomValue = Math.random();
  const fetchTime = Date.now();

  return {
    id,
    randomValue,
    fetchTime,
    formattedTime: new Date(fetchTime).toISOString(),
  };
}

export default async function RemoteFetchPage({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id || "default";
  const data = await fetchExternalAPI(id);

  return (
    <div>
      <h1>Remote Cache - Fetch Function Test</h1>
      <div data-testid="remote-fetch-content">
        <p>ID: {data.id}</p>
        <p>Random Value: {data.randomValue}</p>
        <p>Fetch Time: {data.fetchTime}</p>
        <p>Formatted: {data.formattedTime}</p>
      </div>
      <p className="instruction">
        Random Value should stay the same across reloads (proving cache hit)
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
