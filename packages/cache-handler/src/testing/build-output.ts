/**
 * A fake `<distDir>/server` holding prerendered build output, written the way next@16.4.2's
 * `next build` writes it (next/dist/export/routes/app-page.js and app-route.js), plus the `fs`
 * Next passes to the page handler's constructor.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface BuildOutput {
  serverDistDir: string;
  /** Next's `nodeFs` (next/dist/server/lib/node-fs-methods.js). */
  fs: unknown;
  /** When the files were written, in ms: the entries' `lastModified`. */
  builtAt: number;
}

function write(path: string, data: string | Buffer, builtAt: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  utimesSync(path, builtAt / 1000, builtAt / 1000);
}

/**
 * Write an `APP_PAGE` (`/blog`, tagged `products` plus its implicit tags), an `APP_ROUTE`
 * (`/sitemap.xml`) and a Pages Router `PAGES` page (`/about`) built `ageMs` ago.
 */
export function writeBuildOutput(ageMs = 60 * 60 * 1000): BuildOutput {
  const serverDistDir = join(mkdtempSync(join(tmpdir(), "cch-build-")), "server");
  const app = join(serverDistDir, "app");
  const builtAt = Math.floor((Date.now() - ageMs) / 1000) * 1000;

  write(join(app, "blog.html"), "<html>built blog</html>", builtAt);
  write(join(app, "blog.rsc"), Buffer.from("rsc:built blog"), builtAt);
  write(join(app, "blog.segments", "_index.segment.rsc"), Buffer.from("seg:built"), builtAt);
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
    builtAt,
  );

  write(join(app, "sitemap.xml.body"), Buffer.from("<urlset>built</urlset>"), builtAt);
  write(
    join(app, "sitemap.xml.meta"),
    JSON.stringify({
      status: 200,
      headers: {
        "content-type": "application/xml",
        "x-next-cache-tags": "_N_T_/layout,_N_T_/sitemap.xml/route,_N_T_/sitemap.xml",
      },
    }),
    builtAt,
  );

  // Pages Router: `pages/<key>.html` and `.json`, no `.meta` (next/dist/export/routes/pages.js).
  const pages = join(serverDistDir, "pages");
  write(join(pages, "about.html"), "<html>built about</html>", builtAt);
  write(join(pages, "about.json"), JSON.stringify({ pageProps: { title: "about" } }), builtAt);

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
