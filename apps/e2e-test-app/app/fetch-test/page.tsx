// Test page for fetch() caching WITHOUT "use cache" directive
// NOTE: In Next.js 16 with cacheComponents enabled, native fetch() caching
// is NOT supported. This page demonstrates that behavior.

import { Suspense } from "react";

// Fetch function WITHOUT "use cache" directive
async function fetchData(id: string, cacheOption: string) {
  // Build the URL for the API endpoint
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const apiUrl = `${baseUrl}/api/test-data?id=${id}`;

  // Fetch with different cache options
  const fetchOptions: RequestInit = {};

  if (cacheOption === "force-cache") {
    // Default Next.js behavior - will cache indefinitely
    fetchOptions.cache = "force-cache";
  } else if (cacheOption === "no-store") {
    // No caching
    fetchOptions.cache = "no-store";
  } else if (cacheOption === "revalidate") {
    // Time-based revalidation
    fetchOptions.next = { revalidate: 60 }; // 60 seconds
  } else if (cacheOption === "tags") {
    // Tag-based revalidation
    fetchOptions.next = { tags: [`fetch-${id}`] };
  }

  const response = await fetch(apiUrl, fetchOptions);
  const data = await response.json();

  return data;
}

// Component that fetches the data
async function FetchContent({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; cache?: string }>;
}) {
  // Await searchParams to make this dynamic
  const params = await searchParams;
  const id = params.id || "default";
  const cacheOption = params.cache || "force-cache";

  const data = await fetchData(id, cacheOption);

  return (
    <div data-testid="fetch-content">
      <p data-testid="cache-option">Cache: {cacheOption}</p>
      <p data-testid="id">ID: {data.id}</p>
      <p data-testid="timestamp">Timestamp: {data.timestamp}</p>
      <p data-testid="random">Random: {data.random}</p>
      <p data-testid="message">{data.message}</p>
    </div>
  );
}

export default function FetchTestPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; cache?: string }>;
}) {
  return (
    <div>
      <h1>Fetch Test (Without use cache)</h1>
      <Suspense fallback={<div>Loading...</div>}>
        <FetchContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
