import { cacheLife, cacheTag } from "next/cache";
import { cookies } from "next/headers";
import { Suspense } from "react";

export function generateStaticParams() {
  return [{ port: "0", id: "build" }];
}

async function Snapshot({ port, id }: { port: string; id: string }) {
  "use cache";
  cacheLife({ stale: 60, revalidate: 86400, expire: 172800 });
  cacheTag(`inflight-${id}`);
  if (port === "0") return <p data-testid="version">build</p>;
  const response = await fetch(`http://127.0.0.1:${Number(port)}/${id}`);
  if (!response.ok) throw new Error("Fixture origin failed");
  return <p data-testid="version">{await response.text()}</p>;
}

async function RequestPart() {
  await cookies();
  return <p>Request content</p>;
}

export default async function Page({ params }: { params: Promise<{ port: string; id: string }> }) {
  const { port, id } = await params;
  return (
    <main>
      <Snapshot port={port} id={id} />
      <Suspense fallback={<p>Loading</p>}>
        <RequestPart />
      </Suspense>
    </main>
  );
}
