/**
 * Node built-ins and `require`, reached on first use through `process.getBuiltinModule` (Node
 * 20.16+, 22.3+), never through an `import`.
 *
 * Next bundles the page `cacheHandler` into the edge middleware too
 * (`OPTIONAL_IMPORT:incrementalCacheHandler` in next/dist/build/templates/middleware.js). There a
 * Node built-in fails as soon as it is loaded: Turbopack's edge chunks throw `Failed to load
 * external module node:module: TypeError: Native module not found` while the module graph is
 * evaluated, and webpack's stand-ins (`__import_unsupported`) throw on first use. So no module the
 * handler entries import may import a `node:` specifier, statically or dynamically
 * (`entries/node-imports.test.ts` checks the graph), and nothing here runs until a handler needs
 * it, which never happens on the edge runtime.
 */

let nodeRequire: NodeJS.Require | undefined;

/**
 * A Node built-in (`node:fs`, `node:path`, `node:module`).
 */
export function nodeBuiltin<T>(id: string): T {
  const builtin = process.getBuiltinModule?.(id) as T | undefined;
  if (builtin === undefined) {
    throw new Error(`Cannot load ${id}: this package needs Node.js 22.3 or later`);
  }
  return builtin;
}

/**
 * `require(id)` relative to this package.
 */
export function requireModule<T>(id: string): T {
  return packageRequire()(id) as T;
}

/**
 * The exports of `id`, resolved relative to this package, if this process has already loaded it
 * through `require`; never loads it. Throws if `id` cannot be resolved.
 */
export function loadedModule<T>(id: string): T | undefined {
  const require = packageRequire();
  return require.cache[require.resolve(id)]?.exports as T | undefined;
}

function packageRequire(): NodeJS.Require {
  nodeRequire ??= nodeBuiltin<typeof import("node:module")>("node:module").createRequire(
    import.meta.url,
  );
  return nodeRequire;
}
