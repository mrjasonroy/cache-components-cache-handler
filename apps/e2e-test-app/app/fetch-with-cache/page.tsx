// Test page for fetch() WITH "use cache" directive
// This tests the new Next.js 16 data caching with "use cache"

import { cacheLife, cacheTag } from "next/cache";
import { Suspense } from "react";

// Fetch function with "use cache" directive
async function fetchWithCache(id: string, profile?: string, tag?: string) {
  "use cache";

  // Apply cacheLife profile if specified
  if (profile) {
    // biome-ignore lint/suspicious/noExplicitAny: Profile names are dynamic from query params
    cacheLife(profile as any);
  }

  // Apply cache tag if specified
  if (tag) {
    cacheTag(tag);
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const apiUrl = `${baseUrl}/api/test-data?id=${id}`;

  const response = await fetch(apiUrl);
  const data = await response.json();

  return data;
}

// Fetch function WITHOUT "use cache" for comparison
async function fetchWithoutCache(id: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const apiUrl = `${baseUrl}/api/test-data?id=${id}`;

  const response = await fetch(apiUrl, { cache: "no-store" });
  const data = await response.json();

  return data;
}

// Component that fetches the data
async function FetchCacheContent({
  searchParams,
}: {
  searchParams: Promise<{
    id?: string;
    useCache?: string;
    profile?: string;
    tag?: string;
  }>;
}) {
  // Await searchParams to make this dynamic
  const params = await searchParams;
  const id = params.id || "default";
  const useCache = params.useCache !== "false";
  const profile = params.profile;
  const tag = params.tag;

  const data = useCache ? await fetchWithCache(id, profile, tag) : await fetchWithoutCache(id);

  return (
    <div data-testid="fetch-cache-content">
      <p data-testid="use-cache">Use Cache: {useCache ? "true" : "false"}</p>
      {profile && <p data-testid="profile">Profile: {profile}</p>}
      {tag && <p data-testid="tag">Tag: {tag}</p>}
      <p data-testid="id">ID: {data.id}</p>
      <p data-testid="timestamp">Timestamp: {data.timestamp}</p>
      <p data-testid="random">Random: {data.random}</p>
      <p data-testid="message">{data.message}</p>
    </div>
  );
}

export default function FetchWithCachePage({
  searchParams,
}: {
  searchParams: Promise<{
    id?: string;
    useCache?: string;
    profile?: string;
    tag?: string;
  }>;
}) {
  return (
    <div>
      <h1>Fetch Test (With use cache)</h1>
      <Suspense fallback={<div>Loading...</div>}>
        <FetchCacheContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
