import { cacheLife, cacheTag } from "next/cache";
import { cookies } from "next/headers";
import { Suspense } from "react";

export function generateStaticParams() {
  return [{ id: "build" }];
}

async function Snapshot({ id }: { id: string }) {
  "use cache";
  cacheLife({ stale: 60, revalidate: 86400, expire: 172800 });
  cacheTag(`multi-pod-${id}`);
  if (id === "build") return <p data-testid="version">build</p>;
  const origin = process.env.E2E_ORIGIN_URL;
  if (!origin) throw new Error("E2E_ORIGIN_URL is required for the multi-pod fixture");
  const response = await fetch(`${origin}/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("Multi-pod fixture origin failed");
  return <p data-testid="version">{await response.text()}</p>;
}

async function RequestPart() {
  await cookies();
  return <p>Request content</p>;
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <Snapshot id={id} />
      <Suspense fallback={<p>Loading</p>}>
        <RequestPart />
      </Suspense>
    </main>
  );
}
