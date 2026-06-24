import { getTaggedData } from "@/lib/tagged-data";
import { Suspense } from "react";
import { RevalidateForms } from "./revalidate-form";

// E2E-201-202: Tag-based revalidation
// Accepts an optional `?tag=` so each test can use an isolated tag and avoid
// cross-test interference (revalidating one test's tag must not affect another).
// Reading searchParams is dynamic, so it lives inside a Suspense boundary as
// required by cacheComponents.

export default function Page({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  return (
    <div>
      <h1>E2E-201-202: Revalidation Test</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <RevalidateContent searchParams={searchParams} />
      </Suspense>
      <a href="/">Back to home</a>
    </div>
  );
}

async function RevalidateContent({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const { tag = "test-tag" } = await searchParams;
  const data = await getTaggedData(tag);

  return (
    <>
      <div data-testid="tagged-content">
        <p>Tag: {data.tag}</p>
        <p>Timestamp: {data.timestamp}</p>
        <p>Random: {data.randomValue}</p>
      </div>
      <RevalidateForms tag={tag} />
    </>
  );
}
