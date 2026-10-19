/**
 * The prerendered build output, read through Next's own `FileSystemCache`.
 *
 * `next build` writes prerendered pages (`APP_PAGE`, `PAGES`) and route handler responses
 * (`APP_ROUTE`: sitemaps, robots, manifests) to `<distDir>/server` only. A custom `cacheHandler`
 * replaces `FileSystemCache` entirely, with no disk fallback, so without this every prerendered
 * route would miss on its first request and render again at runtime.
 *
 * The files are read by Next's own `FileSystemCache` (next/dist/server/lib/incremental-cache/
 * file-system-cache.js), built from the context Next passes to the handler's constructor (`fs`,
 * `serverDistDir`) with `flushToDisk: false` and no memory cache, so the file layout (`.html`,
 * `.rsc`, `.meta`, `.body`, segment data, route cache keys) is always the one the running Next
 * wrote. It never writes. The caller checks tags itself, with `lastModified` the build time.
 */

import { requireModule } from "../shared/node-require.js";
import type { PageCacheGetContext, PageCacheHandlerValue } from "./page-types.js";

/**
 * The kinds `next build` writes to disk. `FETCH` entries go to disk only with `flushToDisk`.
 */
const BUILD_OUTPUT_KINDS = new Set(["APP_PAGE", "APP_ROUTE", "PAGES"]);

const FILE_SYSTEM_CACHE_MODULE = "next/dist/server/lib/incremental-cache/file-system-cache.js";

interface FileSystemCache {
  get(cacheKey: string, ctx: PageCacheGetContext): Promise<PageCacheHandlerValue | null>;
}

type FileSystemCacheClass = new (ctx: {
  fs: unknown;
  serverDistDir: string;
  flushToDisk: boolean;
  revalidatedTags: string[];
  maxMemoryCacheSize: number;
}) => FileSystemCache;

/**
 * One `FileSystemCache` per `serverDistDir`, `null` when it could not be created. Next constructs
 * the page handler for every request; the build output is the same for all of them.
 */
const readers = new Map<string, FileSystemCache | null>();

function getFileSystemCache(
  fs: unknown,
  serverDistDir: string,
  onError: (error: unknown) => void,
): FileSystemCache | null {
  let reader = readers.get(serverDistDir);
  if (reader !== undefined) return reader;
  try {
    const FileSystemCache = requireModule<{ default: FileSystemCacheClass }>(
      FILE_SYSTEM_CACHE_MODULE,
    ).default;
    reader = new FileSystemCache({
      fs,
      serverDistDir,
      flushToDisk: false,
      revalidatedTags: [],
      maxMemoryCacheSize: 0,
    });
  } catch (error) {
    onError(error);
    reader = null;
  }
  readers.set(serverDistDir, reader);
  return reader;
}

/**
 * Read `cacheKey` from the build output, or `undefined` if it has none (not prerendered, a kind
 * that is never written to disk, no `fs`/`serverDistDir` from Next, or an unreadable file).
 */
export async function readBuildOutput(
  source: { fs?: unknown; serverDistDir?: string },
  cacheKey: string,
  ctx: PageCacheGetContext | undefined,
  onError: (error: unknown) => void,
): Promise<PageCacheHandlerValue | undefined> {
  const { fs, serverDistDir } = source;
  if (!fs || !serverDistDir || !ctx?.kind || !BUILD_OUTPUT_KINDS.has(ctx.kind)) return undefined;
  const reader = getFileSystemCache(fs, serverDistDir, onError);
  if (!reader) return undefined;
  try {
    const found = await reader.get(cacheKey, ctx);
    return found?.value ? found : undefined;
  } catch (error) {
    onError(error);
    return undefined;
  }
}

/**
 * Forget the cached readers. Test-only.
 * @internal
 */
export function resetBuildOutputForTests(): void {
  readers.clear();
}
