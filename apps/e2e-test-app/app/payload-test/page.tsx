import { getLargePayload } from "@/lib/large-payload";

// E2E-301: Large / nested / unicode payload serialization through the cache.

export default async function Page() {
  const data = await getLargePayload();

  return (
    <div>
      <h1>E2E-301: Large Payload Serialization</h1>
      <div data-testid="payload-summary">
        <p data-testid="payload-stamp">Stamp: {data.generatedAt}</p>
        <p data-testid="payload-count">Count: {data.count}</p>
        <p data-testid="payload-unicode">Unicode: {data.unicode}</p>
        <p data-testid="payload-first">First: {data.first.label}</p>
        <p data-testid="payload-last">Last: {data.last.label}</p>
        <p data-testid="payload-nested">
          Nested: {data.last.nested.value}/{data.last.nested.tags.join(",")}
        </p>
      </div>
      <a href="/">Back to home</a>
    </div>
  );
}
