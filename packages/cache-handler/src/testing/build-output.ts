/**
 * A fake `<distDir>/server` holding prerendered build output, written the way next@16.4.2's
 * `next build` writes it (next/dist/export/routes/app-page.js and app-route.js), with the
 * `prerender-manifest.json` Next writes next to it and the page handler's build stamp, plus the
 * `fs` Next passes to the page handler's constructor.
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
  const app = join(serverDistDir, "app");
  const builtAt = Math.floor((Date.now() - ageMs) / 1000) * 1000;
  const mtime = (options.mtimeMs ?? builtAt) / 1000;
  const write = (path: string, data: string | Buffer): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    utimesSync(path, mtime, mtime);
  };

  write(join(app, "blog.html"), "<html>built blog</html>");
  write(join(app, "blog.rsc"), Buffer.from("rsc:built blog"));
  write(join(app, "blog.segments", "_index.segment.rsc"), Buffer.from("seg:built"));
  write(
    join(app, "blog.meta"),
    JSON.stringify(
      {
        status: 200,
        headers: { "x-next-cache-tags": "products,_N_T_/layout,_N_T_/blog/layout,_N_T_/blog" },
        segmentPaths: ["/_index"],
      },
      null,
      2,
    ),
  );

  write(join(app, "sitemap.xml.body"), Buffer.from("<urlset>built</urlset>"));
  write(
    join(app, "sitemap.xml.meta"),
    JSON.stringify({
      status: 200,
      headers: {
        "content-type": "application/xml",
        "x-next-cache-tags": "_N_T_/layout,_N_T_/sitemap.xml/route,_N_T_/sitemap.xml",
      },
    }),
  );

  // Pages Router: `pages/<key>.html` and `.json`, no `.meta` (next/dist/export/routes/pages.js).
  const pages = join(serverDistDir, "pages");
  write(join(pages, "about.html"), "<html>built about</html>");
  write(join(pages, "about.json"), JSON.stringify({ pageProps: { title: "about" } }));

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

  const nodeRequire = createRequire(import.meta.url);
  const { nodeFs } = nodeRequire("next/dist/server/lib/node-fs-methods.js") as { nodeFs: unknown };
  return { serverDistDir, fs: nodeFs, builtAt };
}

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
