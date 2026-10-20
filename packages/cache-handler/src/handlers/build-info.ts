/**
 * What the build output needs besides its files: when it was rendered, and how long each route
 * may be served from it.
 *
 * **Build time.** File mtimes are not the build time: a copy without `-p` moves them forward
 * (hiding revalidations made before the deploy), and reproducible image builds
 * (`SOURCE_DATE_EPOCH`, BuildKit, Nix) set them to 1970 or to a fixed date. So the page handler
 * writes its own stamp, `<distDir>/server/cache-handler-build.json` = `{ buildTime, buildId }`,
 * during `next build` (`NEXT_PHASE=phase-production-build`). Next cleans `distDir` before it
 * compiles, then constructs the handler while collecting page data, writes `BUILD_ID`, and
 * constructs it again for static generation in the same workers (next@16.4.2
 * next/dist/build/index.js: `clean`, `isPageStatic`, `writeBuildId`, `static-generation`). The
 * first construction stamps the time, a later one adds the build ID (see
 * {@link writeBuildStamp}), so the stamp names this build and predates every page it renders.
 *
 * **Lifetime.** A route with a revalidate period keeps its build output only as long as a render
 * of it is kept: `1.5 × revalidate`, capped at `expire`, from the build time. After that the
 * build copy is older than anything Next would serve, and a miss renders it again, as Next's
 * own cache would once its newer renders are gone. A route with `revalidate: false` keeps it until
 * a tag or a flush rejects it. The periods are the ones Next reads, from
 * `<distDir>/prerender-manifest.json` (`routes[route].initialRevalidateSeconds` and
 * `initialExpireSeconds`; next/dist/server/lib/incremental-cache/shared-cache-controls.external.js).
 *
 * Both files are read once per `distDir`, through `node:fs` loaded on first use (see
 * `../shared/node-require.ts`).
 */

import { getBuildId } from "../shared/build-id.js";
import { nodeBuiltin } from "../shared/node-require.js";

/**
 * The stamp's file name, in `serverDistDir`.
 */
export const BUILD_STAMP_FILE = "cache-handler-build.json";

const PRERENDER_MANIFEST_FILE = "prerender-manifest.json";

const ROUTE_CACHE_PREFIX = "/route-cache/";

interface BuildStamp {
  buildTime: number;
  buildId: string;
}

/**
 * A route's periods, in seconds, as the prerender manifest gives them.
 */
export interface RoutePeriods {
  revalidate: number | false;
  expire?: number;
}

interface PrerenderManifest {
  routes?: Record<
    string,
    { initialRevalidateSeconds?: number | false; initialExpireSeconds?: number }
  >;
}

const buildTimes = new Map<string, number | undefined>();
const manifests = new Map<string, PrerenderManifest | undefined>();

function fs(): typeof import("node:fs") {
  return nodeBuiltin<typeof import("node:fs")>("node:fs");
}

function path(): typeof import("node:path") {
  return nodeBuiltin<typeof import("node:path")>("node:path");
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs().readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isStamp(value: unknown): value is BuildStamp {
  const stamp = value as Partial<BuildStamp> | undefined;
  return typeof stamp?.buildTime === "number" && typeof stamp.buildId === "string";
}

/**
 * The `BUILD_ID` Next has written to `<serverDistDir>/..` so far, read now: during a build it
 * appears only between collecting page data and static generation, which run in the same
 * workers, so the process-wide {@link getBuildId} (resolved once) cannot be used here.
 */
function writtenBuildId(serverDistDir: string): string | undefined {
  try {
    const file = path().join(serverDistDir, "..", "BUILD_ID");
    return fs().readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeStamp(file: string, stamp: Partial<BuildStamp>): void {
  const temporary = `${file}.${process.pid}`;
  fs().writeFileSync(temporary, JSON.stringify(stamp));
  fs().renameSync(temporary, file);
}

/**
 * Write or complete the build stamp. Called each time the page handler is constructed during
 * `next build`; never throws (without a stamp the build output is only served conservatively).
 *
 * next@16.4.2 constructs it first while collecting page data, before `BUILD_ID` exists: the first
 * of those writes `{ buildTime }` (`wx`, so the build's other workers keep it). Static generation
 * constructs it again once `BUILD_ID` is written, and the build ID is added, keeping that time,
 * which precedes every prerender. A stamp naming another build than the `BUILD_ID` on disk was
 * left by an earlier build (`cleanDistDir: false`) and is replaced.
 */
export function writeBuildStamp(serverDistDir: string, now: number = Date.now()): void {
  const file = path().join(serverDistDir, BUILD_STAMP_FILE);
  const buildId = writtenBuildId(serverDistDir);
  const fresh: Partial<BuildStamp> = buildId ? { buildTime: now, buildId } : { buildTime: now };
  try {
    fs().mkdirSync(serverDistDir, { recursive: true });
    fs().writeFileSync(file, JSON.stringify(fresh), { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
  }
  try {
    const existing = readJson<Partial<BuildStamp>>(file);
    if (existing?.buildId === buildId && typeof existing?.buildTime === "number") return;
    if (existing?.buildId === undefined && typeof existing?.buildTime === "number") {
      // This build's stamp, written before BUILD_ID existed.
      if (buildId) writeStamp(file, { buildTime: existing.buildTime, buildId });
      return;
    }
    writeStamp(file, fresh);
  } catch {
    // Left as it is: a stamp without this build's ID is ignored at runtime.
  }
}

/**
 * When this build's output was rendered (ms), or `undefined` when the stamp is missing,
 * unreadable or names another build.
 */
export function readBuildTime(serverDistDir: string): number | undefined {
  if (buildTimes.has(serverDistDir)) return buildTimes.get(serverDistDir);
  const stamp = readJson<unknown>(path().join(serverDistDir, BUILD_STAMP_FILE));
  const buildTime = isStamp(stamp) && stamp.buildId === getBuildId() ? stamp.buildTime : undefined;
  buildTimes.set(serverDistDir, buildTime);
  return buildTime;
}

/**
 * The pathname of a response cache key. Next 16.4 keys responses by route,
 * `/route-cache/<kind>/<sha256 of the source route>/$<page path>`, where the page path is the
 * pathname with `/` as `/index` and a leading `/index` doubled (next/dist/server/lib/
 * route-cache-key.js, shared/lib/page-path/normalize-page-path.js). Earlier keys are the
 * pathname itself.
 */
function toPathname(cacheKey: string): string {
  if (!cacheKey.startsWith(ROUTE_CACHE_PREFIX)) return cacheKey;
  const marker = cacheKey.indexOf("/$/");
  if (marker === -1) return cacheKey;
  const page = cacheKey.slice(marker + 2);
  if (page === "/index") return "/";
  return page.startsWith("/index/") ? page.slice("/index".length) : page;
}

/**
 * The prerender manifest's route for a cache key (`/index` → `/`; next/dist/server/lib/
 * to-route.js).
 */
function toRoute(cacheKey: string): string {
  const pathname = toPathname(cacheKey);
  if (pathname !== cacheKey) return pathname.replace(/\/$/, "") || "/";
  return cacheKey.replace(/(?:\/index)?\/?$/, "") || "/";
}

/**
 * The prerendered route's periods, or `undefined` when the manifest does not list it (or cannot
 * be read).
 */
export function readRoutePeriods(
  serverDistDir: string,
  cacheKey: string,
): RoutePeriods | undefined {
  let manifest = manifests.get(serverDistDir);
  if (!manifests.has(serverDistDir)) {
    manifest = readJson<PrerenderManifest>(
      path().join(serverDistDir, "..", PRERENDER_MANIFEST_FILE),
    );
    manifests.set(serverDistDir, manifest);
  }
  const route = manifest?.routes?.[toRoute(cacheKey)];
  const revalidate = route?.initialRevalidateSeconds;
  if (revalidate === undefined) return undefined;
  return typeof route?.initialExpireSeconds === "number"
    ? { revalidate, expire: route.initialExpireSeconds }
    : { revalidate };
}

/**
 * Forget the stamps and manifests read. Test-only.
 * @internal
 */
export function resetBuildInfoForTests(): void {
  buildTimes.clear();
  manifests.clear();
}
