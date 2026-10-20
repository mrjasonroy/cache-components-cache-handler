# Usage Examples

With [`withCache`](./installation.md) in place, you write cached code with Next's own APIs. This
page shows which cache each one lands in.

| You write | Stored in | Shared across instances |
|---|---|---|
| A page or route handler that Next prerenders or caches | Redis (the page handler) | yes |
| `fetch(url, { cache: "force-cache" })` or `{ next: { revalidate } }` | Redis (the page handler) | yes |
| `"use cache: remote"` | Redis | yes |
| `"use cache"` | each instance's memory (Redis with `useCache: "redis"`) | values no, invalidation yes |

## Basic caching

```tsx
async function ProductList() {
  "use cache";
  const products = await db.products.findMany();
  return <ProductGrid products={products} />;
}
```

## Cache lifetime

```tsx
import { cacheLife } from "next/cache";

async function BlogPost({ id }: { id: string }) {
  "use cache";
  cacheLife("hours"); // built in: seconds, minutes, hours, days, weeks, max

  const post = await db.posts.findUnique({ where: { id } });
  return <Article post={post} />;
}
```

Custom profiles go at the top level of the config you pass to `withCache`:

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache({
  cacheComponents: true,
  cacheLife: {
    biweekly: {
      stale: 60 * 60 * 24 * 14,
      revalidate: 60 * 60 * 24,
      expire: 60 * 60 * 24 * 14,
    },
  },
});
```

A plain `"use cache"` value lives in memory until its `revalidate` period has passed. A page or a
remote entry is kept in Redis longer (pages for `1.5 × revalidate`, capped at `expire`), so Next
can serve it stale and regenerate it in the background.

## Sharing across instances

```tsx
import { cacheTag } from "next/cache";

async function ExchangeRates() {
  "use cache: remote"; // one copy in Redis for every instance
  cacheTag("rates");
  return <Rates data={await fetchRates()} />;
}
```

Use `"use cache: remote"` for data that is expensive to compute and should be computed once per
fleet. Plain `"use cache"` is cheaper per lookup and is the right default for most components.

## Tag-based revalidation

```tsx
import { cacheTag } from "next/cache";

async function UserProfile({ userId }: { userId: string }) {
  "use cache";
  cacheTag("user-profile", `user:${userId}`);
  const user = await db.user.findUnique({ where: { id: userId } });
  return <Profile user={user} />;
}
```

```ts
// app/actions.ts
"use server";
import { revalidateTag, updateTag } from "next/cache";

export async function renameUser(userId: string, name: string) {
  await db.user.update({ where: { id: userId }, data: { name } });

  // Stale-while-revalidate: the next request gets the old copy once while a new one renders.
  revalidateTag(`user:${userId}`, "max");

  // Or read-your-own-writes from a Server Action: the next request renders fresh.
  // updateTag(`user:${userId}`);
}
```

Either call reaches every instance and every handler. Pages see it on their next read, on any
instance; `"use cache: remote"` entries and each instance's in-memory `"use cache"` values see it
from the next request on. [How it works](./how-it-works.md#distributed-tag-coordination-for-use-cache)
explains how.

## Path-based revalidation

```ts
// app/api/revalidate-products/route.ts
import { revalidatePath } from "next/cache";

export async function POST() {
  revalidatePath("/products");
  return Response.json({ revalidated: true });
}
```

## Keeping an entry out of Redis

Some data is per instance by nature, such as a health check or the build info. Tag it with
`MEMORY_ONLY_TAG` and it stays in that instance's memory:

```tsx
import { cacheTag } from "next/cache";
import { MEMORY_ONLY_TAG } from "@mrjasonroy/cache-components-cache-handler";

async function InstanceInfo() {
  "use cache: remote";
  cacheTag(MEMORY_ONLY_TAG);
  return <pre>{process.env.HOSTNAME}</pre>;
}
```

## Flushing everything

```ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

await flushCache();                  // this build's entries
await flushCache({ scope: "all" });  // every key under CACHE_KEY_PREFIX
```

Call it from a route you authenticate yourself. See
[Flushing the cache](./operations.md#flushing-the-cache) for an example route and what it does and
doesn't clear.
