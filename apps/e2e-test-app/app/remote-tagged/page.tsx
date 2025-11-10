import { cacheTag } from "next/cache";

// Function with explicit cache tags for testing revalidation
async function getTaggedRemoteData(tag: string, id: string) {
  "use cache: remote";
  cacheTag(tag, `id:${id}`);

  // Simulate data fetching
  await new Promise((resolve) => setTimeout(resolve, 50));

  const uniqueValue = `${tag}-${Math.random().toString(36).substring(7)}`;
  const timestamp = Date.now();

  return {
    id,
    tag,
    uniqueValue,
    timestamp,
    formatted: new Date(timestamp).toISOString(),
  };
}

export default async function RemoteTaggedPage({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id || "default";

  const data1 = await getTaggedRemoteData("product", id);
  const data2 = await getTaggedRemoteData("user", id);

  return (
    <div>
      <h1>Remote Cache with Tags</h1>
      <p>ID: {id}</p>

      <div data-testid="product-data">
        <h2>Product Data (tag: product)</h2>
        <p>Unique Value: {data1.uniqueValue}</p>
        <p>Timestamp: {data1.timestamp}</p>
        <p>Formatted: {data1.formatted}</p>
      </div>

      <div data-testid="user-data">
        <h2>User Data (tag: user)</h2>
        <p>Unique Value: {data2.uniqueValue}</p>
        <p>Timestamp: {data2.timestamp}</p>
        <p>Formatted: {data2.formatted}</p>
      </div>

      <div className="actions">
        <button type="button" data-testid="revalidate-product">
          Revalidate Product
        </button>
        <button type="button" data-testid="revalidate-user">
          Revalidate User
        </button>
      </div>

      <p className="instruction">
        Values should be cached. After revalidating a tag, only that tag's data should change.
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
