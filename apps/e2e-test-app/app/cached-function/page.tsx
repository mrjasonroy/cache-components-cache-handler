import { getCachedData } from "@/lib/cached-function";

// E2E-003: use cache in async utility function

export default async function Page({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id || "default";

  const data1 = await getCachedData(id);
  const data2 = await getCachedData(id); // Should return same cached result

  return (
    <div>
      <h1>E2E-003: Cached Function Test</h1>
      <div data-testid="cached-function-content">
        <p>ID: {id}</p>

        <h3>First Call:</h3>
        <p>Timestamp: {data1.timestamp}</p>
        <p>Random: {data1.randomValue}</p>

        <h3>Second Call (should be same):</h3>
        <p>Timestamp: {data2.timestamp}</p>
        <p>Random: {data2.randomValue}</p>

        <p data-testid="values-match">
          Values match: {data1.timestamp === data2.timestamp ? "YES" : "NO"}
        </p>
      </div>
      <a href="/">Back to home</a>
    </div>
  );
}
