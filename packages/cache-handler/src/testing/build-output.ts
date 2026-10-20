/**
 * A fake `<distDir>/server` holding prerendered build output, written the way next@16.4.2's
 * `next build` writes it (next/dist/export/worker.js and routes/app-page.js, app-route.js,
 * pages.js), with the `prerender-manifest.json` Next writes next to it and the page handler's
 * build stamp, plus the `fs` Next passes to the page handler's constructor.
 *
 * Next 16.4 asks the handler for a response by its route cache key,
 * `/route-cache/<kind>/<sha256 of the source route>/$<page path>` (next/dist/server/lib/
 * route-cache-key.js), never by its pathname: use {@link BLOG}, {@link SITEMAP} and
 * {@link ABOUT}.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILD_STAMP_FILE, type RoutePeriods } from "../handlers/build-info.js";
import { FALLBACK_BUILD_ID } from "../shared/build-id.js";

export interface BuildOutput {
  serverDistDir: string;
  /** Next's `nodeFs` (next/dist/server/lib/node-fs-methods.js). */
  fs: unknown;
  /** The build time in the stamp, in ms: the entries' `lastModified`. */
  builtAt: number;
}

export interface BuildOutputOptions {
  /**
   * Write the files under their route cache keys, as `next build` does with an `adapterPath`;
   * otherwise at their pathnames, with the key in `.meta`. @default false
   */
  scoped?: boolean;
  /** How long ago the build ran. @default 1 hour */
  ageMs?: number;
  /** Whether the page handler's build stamp is written. @default true */
  stamp?: boolean;
  /** The files' mtime, in ms. @default the build time */
  mtimeMs?: number;
  /** Each route's periods in the prerender manifest. @default `revalidate: false` for all */
  routes?: Record<string, RoutePeriods>;
}

/**
 * Write an `APP_PAGE` (`/blog`, tagged `products` plus its implicit tags), an `APP_ROUTE`
 * (`/sitemap.xml`) and a Pages Router `PAGES` page (`/about`) built `ageMs` ago.
 */
export function writeBuildOutput(options: BuildOutputOptions = {}): BuildOutput {
  const { ageMs = 60 * 60 * 1000, stamp = true } = options;
  const serverDistDir = join(mkdtempSync(join(tmpdir(), "cch-build-")), "server");
  const builtAt = Math.floor((Date.now() - ageMs) / 1000) * 1000;
  const mtime = (options.mtimeMs ?? builtAt) / 1000;
  // Where a route's files go, without the extension.
  const at = (key: RouteCacheKey): string =>
    options.scoped ? join(serverDistDir, key.key) : join(serverDistDir, key.dir, key.pathname);
  const routeCache = (key: RouteCacheKey) => ({
    key: key.key,
    owner: key.owner,
    isFallback: false,
  });
  const write = (path: string, data: string | Buffer): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    utimesSync(path, mtime, mtime);
  };

  const blog = at(BLOG_ROUTE);
  write(`${blog}.html`, "<html>built blog</html>");
  write(`${blog}.rsc`, Buffer.from("rsc:built blog"));
  write(join(`${blog}.segments`, "_index.segment.rsc"), Buffer.from("seg:built"));
  write(
    `${blog}.meta`,
    JSON.stringify(
      {
        status: 200,
        headers: { "x-next-cache-tags": "products,_N_T_/layout,_N_T_/blog/layout,_N_T_/blog" },
        segmentPaths: ["/_index"],
        routeCache: routeCache(BLOG_ROUTE),
      },
      null,
      2,
    ),
  );

  const sitemap = at(SITEMAP_ROUTE);
  write(`${sitemap}.body`, Buffer.from("<urlset>built</urlset>"));
  write(
    `${sitemap}.meta`,
    JSON.stringify({
      status: 200,
      headers: {
        "content-type": "application/xml",
        "x-next-cache-tags": "_N_T_/layout,_N_T_/sitemap.xml/route,_N_T_/sitemap.xml",
      },
      routeCache: routeCache(SITEMAP_ROUTE),
    }),
  );

  // Pages Router: `.html`, `.json` and a `.meta` holding only the route cache key
  // (next/dist/export/routes/pages.js).
  const about = at(ABOUT_ROUTE);
  write(`${about}.html`, "<html>built about</html>");
  write(`${about}.json`, JSON.stringify({ pageProps: { title: "about" } }));
  write(`${about}.meta`, JSON.stringify({ routeCache: routeCache(ABOUT_ROUTE) }));

  const routes: Record<string, RoutePeriods> = {
    "/blog": { revalidate: false },
    "/sitemap.xml": { revalidate: false },
    "/about": { revalidate: false },
    ...options.routes,
  };
  // next/dist/build/index.js: `prerenderManifest.routes[route]`.
  write(
    join(serverDistDir, "..", "prerender-manifest.json"),
    JSON.stringify({
      version: 4,
      routes: Object.fromEntries(
        Object.entries(routes).map(([route, { revalidate, expire }]) => [
          route,
          { initialRevalidateSeconds: revalidate, initialExpireSeconds: expire },
        ]),
      ),
      dynamicRoutes: {},
    }),
  );
  // No BUILD_ID is written, so the build is `development`, as in the tests' keys.
  if (stamp) {
    write(
      join(serverDistDir, BUILD_STAMP_FILE),
      JSON.stringify({ buildTime: builtAt, buildId: FALLBACK_BUILD_ID }),
    );
  }

  const { nodeFs } = nodeRequire("next/dist/server/lib/node-fs-methods.js") as { nodeFs: unknown };
  return { serverDistDir, fs: nodeFs, builtAt };
}

const nodeRequire = createRequire(import.meta.url);
const { getRouteCacheKey } = nodeRequire("next/dist/server/lib/route-cache-key.js") as {
  getRouteCacheKey: (pathname: string, owner: { kind: string; sourceRoute: string }) => string;
};

interface RouteCacheKey {
  key: string;
  owner: { kind: string; sourceRoute: string };
  /** Where `next build` writes it without scoped artifacts. */
  dir: "app" | "pages";
  pathname: string;
}

/** A route's cache key, as Next builds it (next/dist/server/lib/route-cache-key.js). */
function routeCacheKey(kind: string, sourceRoute: string, pathname: string): RouteCacheKey {
  const owner = { kind, sourceRoute };
  const dir = kind === "PAGES" ? "pages" : "app";
  return { key: getRouteCacheKey(pathname, owner), owner, dir, pathname };
}

// App modules are owned by their page (`/blog/page`), Pages Router ones by their pathname
// (next/dist/server/lib/route-cache-key.js `getResponseCacheOwner`).
const BLOG_ROUTE = routeCacheKey("APP_PAGE", "/blog/page", "/blog");
const SITEMAP_ROUTE = routeCacheKey("APP_ROUTE", "/sitemap.xml/route", "/sitemap.xml");
const ABOUT_ROUTE = routeCacheKey("PAGES", "/about", "/about");

/** The cache key Next passes for the prerendered app page `/blog`. */
export const BLOG = BLOG_ROUTE.key;
/** The cache key Next passes for the prerendered route handler `/sitemap.xml`. */
export const SITEMAP = SITEMAP_ROUTE.key;
/** The cache key Next passes for the prerendered Pages Router page `/about`. */
export const ABOUT = ABOUT_ROUTE.key;

/** The cache key Next would pass for an app page `/other` that was not prerendered. */
export const OTHER = routeCacheKey("APP_PAGE", "/other/page", "/other").key;

/** The get context Next passes for a prerendered app page. */
export const appPageCtx = {
  kind: "APP_PAGE",
  isFallback: false,
  isRoutePPREnabled: false,
  softTags: ["_N_T_/layout", "_N_T_/blog/layout", "_N_T_/blog"],
};

/** The get context Next passes for a prerendered route handler. */
export const appRouteCtx = {
  kind: "APP_ROUTE",
  isFallback: false,
  softTags: ["_N_T_/layout", "_N_T_/sitemap.xml/route", "_N_T_/sitemap.xml"],
};

/** The get context Next passes for a prerendered Pages Router page. */
export const pagesCtx = {
  kind: "PAGES",
  isFallback: false,
};
