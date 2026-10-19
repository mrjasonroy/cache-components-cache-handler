/**
 * What the build output needs besides its files: when it was rendered, and how long each route
 * may be served from it.
 *
 * **Build time.** File mtimes are not the build time: a copy without `-p` moves them forward
 * (hiding revalidations made before the deploy), and reproducible image builds
 * (`SOURCE_DATE_EPOCH`, BuildKit, Nix) set them to 1970 or to a fixed date. So the page handler
 * writes its own stamp, `<distDir>/server/cache-handler-build.json` = `{ buildTime, buildId }`,
 * the first time it is constructed during `next build` (`NEXT_PHASE=phase-production-build`).
 * Next cleans `distDir` before it compiles and writes `BUILD_ID` before static generation, the
 * only time it constructs the handler in a build (next@16.4.2 next/dist/build/index.js: `clean`,
 * then `writeBuildId`, then `static-generation`), so the stamp names this build and predates every
 * page it renders. A stamp from another build (`cleanDistDir: false`) is replaced.
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

import { FALLBACK_BUILD_ID, getBuildId } from "../shared/build-id.js";
import { nodeBuiltin } from "../shared/node-require.js";

/**
 * The stamp's file name, in `serverDistDir`.
 */
export const BUILD_STAMP_FILE = "cache-handler-build.json";

const PRERENDER_MANIFEST_FILE = "prerender-manifest.json";

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
 * Write the build stamp unless this build already has one. Called during `next build`; never
 * throws (without a stamp the build output is only served conservatively).
 */
export function writeBuildStamp(serverDistDir: string, now: number = Date.now()): void {
  const buildId = getBuildId();
  // Collecting page data, before Next writes BUILD_ID: the static generation that follows stamps
  // the build.
  if (buildId === FALLBACK_BUILD_ID) return;
  const file = path().join(serverDistDir, BUILD_STAMP_FILE);
  const json = JSON.stringify({ buildTime: now, buildId } satisfies BuildStamp);
  try {
    fs().mkdirSync(serverDistDir, { recursive: true });
    // The first handler of the build wins; the build's other workers find it.
    fs().writeFileSync(file, json, { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
  }
  const existing = readJson<unknown>(file);
  if (isStamp(existing) && existing.buildId === buildId) return;
  try {
    const temporary = `${file}.${process.pid}`;
    fs().writeFileSync(temporary, json);
    fs().renameSync(temporary, file);
  } catch {
    // Left as it is: a stamp naming another build is ignored at runtime.
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
 * Next's route for a cache key (`/index` → `/`; next/dist/server/lib/to-route.js).
 */
function toRoute(cacheKey: string): string {
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
