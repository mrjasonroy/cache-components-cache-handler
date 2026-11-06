import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// A real process with its own runtime, memory stores, tag state and Redis connection.
const compiled = pathToFileURL(`${process.argv[2]}/`);
const { createPageCacheHandler } = await import(new URL("handlers/redis.js", compiled));
const { createLocalCacheHandler } = await import(new URL("data-cache/local.js", compiled));
const { createRemoteCacheHandler } = await import(new URL("data-cache/remote.js", compiled));
const { setClockForTests } = await import(new URL("shared/clock.js", compiled));
const { closeCache } = await import(new URL("index.js", compiled));
const require = createRequire(import.meta.url);
let now = Date.now();
let realtime = false;
setClockForTests(() => (realtime ? Date.now() : now));
let Page;
let local;
let remote;
let pageOptions;
const renders = new Map();
const requests = new Map();

function page(request) {
  if (!requests.has(request)) requests.set(request, new Page(pageOptions));
  return requests.get(request);
}

async function execute(m) {
  now = realtime ? Date.now() : (m.now ?? now);
  const handler = m.kind === "local" ? local : remote;
  switch (m.op) {
    case "identity":
      return { pid: process.pid };
    case "init": {
      realtime = m.realtime ?? false;
      await closeCache();
      requests.clear();
      renders.clear();
      if (m.deployment) process.env.NEXT_DEPLOYMENT_ID = m.deployment;
      const options = { keyPrefix: m.prefix, commandTimeout: 100, ...m.options };
      Page = createPageCacheHandler(options);
      pageOptions = m.serverDistDir
        ? {
            serverDistDir: m.serverDistDir,
            fs: require("next/dist/server/lib/node-fs-methods.js").nodeFs,
          }
        : {};
      local = createLocalCacheHandler(options);
      remote = createRemoteCacheHandler(options);
      await local.refreshTags();
      return { pid: process.pid };
    }
    case "begin": {
      const timestamp = now;
      if (m.kind === "page") {
        await page(m.request).get(m.key, m.context);
        renders.set(m.request, { ...m, timestamp });
      } else {
        let resolve;
        const pending = new Promise((done) => {
          resolve = done;
        });
        const writing = handler.set(m.key, pending);
        renders.set(m.request, { ...m, timestamp, resolve, writing });
      }
      return { timestamp };
    }
    case "finish": {
      const render = renders.get(m.request);
      if (!render) throw new Error(`Unknown render ${m.request}`);
      if (render.kind === "page") {
        await page(m.request).set(
          render.key,
          {
            kind: "APP_PAGE",
            html: render.value,
            rscData: Buffer.from(render.value),
            headers: { "x-next-cache-tags": render.tags.join(",") },
            postponed: render.postponed ? "held-shell" : undefined,
            status: 200,
          },
          { cacheControl: render.life ?? { revalidate: 60, expire: 300 } },
        );
      } else {
        render.resolve({
          value: new Response(render.value).body,
          timestamp: render.timestamp,
          tags: render.tags,
          stale: 0,
          revalidate: 60,
          expire: 300,
          ...render.life,
        });
        await render.writing;
      }
      renders.delete(m.request);
      return {};
    }
    case "read": {
      if (m.kind === "page") {
        const entry = await page(m.request).get(m.key, m.context);
        return entry ? { value: entry.value.html, timestamp: entry.lastModified } : null;
      }
      await handler.refreshTags();
      const entry = await handler.get(m.key, m.softTags ?? []);
      return entry
        ? {
            value: await new Response(entry.value).text(),
            timestamp: entry.timestamp,
            revalidate: entry.revalidate,
            stale: entry.stale,
            expire: entry.expire,
          }
        : null;
    }
    case "invalidate":
      await page("invalidator").revalidateTag(m.tags, m.durations ?? { expire: 0 });
      return {};
    case "reset":
      page(m.request).resetRequestCache();
      return {};
    case "close":
      await closeCache();
      return {};
    default:
      throw new Error(`Unknown operation ${m.op}`);
  }
}

process.on("message", async (message) => {
  try {
    process.send({ id: message.id, result: await execute(message) });
  } catch (error) {
    process.send({ id: message.id, error: error.stack ?? String(error) });
  }
});
