/**
 * The scope of page and data keys, so a deploy never serves another deploy's entries: the app's
 * deployment ID when one is set, else its BUILD_ID.
 *
 * Next writes the BUILD_ID to `<distDir>/BUILD_ID` and reads it from there
 * (`NextNodeServer.getBuildId`, next/dist/server/next-server.js). The `cacheHandlers` (plural)
 * modules get no context from Next, so the ID is resolved here, lazily on first use and once per
 * process, from:
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
 * **Deployment ID.** With a deployment ID set (`deploymentId` in `next.config` or
 * `NEXT_DEPLOYMENT_ID`, for skew protection) and no `generateBuildId`, Next 16 gives every build
 * the same constant BUILD_ID, `build-TfctsWXpff2fKS` (`getBuildId` in next@16.4.3
 * next/dist/build/index.js), so the BUILD_ID no longer tells builds apart and the deployment ID
 * scopes the keys instead ({@link getCacheScope}). It is read, `''` counting as unset, from:
 *
 * 1. `deploymentId` in `__NEXT_PRIVATE_STANDALONE_CONFIG`, in a standalone `server.js`;
 * 2. otherwise `deploymentId` in the `config` of `<distDir>/required-server-files.json`, in the
 *    first of the `distDir`s above that has one. Next writes it before it collects page data, so
 *    it is current during `next build` too;
 * 3. `NEXT_DEPLOYMENT_ID`. Next sets `deploymentId` to `''` in both configs when
 *    `experimental.runtimeServerDeploymentId` is on, and reads the ID from this variable instead
 *    (`getNextConfigRuntime` in next/dist/server/config-shared.js, server/base-server.js).
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

const SERVER_FILES_MANIFEST = "required-server-files.json";

interface BuildIdState {
  serverDistDir?: string;
  buildId?: string;
  scope?: string;
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

function fs(): typeof import("node:fs") {
  return nodeBuiltin<typeof import("node:fs")>("node:fs");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readBuildIdFile(distDir: string): string | undefined {
  try {
    return fs().readFileSync(path().join(distDir, "BUILD_ID"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `config` of `<distDir>/required-server-files.json`, or `undefined` when it cannot be read.
 */
function readServerFilesConfig(distDir: string): Record<string, unknown> | undefined {
  try {
    const manifest = JSON.parse(
      fs().readFileSync(path().join(distDir, SERVER_FILES_MANIFEST), "utf8"),
    ) as unknown;
    return asRecord(asRecord(manifest)?.config);
  } catch {
    return undefined;
  }
}

function standaloneConfig(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const config = env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  if (!config) return undefined;
  try {
    return asRecord(JSON.parse(config));
  } catch {
    return undefined;
  }
}

/**
 * The `distDir`s to read, most exact first (see this module's comment).
 */
function candidateDistDirs(
  serverDistDir: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const { isAbsolute, join, resolve } = path();
  const candidates: string[] = [];
  if (serverDistDir) candidates.push(join(serverDistDir, ".."));
  const standalone = nonEmptyString(standaloneConfig(env)?.distDir);
  if (standalone) candidates.push(isAbsolute(standalone) ? standalone : resolve(cwd, standalone));
  candidates.push(resolve(cwd, ".next"));
  return candidates;
}

/**
 * Record the singular handler's `serverDistDir`, so the build ID and deployment ID are read from
 * the exact `distDir` Next uses. Has no effect on an ID already resolved.
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
  for (const distDir of candidateDistDirs(serverDistDir, env, cwd)) {
    const buildId = readBuildIdFile(distDir);
    if (buildId) return buildId;
  }
  return FALLBACK_BUILD_ID;
}

/**
 * Find the deployment ID from the sources in this module's comment, without caching it:
 * `undefined` when none is set.
 */
export function findDeploymentId(
  serverDistDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const standalone = standaloneConfig(env);
  const config =
    standalone ??
    candidateDistDirs(serverDistDir, env, cwd)
      .map(readServerFilesConfig)
      .find((found) => found !== undefined);
  return nonEmptyString(config?.deploymentId) ?? nonEmptyString(env.NEXT_DEPLOYMENT_ID);
}

/**
 * A deployment ID as a key segment: percent-encoded, so it has no `:` (the key separator),
 * whitespace or glob brackets, and two different IDs never give the same segment.
 */
export function deploymentScope(deploymentId: string): string {
  return encodeURIComponent(deploymentId);
}

/**
 * Find the key scope, the deployment ID when one is set and the build ID otherwise, without
 * caching it.
 */
export function findCacheScope(
  serverDistDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const deploymentId = findDeploymentId(serverDistDir, env, cwd);
  return deploymentId ? deploymentScope(deploymentId) : findBuildId(serverDistDir, env, cwd);
}

/**
 * The app's BUILD_ID, resolved on first call and then fixed for the process. Keys are scoped by
 * {@link getCacheScope}, which is this only when no deployment ID is set.
 */
export function getBuildId(): string {
  const state = getState();
  state.buildId ??= findBuildId(state.serverDistDir);
  return state.buildId;
}

/**
 * The scope of page and data keys (`<prefix><scope>:page|data:<key>`) and of `flushCache`'s
 * `scope: "build"`: the deployment ID when one is set, else the BUILD_ID. Resolved on first call
 * and then fixed for the process. A `buildId` option, where one is taken, replaces it.
 */
export function getCacheScope(): string {
  const state = getState();
  state.scope ??= findCacheScope(state.serverDistDir);
  return state.scope;
}

/**
 * Forget the resolved build ID, scope and registered `serverDistDir`. Test-only.
 * @internal
 */
export function resetBuildIdForTests(): void {
  const state = getState();
  state.buildId = undefined;
  state.scope = undefined;
  state.serverDistDir = undefined;
}
