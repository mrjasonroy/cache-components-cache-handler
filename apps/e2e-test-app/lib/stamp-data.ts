import { cacheLife, cacheTag } from "next/cache";

function newStamp(kind: string, id: string): string {
  return `${kind}:${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/** `"use cache"`: per-instance memory by default, Redis when E2E_USE_CACHE=redis. */
export async function getLocalStamp(id: string): Promise<string> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag(`e2e-data-${id}`, `e2e-local-${id}`);
  return newStamp("local", id);
}

/** `"use cache: remote"`: shared by every instance through Redis when it is configured. */
export async function getRemoteStamp(id: string): Promise<string> {
  "use cache: remote";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag(`e2e-data-${id}`, `e2e-remote-${id}`);
  return newStamp("remote", id);
}
