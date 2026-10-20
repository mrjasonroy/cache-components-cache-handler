import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushCache } from "../shared/flush.js";
import { pageKey } from "../shared/keys.js";
import {
  ABOUT,
  BLOG,
  type BuildOutput,
  type BuildOutputOptions,
  OTHER,
  POSTS_FALLBACK,
  SITEMAP,
  appPageCtx,
  appRouteCtx,
  fallbackCtx,
  pagesCtx,
  writeBuildOutput,
} from "../testing/build-output.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { BUILD_STAMP_FILE } from "./build-info.js";
import { RedisCacheHandler } from "./redis.js";

const BLOG_KEY = pageKey("nextjs:", "development", BLOG);

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

/** Replace the build output with one written with `options`. */
function rebuild(options: BuildOutputOptions): void {
  rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
  build = writeBuildOutput(options);
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const result = await handlerFor(new FakeRedis()).get(BLOG, appPageCtx);

    expect(result?.value.kind).toBe("APP_PAGE");
    expect(result?.value.html).toBe("<html>built blog</html>");
    expect(String(result?.value.rscData)).toBe("rsc:built blog");
    expect(String((result?.value.segmentData as Map<string, Buffer>).get("/_index"))).toBe(
      "seg:built",
    );
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("with scoped artifacts (next build with an adapterPath) every kind is served from the build output", async () => {
    rebuild({ scoped: true });
    const handler = handlerFor(new FakeRedis());

    expect((await handler.get(BLOG, appPageCtx))?.value.html).toBe("<html>built blog</html>");
    expect(String((await handler.get(SITEMAP, appRouteCtx))?.value.body)).toBe(
      "<urlset>built</urlset>",
    );
    expect((await handler.get(ABOUT, pagesCtx))?.value.html).toBe("<html>built about</html>");
  });

  test("a dynamic route's Partial Prerendering fallback shell is served from the build output", async () => {
    const result = await handlerFor(new FakeRedis()).get(POSTS_FALLBACK, fallbackCtx);

    expect(result?.value.kind).toBe("APP_PAGE");
    expect(result?.value.html).toBe("<html>posts shell</html>");
    expect(result?.value.postponed).toBe("postponed-state");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a time-based fallback shell keeps its build output for its fallback window", async () => {
    rebuild({ fallbacks: { "/posts/[slug]": { revalidate: 60 } }, ageMs: 30_000 });
    expect((await handlerFor(new FakeRedis()).get(POSTS_FALLBACK, fallbackCtx))?.value.html).toBe(
      "<html>posts shell</html>",
    );
    await restart();
    rebuild({ fallbacks: { "/posts/[slug]": { revalidate: 60 } }, ageMs: 100_000 });
    expect(await handlerFor(new FakeRedis()).get(POSTS_FALLBACK, fallbackCtx)).toBeNull();
  });

  test("a fallback shell's tags are checked: a revalidation beats it, across a restart", async () => {
    const fake = new FakeRedis();
    expect(await handlerFor(fake).get(POSTS_FALLBACK, fallbackCtx)).not.toBeNull();
    // Read from the build output again, not from its write-through.
    await fake.del(pageKey("nextjs:", "development", POSTS_FALLBACK));
    await restart();
    await handlerFor(fake).revalidateTag("_N_T_/posts/[slug]/page");

    await restart();
    expect(await handlerFor(fake).get(POSTS_FALLBACK, fallbackCtx)).toBeNull();
  });

  test("a flush is a barrier for a fallback shell too", async () => {
    const fake = new FakeRedis();
    expect(await handlerFor(fake).get(POSTS_FALLBACK, fallbackCtx)).not.toBeNull();
    await flushCache({ client: asClient(fake), scope: "all" });

    await restart();
    expect(await handlerFor(fake).get(POSTS_FALLBACK, fallbackCtx)).toBeNull();
  });

  test("a pathname of a dynamic route rendered at runtime is a miss", async () => {
    const posts = createRequire(import.meta.url)("next/dist/server/lib/route-cache-key.js") as {
      getRouteCacheKey: (pathname: string, owner: object) => string;
    };
    const key = posts.getRouteCacheKey("/posts/hello", {
      kind: "APP_PAGE",
      sourceRoute: "/posts/[slug]/page",
    });
    expect(
      await handlerFor(new FakeRedis()).get(key, { ...fallbackCtx, isFallback: false }),
    ).toBeNull();
  });

  test("a prerendered route handler (sitemap) is served from the build output", async () => {
    const result = await handlerFor(new FakeRedis()).get(SITEMAP, appRouteCtx);

    expect(result?.value.kind).toBe("APP_ROUTE");
    expect(String(result?.value.body)).toBe("<urlset>built</urlset>");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a large build output is written through to Redis compressed (v3), and read back", async () => {
    const html = `<html>${"<p>built</p>".repeat(4_000)}</html>`;
    writeFileSync(join(build.serverDistDir, "app", "blog.html"), html);
    const fake = new FakeRedis();
    await handlerFor(fake).get(BLOG, appPageCtx);
    const raw = await fake.getBuffer(BLOG_KEY);
    expect(raw?.[3]).toBe(3);

    rmSync(build.serverDistDir, { recursive: true, force: true });
    await restart();
    expect((await handlerFor(fake).get(BLOG, appPageCtx))?.value.html).toBe(html);
  });

  test("the build output is written through to Redis, and the next read is a Redis hit", async () => {
    const fake = new FakeRedis();
    await handlerFor(fake).get(BLOG, appPageCtx);
    expect(await fake.getBuffer(BLOG_KEY)).not.toBeNull();

    // The files are gone and the process restarted: only Redis can serve it now.
    rmSync(build.serverDistDir, { recursive: true, force: true });
    await restart();
    const result = await handlerFor(fake).get(BLOG, appPageCtx);
    expect(result?.value.html).toBe("<html>built blog</html>");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("an entry already in Redis wins over the build output and is not overwritten", async () => {
    const fake = new FakeRedis();
    const handler = handlerFor(fake);
    await handler.set(
      BLOG,
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

    expect((await handler.get(BLOG, appPageCtx))?.value.html).toBe("<html>rendered</html>");
    expect(await fake.getBuffer(BLOG_KEY)).toEqual(written);
  });

  test("an entry another instance writes while the build output is promoted is not overwritten (NX)", async () => {
    const fake = new FakeRedis();
    const racer = Buffer.from("written by another instance");
    const set = fake.set.bind(fake);
    // The read missed; another instance's write lands just before this one's promotion does.
    vi.spyOn(fake, "set").mockImplementation(async (key, value, ...args) => {
      if (key === BLOG_KEY && args.includes("NX")) await set(BLOG_KEY, racer);
      return set(key, value, ...args);
    });

    expect((await handlerFor(fake).get(BLOG, appPageCtx))?.value.html).toBe(
      "<html>built blog</html>",
    );
    expect(await fake.getBuffer(BLOG_KEY)).toEqual(racer);
  });

  test("a tag revalidated since the build beats the build output", async () => {
    const handler = handlerFor(new FakeRedis());
    await handler.revalidateTag("products");
    expect(await handler.get(BLOG, appPageCtx)).toBeNull();
  });

  test("a build-output entry is never served over a newer revalidated tag, across a restart", async () => {
    const fake = new FakeRedis();
    expect(await handlerFor(fake).get(BLOG, appPageCtx)).not.toBeNull();
    await handlerFor(fake).revalidateTag("products");

    await restart();
    expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
  });

  test("a path revalidated since the build beats the build output, across a restart, before any Redis entry exists", async () => {
    const fake = new FakeRedis();
    // revalidatePath("/sitemap.xml") revalidates its implicit tag.
    await handlerFor(fake).revalidateTag("_N_T_/sitemap.xml");
    expect(await fake.getBuffer(pageKey("nextjs:", "development", SITEMAP))).toBeNull();

    await restart();
    expect(await handlerFor(fake).get(SITEMAP, appRouteCtx)).toBeNull();
    // Rejected build output is not written to Redis either.
    expect(await fake.getBuffer(pageKey("nextjs:", "development", SITEMAP))).toBeNull();
  });

  test("while Redis is down the build output is not served: its tags cannot be checked", async () => {
    const fake = new FakeRedis();
    const handler = handlerFor(fake);
    fake.goDown();
    expect(await handler.get(BLOG, appPageCtx)).toBeNull();
  });

  test("without Redis the build output is served from memory, and a revalidation beats it", async () => {
    const handler = handlerFor();
    expect((await handler.get(BLOG, appPageCtx))?.value.html).toBe("<html>built blog</html>");

    rmSync(build.serverDistDir, { recursive: true, force: true });
    expect((await handler.get(BLOG, appPageCtx))?.value.html).toBe("<html>built blog</html>");

    await handler.revalidateTag("products");
    expect(await handler.get(BLOG, appPageCtx)).toBeNull();
  });

  test("a prerendered Pages Router page is served from the build output", async () => {
    const result = await handlerFor(new FakeRedis()).get(ABOUT, pagesCtx);

    expect(result?.value.kind).toBe("PAGES");
    expect(result?.value.html).toBe("<html>built about</html>");
    expect(result?.value.pageData).toEqual({ pageProps: { title: "about" } });
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a Pages Router page's header tags are checked, across a restart, before any Redis entry exists", async () => {
    // next@16.4.2 writes no headers in a PAGES `.meta`, but the value type carries them and
    // Next's own reader checks them: give the read value tag headers.
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
    expect(await handlerFor(fake).get(ABOUT, pagesCtx)).toBeNull();
    expect(await fake.getBuffer(pageKey("nextjs:", "development", ABOUT))).toBeNull();
  });

  test("routes that were not prerendered, and FETCH entries, are misses", async () => {
    const handler = handlerFor(new FakeRedis());
    expect(await handler.get(OTHER, appPageCtx)).toBeNull();
    expect(await handler.get(BLOG, { kind: "FETCH", tags: [] })).toBeNull();
  });

  test("without fs and serverDistDir from Next there is no build output", async () => {
    const handler = new RedisCacheHandler({ client: asClient(new FakeRedis()) });
    expect(await handler.get(BLOG, appPageCtx)).toBeNull();
  });

  describe("the build time is the handler's build stamp, never the files' mtime", () => {
    test("files whose mtime is 1970 (reproducible builds) are served, at the stamp's time", async () => {
      rebuild({ mtimeMs: 0 });
      const result = await handlerFor(new FakeRedis()).get(BLOG, appPageCtx);
      expect(result?.value.html).toBe("<html>built blog</html>");
      expect(result?.lastModified).toBe(build.builtAt);
    });

    test("files copied without their mtimes (now) are still older than a revalidation made after the build", async () => {
      rebuild({ ageMs: 2 * DAY_MS });
      const fake = new FakeRedis();
      await handlerFor(fake).revalidateTag("products");
      // The deploy copies the files: their mtime is now, after the revalidation.
      const files = ["blog.html", "blog.rsc", "blog.meta"].map((file) =>
        join(build.serverDistDir, "app", file),
      );
      for (const file of files) utimesSync(file, new Date(), new Date());

      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
    });

    test("without a stamp, a page with no tag record ever written is served, as of the read", async () => {
      rebuild({ stamp: false, mtimeMs: 0 });
      const before = Date.now();
      const result = await handlerFor(new FakeRedis()).get(BLOG, appPageCtx);
      expect(result?.value.html).toBe("<html>built blog</html>");
      expect(result?.lastModified).toBeGreaterThanOrEqual(before);
    });

    test("without a stamp, any record of the page's tags makes it a miss, however old", async () => {
      rebuild({ stamp: false });
      const fake = new FakeRedis();
      // Revalidated long before the build: with no build time, it cannot be told apart.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 300 * DAY_MS);
      await handlerFor(fake).revalidateTag("_N_T_/blog");
      vi.useRealTimers();

      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
      expect(await fake.getBuffer(BLOG_KEY)).toBeNull();
    });

    test("without a stamp, a time-based page is a miss: its window cannot be placed", async () => {
      rebuild({ stamp: false, routes: { "/blog": { revalidate: 3600 } } });
      expect(await handlerFor(new FakeRedis()).get(BLOG, appPageCtx)).toBeNull();
    });

    test("a stamp naming another build counts as missing", async () => {
      rebuild({ routes: { "/blog": { revalidate: 3600 } }, ageMs: 1000 });
      writeFileSync(
        join(build.serverDistDir, BUILD_STAMP_FILE),
        JSON.stringify({ buildTime: build.builtAt, buildId: "another-build" }),
      );
      expect(await handlerFor(new FakeRedis()).get(BLOG, appPageCtx)).toBeNull();
    });
  });

  describe("a time-based route's build output lasts 1.5 × revalidate (capped at expire) from the build", () => {
    test("inside the window it is served and written to Redis for what is left of it", async () => {
      rebuild({ routes: { "/blog": { revalidate: 60 } }, ageMs: 30_000 });
      const fake = new FakeRedis();
      expect((await handlerFor(fake).get(BLOG, appPageCtx))?.value.html).toBe(
        "<html>built blog</html>",
      );
      // 90 s from the build, 30 s of it gone.
      expect(fake.ttlOf(BLOG_KEY)).toBeGreaterThan(55);
      expect(fake.ttlOf(BLOG_KEY)).toBeLessThanOrEqual(60);
    });

    test("past the window, once its Redis key has expired, the build-time copy is not served again", async () => {
      rebuild({ routes: { "/blog": { revalidate: 60 } }, ageMs: 30 * DAY_MS });
      const fake = new FakeRedis();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
      expect(await fake.getBuffer(BLOG_KEY)).toBeNull();
    });

    test("expire caps the window", async () => {
      rebuild({ routes: { "/blog": { revalidate: 60, expire: 70 } }, ageMs: 80_000 });
      expect(await handlerFor(new FakeRedis()).get(BLOG, appPageCtx)).toBeNull();
    });

    test("a route the prerender manifest does not list is a miss", async () => {
      rmSync(join(build.serverDistDir, "..", "prerender-manifest.json"));
      expect(await handlerFor(new FakeRedis()).get(BLOG, appPageCtx)).toBeNull();
    });

    test("a route with revalidate: false keeps its build output however old the build", async () => {
      rebuild({ ageMs: 200 * DAY_MS });
      const result = await handlerFor(new FakeRedis()).get(BLOG, appPageCtx);
      expect(result?.lastModified).toBe(build.builtAt);
    });
  });

  describe("a flush is a barrier: build output older than it is never served again", () => {
    test('flushCache({ scope: "all" }) deletes the tag records, yet a page revalidated before it does not come back after a restart', async () => {
      const fake = new FakeRedis();
      await handlerFor(fake).revalidateTag("products");
      await flushCache({ client: asClient(fake), scope: "all" });

      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
      expect(await handlerFor(fake).get(SITEMAP, appRouteCtx)).toBeNull();
      expect(await fake.getBuffer(BLOG_KEY)).toBeNull();
    });

    test("flushCache() of this build is a barrier for this build's output only", async () => {
      const fake = new FakeRedis();
      await flushCache({ client: asClient(fake), buildId: "another-build" });
      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).not.toBeNull();

      await flushCache({ client: asClient(fake) });
      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).toBeNull();
    });

    test("an instance that was already running sees the barrier on its next read", async () => {
      const fake = new FakeRedis();
      const running = handlerFor(fake);
      expect(await running.get(BLOG, appPageCtx)).not.toBeNull();
      // Another instance flushes.
      await flushCache({ client: asClient(new FakeRedis(fake.items)), scope: "all" });
      expect(await running.get(BLOG, appPageCtx)).toBeNull();
    });

    test("a build made after the flush is served", async () => {
      const fake = new FakeRedis();
      await flushCache({ client: asClient(fake), scope: "all" });
      rebuild({ ageMs: -1000 });

      await restart();
      expect(await handlerFor(fake).get(BLOG, appPageCtx)).not.toBeNull();
    });

    test("without Redis, a flush keeps the build output from being read back from disk", async () => {
      const handler = handlerFor();
      expect(await handler.get(BLOG, appPageCtx)).not.toBeNull();
      await flushCache();
      expect(await handler.get(BLOG, appPageCtx)).toBeNull();
    });
  });
});
