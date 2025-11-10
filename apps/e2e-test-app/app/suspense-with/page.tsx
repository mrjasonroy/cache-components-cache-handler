import { cookies } from "next/headers";
import { Suspense } from "react";

// E2E-101: Cached component WITH Suspense boundary
// Accessing cookies outside cache scope and passing as argument

async function CachedContent({
  userValue,
  id,
}: {
  userValue: string | undefined;
  id: string;
}) {
  "use cache";

  // Simulate some async work
  await new Promise((resolve) => setTimeout(resolve, 100));

  return (
    <div data-testid="dynamic-content">
      <p>ID: {id}</p>
      <p>User from cookie: {userValue || "Not set"}</p>
      <p>Timestamp: {new Date().toISOString()}</p>
    </div>
  );
}

async function DynamicContentWrapper({ id }: { id: string }) {
  // Access cookies OUTSIDE the cache scope
  const cookieStore = await cookies();
  const userCookie = cookieStore.get("user");

  return <CachedContent userValue={userCookie?.value} id={id} />;
}

export default function Page({ searchParams }: { searchParams: { id?: string } }) {
  const id = searchParams.id || "default";

  return (
    <div>
      <h1>E2E-101: With Suspense Boundary</h1>
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <DynamicContentWrapper id={id} />
      </Suspense>
      <a href="/">Back to home</a>
    </div>
  );
}
