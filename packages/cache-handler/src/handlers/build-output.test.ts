import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pageKey } from "../shared/keys.js";
import {
  type BuildOutput,
  appPageCtx,
  appRouteCtx,
  pagesCtx,
  writeBuildOutput,
} from "../testing/build-output.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { RedisCacheHandler } from "./redis.js";

const BLOG_KEY = pageKey("nextjs:", "development", "/blog");

let build: BuildOutput;

function handlerFor(fake?: FakeRedis) {
  return new RedisCacheHandler({
    fs: build.fs,
    serverDistDir: build.serverDistDir,
    ...(fake ? { client: asClient(fake) } : {}),
  });
}

/** A new process: every registry, memory store and tag record in memory is gone; Redis is not. */
async function restart(): Promise<void> {
  await resetCacheState();
}

describe("page handler: prerendered build output", () => {
  beforeEach(async () => {
    await resetCacheState();
    build = writeBuildOutput();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
    rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
  });

  test("a prerendered page missing from Redis is served from the build output, at build time", async () => {
    const result = await handlerFor(new FakeRedis()).get("/blog", appPageCtx);

    expect(result?.value.kind).toBe("APP_PAGE");
    expect(result?.value.html).toBe("<html>built blog</html>");
    expect(String(result?.value.rscData)).toBe("rsc:built blog");
    expect(String((result?.value.segmentData as Map<string, Buffer>).get("/_index"))).toBe(
      "seg:built",
    );
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a prerendered route handler (sitemap) is served from the build output", async () => {
    const result = await handlerFor(new FakeRedis()).get("/sitemap.xml", appRouteCtx);

    expect(result?.value.kind).toBe("APP_ROUTE");
    expect(String(result?.value.body)).toBe("<urlset>built</urlset>");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("the build output is written through to Redis, and the next read is a Redis hit", async () => {
    const fake = new FakeRedis();
    await handlerFor(fake).get("/blog", appPageCtx);
    expect(await fake.getBuffer(BLOG_KEY)).not.toBeNull();

    // The files are gone and the process restarted: only Redis can serve it now.
    rmSync(build.serverDistDir, { recursive: true, force: true });
    await restart();
    const result = await handlerFor(fake).get("/blog", appPageCtx);
    expect(result?.value.html).toBe("<html>built blog</html>");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("an entry already in Redis wins over the build output and is not overwritten", async () => {
    const fake = new FakeRedis();
    const handler = handlerFor(fake);
    await handler.set(
      "/blog",
      {
        kind: "APP_PAGE",
        html: "<html>rendered</html>",
        rscData: Buffer.from("rsc"),
        headers: { "x-next-cache-tags": "products" },
        status: 200,
      },
      { cacheControl: { revalidate: 60, expire: 300 } },
    );
    const written = await fake.getBuffer(BLOG_KEY);

    expect((await handler.get("/blog", appPageCtx))?.value.html).toBe("<html>rendered</html>");
    expect(await fake.getBuffer(BLOG_KEY)).toEqual(written);
  });

  test("a tag revalidated since the build beats the build output", async () => {
    const handler = handlerFor(new FakeRedis());
    await handler.revalidateTag("products");
    expect(await handler.get("/blog", appPageCtx)).toBeNull();
  });

  test("a build-output entry is never served over a newer revalidated tag, across a restart", async () => {
    const fake = new FakeRedis();
    expect(await handlerFor(fake).get("/blog", appPageCtx)).not.toBeNull();
    await handlerFor(fake).revalidateTag("products");

    await restart();
    expect(await handlerFor(fake).get("/blog", appPageCtx)).toBeNull();
  });

  test("a path revalidated since the build beats the build output, across a restart, before any Redis entry exists", async () => {
    const fake = new FakeRedis();
    // revalidatePath("/sitemap.xml") revalidates its implicit tag.
    await handlerFor(fake).revalidateTag("_N_T_/sitemap.xml");
    expect(await fake.getBuffer(pageKey("nextjs:", "development", "/sitemap.xml"))).toBeNull();

    await restart();
    expect(await handlerFor(fake).get("/sitemap.xml", appRouteCtx)).toBeNull();
    // Rejected build output is not written to Redis either.
    expect(await fake.getBuffer(pageKey("nextjs:", "development", "/sitemap.xml"))).toBeNull();
  });

  test("while Redis is down the build output is not served: its tags cannot be checked", async () => {
    const fake = new FakeRedis();
    const handler = handlerFor(fake);
    fake.goDown();
    expect(await handler.get("/blog", appPageCtx)).toBeNull();
  });

  test("without Redis the build output is served from memory, and a revalidation beats it", async () => {
    const handler = handlerFor();
    expect((await handler.get("/blog", appPageCtx))?.value.html).toBe("<html>built blog</html>");

    rmSync(build.serverDistDir, { recursive: true, force: true });
    expect((await handler.get("/blog", appPageCtx))?.value.html).toBe("<html>built blog</html>");

    await handler.revalidateTag("products");
    expect(await handler.get("/blog", appPageCtx)).toBeNull();
  });

  test("a prerendered Pages Router page is served from the build output", async () => {
    const result = await handlerFor(new FakeRedis()).get("/about", pagesCtx);

    expect(result?.value.kind).toBe("PAGES");
    expect(result?.value.html).toBe("<html>built about</html>");
    expect(result?.value.pageData).toEqual({ pageProps: { title: "about" } });
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a Pages Router page's header tags are checked, across a restart, before any Redis entry exists", async () => {
    // next@16.4.2 writes no `.meta` for PAGES and its reader returns no headers, but the value
    // type carries them and Next's own reader checks them: give the read value tag headers.
    const { default: FileSystemCache } = createRequire(import.meta.url)(
      "next/dist/server/lib/incremental-cache/file-system-cache.js",
    ) as { default: { prototype: { get: (...args: unknown[]) => Promise<unknown> } } };
    const read = FileSystemCache.prototype.get;
    vi.spyOn(FileSystemCache.prototype, "get").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const found = (await read.apply(this, args)) as { value: Record<string, unknown> } | null;
      if (found?.value.kind === "PAGES") found.value.headers = { "x-next-cache-tags": "products" };
      return found;
    });

    const fake = new FakeRedis();
    await handlerFor(fake).revalidateTag("products");

    await restart();
    expect(await handlerFor(fake).get("/about", pagesCtx)).toBeNull();
    expect(await fake.getBuffer(pageKey("nextjs:", "development", "/about"))).toBeNull();
  });

  test("routes that were not prerendered, and FETCH entries, are misses", async () => {
    const handler = handlerFor(new FakeRedis());
    expect(await handler.get("/other", appPageCtx)).toBeNull();
    expect(await handler.get("/blog", { kind: "FETCH", tags: [] })).toBeNull();
  });

  test("without fs and serverDistDir from Next there is no build output", async () => {
    const handler = new RedisCacheHandler({ client: asClient(new FakeRedis()) });
    expect(await handler.get("/blog", appPageCtx)).toBeNull();
  });
});
