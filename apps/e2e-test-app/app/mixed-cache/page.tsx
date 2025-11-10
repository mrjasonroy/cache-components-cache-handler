import { cacheTag } from "next/cache";
import { Suspense } from "react";

// Layout component - uses default cache (5s)
async function getLayoutData(testId: string) {
  "use cache";
  cacheTag("layout");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  return {
    layoutId: testId,
    timestamp: Date.now(),
  };
}

// Remote data - user stats from DB (8s)
async function getUserStats(testId: string) {
  "use cache: remote";
  cacheTag("stats");

  await new Promise((resolve) => setTimeout(resolve, 3000));

  return {
    statsId: testId,
    totalOrders: Math.floor(Math.random() * 1000),
    timestamp: Date.now(),
  };
}

// Remote data - recent orders from DB (8s)
async function getRecentOrders(testId: string) {
  "use cache: remote";
  cacheTag("orders");

  await new Promise((resolve) => setTimeout(resolve, 3000));

  return {
    ordersId: testId,
    count: Math.floor(Math.random() * 50),
    timestamp: Date.now(),
  };
}

// Dynamic content component that awaits searchParams
async function DynamicContent({
  searchParams,
}: {
  searchParams: Promise<{
    layoutId?: string;
    statsId?: string;
    ordersId?: string;
  }>;
}) {
  // Await searchParams in the child component
  const params = await searchParams;
  const layoutId = params.layoutId || `gen-layout-${Date.now()}`;
  const statsId = params.statsId || `gen-stats-${Date.now()}`;
  const ordersId = params.ordersId || `gen-orders-${Date.now()}`;

  // These run in parallel - total time is max(5s, 8s, 8s) = 8s
  const [layout, stats, orders] = await Promise.all([
    getLayoutData(layoutId),
    getUserStats(statsId),
    getRecentOrders(ordersId),
  ]);

  return (
    <>
      <div data-testid="layout-section">
        <h2>Layout (Default Cache)</h2>
        <p data-testid="layout-id">Layout ID: {layout.layoutId}</p>
        <p>Timestamp: {layout.timestamp}</p>
      </div>

      <div data-testid="stats-section">
        <h2>User Stats (Remote Cache)</h2>
        <p data-testid="stats-id">Stats ID: {stats.statsId}</p>
        <p>Total Orders: {stats.totalOrders}</p>
        <p>Timestamp: {stats.timestamp}</p>
      </div>

      <div data-testid="orders-section">
        <h2>Recent Orders (Remote Cache)</h2>
        <p data-testid="orders-id">Orders ID: {orders.ordersId}</p>
        <p>Count: {orders.count}</p>
        <p>Timestamp: {orders.timestamp}</p>
      </div>
    </>
  );
}

function LoadingSkeleton() {
  return <div data-testid="loading">Loading mixed cache data...</div>;
}

export default function MixedCachePage({
  searchParams,
}: {
  searchParams: Promise<{
    layoutId?: string;
    statsId?: string;
    ordersId?: string;
  }>;
}) {
  // Don't await searchParams here - pass the Promise down
  return (
    <div>
      <h1>Mixed Cache Test: Default (Layout) + Remote (Data)</h1>

      <Suspense fallback={<LoadingSkeleton />}>
        <DynamicContent searchParams={searchParams} />
      </Suspense>

      <p className="instruction">
        First load: ~8s (parallel). All cached: &lt;1s. Revalidate one tag: only that section
        refetches.
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
