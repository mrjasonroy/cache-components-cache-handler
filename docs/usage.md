# Usage Examples

With [`withCache`](./installation.md) in place, you write cached code with Next's own APIs. The
package maps one to one onto Next's directives; there are no extra modes or options. This page
shows which cache each one lands in.

| You write | Next's handler | Stored in | Shared across instances |
|---|---|---|---|
| `"use cache"` | `cacheHandlers.default` | each instance's memory | values no, invalidation yes |
| `"use cache: remote"` | `cacheHandlers.remote` | Redis | yes |
| `"use cache: private"` | none: Next's own | request-scoped on the server, then the browser's router cache | no |
| A page or route handler that Next prerenders or caches | `cacheHandler` | Redis (the page handler) | yes |
| `fetch(url, { cache: "force-cache" })` or `{ next: { revalidate } }` | `cacheHandler` | Redis (the page handler) | yes |

Without `REDIS_URL` everything stays in each instance's memory. To put an entry in Redis, use
`"use cache: remote"`; to keep it per instance, use `"use cache"`.

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

Either call reaches every instance and every handler. Pages and `"use cache: remote"` entries see
it on their very next read, on any instance, because each read fetches the entry's tag records from
Redis with the entry; each instance's in-memory `"use cache"` values see it from the next request
on, after the tag sync. [How it works](./how-it-works.md#distributed-tag-coordination-for-use-cache)
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

## Per-user data: `"use cache: private"`

`"use cache: private"` can read `cookies()`, `headers()` and `searchParams`, so it suits
personalized output. Next never hands it to a cache handler: on the server a result is reused only
within the same request, and the browser's router keeps it for the `cacheLife` `stale` time (lost
on reload). Nothing reaches Redis or this package's memory, and you can't configure a handler for
it. That's what you want for per-user data, and why you won't see these entries with `redis-cli`.

```tsx
import { cookies } from "next/headers";
import { cacheLife } from "next/cache";

async function getRecommendations(productId: string) {
  "use cache: private";
  cacheLife({ stale: 60 });
  const session = (await cookies()).get("session-id")?.value ?? "guest";
  return recommendationsFor(productId, session);
}
```

Don't move per-user data into `"use cache"` or `"use cache: remote"` to get it into Redis: those
entries are shared by every user. When the output only varies by a few values (a locale, a plan
tier), read the cookie outside the cached function and pass that value in: arguments are part of
the cache key, so each value gets its own shared entry.
See Next's [`"use cache: private"` docs](https://nextjs.org/docs/app/api-reference/directives/use-cache-private).

## Flushing everything

```ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

await flushCache();                  // this build's entries
await flushCache({ scope: "all" });  // every key under CACHE_KEY_PREFIX
```

Call it from a route you authenticate yourself. See
[Flushing the cache](./operations.md#flushing-the-cache) for an example route and what it does and
doesn't clear.
