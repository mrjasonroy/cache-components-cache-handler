import { cacheTag } from "next/cache";
import { Suspense } from "react";

// Product layout - default cache (4s)
async function getProductLayout(testId: string) {
  "use cache";
  cacheTag("product-layout");

  await new Promise((resolve) => setTimeout(resolve, 4000));

  return {
    layoutId: testId,
    theme: `product-theme-${testId}`,
    timestamp: Date.now(),
  };
}

// Product list - remote cache (4s DB query)
async function getProductList(testId: string) {
  "use cache: remote";
  cacheTag("product-list");

  await new Promise((resolve) => setTimeout(resolve, 4000));

  return {
    listId: testId,
    count: Math.floor(Math.random() * 100),
    timestamp: Date.now(),
  };
}

// Reviews - remote cache (4s DB query)
async function getReviews(testId: string) {
  "use cache: remote";
  cacheTag("reviews");

  await new Promise((resolve) => setTimeout(resolve, 4000));

  return {
    reviewsId: testId,
    count: Math.floor(Math.random() * 500),
    avgRating: (Math.random() * 2 + 3).toFixed(1),
    timestamp: Date.now(),
  };
}

// Dynamic content component that awaits searchParams
async function DynamicContent({
  searchParams,
}: {
  searchParams: Promise<{
    layoutId?: string;
    listId?: string;
    reviewsId?: string;
  }>;
}) {
  // Await searchParams in the child component
  const params = await searchParams;
  const layoutId = params.layoutId || `gen-layout-${Date.now()}`;
  const listId = params.listId || `gen-list-${Date.now()}`;
  const reviewsId = params.reviewsId || `gen-reviews-${Date.now()}`;

  // All run in parallel - 4s total
  const [layout, list, reviews] = await Promise.all([
    getProductLayout(layoutId),
    getProductList(listId),
    getReviews(reviewsId),
  ]);

  return (
    <>
      <div data-testid="layout-section">
        <h2>Product Layout (Default Cache)</h2>
        <p data-testid="layout-id">Layout ID: {layout.layoutId}</p>
        <p>Theme: {layout.theme}</p>
        <p>Timestamp: {layout.timestamp}</p>
      </div>

      <div data-testid="list-section">
        <h2>Product List (Remote Cache)</h2>
        <p data-testid="list-id">List ID: {list.listId}</p>
        <p>Product Count: {list.count}</p>
        <p>Timestamp: {list.timestamp}</p>
      </div>

      <div data-testid="reviews-section">
        <h2>Reviews (Remote Cache)</h2>
        <p data-testid="reviews-id">Reviews ID: {reviews.reviewsId}</p>
        <p>
          {reviews.count} reviews (Avg: {reviews.avgRating}★)
        </p>
        <p>Timestamp: {reviews.timestamp}</p>
      </div>
    </>
  );
}

function LoadingSkeleton() {
  return <div data-testid="loading">Loading products...</div>;
}

export default function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    layoutId?: string;
    listId?: string;
    reviewsId?: string;
  }>;
}) {
  // Don't await searchParams here - pass the Promise down
  return (
    <div>
      <h1>Products - revalidatePath Test</h1>

      <Suspense fallback={<LoadingSkeleton />}>
        <DynamicContent searchParams={searchParams} />
      </Suspense>

      <p className="instruction">
        revalidatePath(&quot;/products&quot;) should clear ALL caches (default + remote). All
        sections refetch (4s).
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
