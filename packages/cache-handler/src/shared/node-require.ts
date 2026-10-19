/**
 * Node's `require`, created on first use.
 *
 * Next bundles the page `cacheHandler` into the edge middleware too
 * (`OPTIONAL_IMPORT:incrementalCacheHandler` in next/dist/build/templates/middleware.js). There,
 * `node:module`, `node:fs` and `node:path` are stubs that throw when anything on them is called
 * (`__import_unsupported`, next/dist/server/web/globals.js). Calling `createRequire` while the
 * module is evaluated would take every request down with it, so nothing in this package touches a
 * Node built-in until a handler actually needs one, which never happens on the edge runtime.
 */

import { createRequire } from "node:module";

let nodeRequire: NodeJS.Require | undefined;

/**
 * `require(id)` relative to this package.
 */
export function requireModule<T>(id: string): T {
  nodeRequire ??= createRequire(import.meta.url);
  return nodeRequire(id) as T;
}

/**
 * A Node built-in (`node:fs`, `node:path`), through `process.getBuiltinModule` where Node has it
 * (20.16+, 22.3+) and `require` otherwise.
 */
export function nodeBuiltin<T>(id: string): T {
  return (process.getBuiltinModule?.(id) as T | undefined) ?? requireModule<T>(id);
}
