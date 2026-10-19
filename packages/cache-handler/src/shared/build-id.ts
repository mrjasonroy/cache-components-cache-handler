/**
 * The app's BUILD_ID, which scopes page and data keys so a deploy never serves another build's
 * entries.
 *
 * Next writes it to `<distDir>/BUILD_ID` and reads it from there (`NextNodeServer.getBuildId`,
 * next/dist/server/next-server.js). The `cacheHandlers` (plural) modules get no context from Next,
 * so the ID is resolved here, lazily on first use and once per process, from:
 *
 * 1. the `serverDistDir` (`<distDir>/server`) the singular `cacheHandler` receives in its
 *    constructor (next/dist/server/lib/incremental-cache/index.js), registered with
 *    {@link registerServerDistDir}. Exact under `next start`, standalone and a custom `distDir`;
 * 2. `distDir` from `__NEXT_PRIVATE_STANDALONE_CONFIG`, which a standalone `server.js` sets after
 *    `process.chdir(__dirname)` (template in next/dist/build/utils.js), relative to the cwd;
 * 3. `.next` under the cwd, which is where `next start` run from the project finds it.
 *
 * Without a readable BUILD_ID (`next dev`, tests) the ID is `development`, as Next's own in dev.
 *
 * `node:fs` and `node:path` are loaded on first use, not imported: this module is part of the page
 * handler, which Next also bundles into the edge middleware (see `./node-require.ts`).
 */

import { nodeBuiltin } from "./node-require.js";

const STATE_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/build-id");

/**
 * The build ID when none can be read.
 */
export const FALLBACK_BUILD_ID = "development";

interface BuildIdState {
  serverDistDir?: string;
  buildId?: string;
}

function getState(): BuildIdState {
  const store = globalThis as unknown as Record<symbol, BuildIdState | undefined>;
  let state = store[STATE_KEY];
  if (!state) {
    state = {};
    store[STATE_KEY] = state;
  }
  return state;
}

function path(): typeof import("node:path") {
  return nodeBuiltin<typeof import("node:path")>("node:path");
}

function readBuildIdFile(distDir: string): string | undefined {
  try {
    const { readFileSync } = nodeBuiltin<typeof import("node:fs")>("node:fs");
    return readFileSync(path().join(distDir, "BUILD_ID"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function standaloneDistDir(env: NodeJS.ProcessEnv): string | undefined {
  const config = env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  if (!config) return undefined;
  try {
    const distDir = (JSON.parse(config) as { distDir?: unknown }).distDir;
    return typeof distDir === "string" && distDir ? distDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the singular handler's `serverDistDir`, so the build ID is read from the exact
 * `distDir` Next uses. Has no effect once the ID is resolved.
 */
export function registerServerDistDir(serverDistDir: string | undefined): void {
  if (!serverDistDir) return;
  const state = getState();
  state.serverDistDir ??= serverDistDir;
}

/**
 * Find the build ID from the sources in this module's comment, without caching it.
 */
export function findBuildId(
  serverDistDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const { isAbsolute, join, resolve } = path();
  const candidates: string[] = [];
  if (serverDistDir) candidates.push(join(serverDistDir, ".."));
  const standalone = standaloneDistDir(env);
  if (standalone) candidates.push(isAbsolute(standalone) ? standalone : resolve(cwd, standalone));
  candidates.push(resolve(cwd, ".next"));

  for (const distDir of candidates) {
    const buildId = readBuildIdFile(distDir);
    if (buildId) return buildId;
  }
  return FALLBACK_BUILD_ID;
}

/**
 * The app's build ID, resolved on first call and then fixed for the process.
 */
export function getBuildId(): string {
  const state = getState();
  state.buildId ??= findBuildId(state.serverDistDir);
  return state.buildId;
}

/**
 * Forget the resolved build ID and registered `serverDistDir`. Test-only.
 * @internal
 */
export function resetBuildIdForTests(): void {
  const state = getState();
  state.buildId = undefined;
  state.serverDistDir = undefined;
}
