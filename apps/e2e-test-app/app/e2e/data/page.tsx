import { Suspense } from "react";
import { getLocalStamp, getRemoteStamp } from "../../../lib/stamp-data";

async function Stamps({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id = "default" } = await searchParams;
  const [local, remote] = await Promise.all([getLocalStamp(id), getRemoteStamp(id)]);

  return (
    <>
      <p data-testid="local">{local}</p>
      <p data-testid="remote">{remote}</p>
    </>
  );
}

/** Dynamic page (reads searchParams) whose cached parts are one "use cache" and one remote call. */
export default function Page({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  return (
    <main>
      <h1>Data handlers</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Stamps searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
