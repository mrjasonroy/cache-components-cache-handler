// E2E-002: use cache in page component

async function CachedPageContent({ id }: { id: string }) {
  "use cache";

  await new Promise((resolve) => setTimeout(resolve, 100));

  const timestamp = new Date().toISOString();

  return (
    <div data-testid="cached-page-content">
      <p>ID: {id}</p>
      <p>Page Timestamp: {timestamp}</p>
      <p>This entire page is cached</p>
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
      <h1>E2E-002: Cached Page Test</h1>
      <CachedPageContent id={id} />
      <a href="/">Back to home</a>
    </div>
  );
}
