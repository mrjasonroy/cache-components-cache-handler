import { cacheLife, cacheTag } from "next/cache";

/**
 * A fully static page body for the page-handler specs. It has no request data, so the route is
 * prerendered and served through `cacheHandler` (APP_PAGE). The stamp is new on every render, so
 * an unchanged stamp means the response came from the cache and a new one means it re-rendered.
 * Each spec gets its own route, so revalidating one never disturbs another.
 */
export async function StampPage({ name }: { name: string }) {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag(`e2e-page-${name}`);

  const stamp = `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  return (
    <main>
      <h1>Page handler: {name}</h1>
      <p data-testid="stamp">{stamp}</p>
    </main>
  );
}
