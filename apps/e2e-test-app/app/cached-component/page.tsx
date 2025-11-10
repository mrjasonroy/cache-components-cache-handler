// E2E-001: use cache in async Server Component

async function CachedComponent({ id }: { id: string }) {
  "use cache";

  // Simulate async data fetching
  await new Promise((resolve) => setTimeout(resolve, 100));

  const timestamp = new Date().toISOString();

  return (
    <div data-testid="cached-content">
      <h2>Cached Component</h2>
      <p>ID: {id}</p>
      <p>Timestamp: {timestamp}</p>
      <p>This timestamp should remain the same across page refreshes</p>
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id || "default";

  return (
    <div>
      <h1>E2E-001: Cached Component Test</h1>
      <CachedComponent id={id} />
      <a href="/">Back to home</a>
    </div>
  );
}
