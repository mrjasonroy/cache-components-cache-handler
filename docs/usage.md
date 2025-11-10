# Usage Examples

## Basic Caching

Cache a component's output:

```typescript
async function ProductList() {
  "use cache";

  const products = await db.products.findMany();
  return <ProductGrid products={products} />;
}
```

## Cache with Lifetime

```typescript
import { cacheLife } from "next/cache";

async function BlogPost({ id }: { id: string }) {
  "use cache";
  cacheLife("hours"); // Built-in: seconds, minutes, hours, days, weeks

  const post = await db.posts.findUnique({ where: { id } });
  return <Article post={post} />;
}
```

## Custom Cache Lifetimes

Define in `next.config.js`:

```javascript
module.exports = {
  experimental: {
    cacheComponents: true,
    cacheLife: {
      biweekly: {
        stale: 60 * 60 * 24 * 14,
        revalidate: 60 * 60 * 24 * 14,
        expire: 60 * 60 * 24 * 14,
      },
    },
  },
};
```

Use in components:

```typescript
async function BiweeklyReport() {
  "use cache";
  cacheLife("biweekly");

  const data = await generateReport();
  return <ReportView data={data} />;
}
```

## Tag-based Revalidation

Tag cache entries:

```typescript
import { cacheTag } from "next/cache";

async function UserProfile({ userId }: { userId: string }) {
  "use cache";
  cacheTag("user-profile", `user:${userId}`);

  const user = await db.user.findUnique({ where: { id: userId } });
  return <Profile user={user} />;
}
```

Invalidate by tag:

```typescript
// app/api/revalidate-user/route.ts
import { revalidateTag } from "next/cache";

export async function POST(request: Request) {
  const { userId } = await request.json();

  revalidateTag(`user:${userId}`);

  return Response.json({ revalidated: true, now: Date.now() });
}
```

## Path-based Revalidation

```typescript
// app/api/revalidate-products/route.ts
import { revalidatePath } from "next/cache";

export async function POST() {
  revalidatePath("/products");

  return Response.json({ revalidated: true });
}
```

## Remote Caching

Share cache across multiple instances:

```typescript
async function SharedData() {
  "use cache: remote";
  cacheTag("shared-data");

  const data = await fetchFromAPI();
  return <DataDisplay data={data} />;
}
```

## Combining Features

```typescript
import { cacheLife, cacheTag } from "next/cache";

async function ProductDetails({ id }: { id: string }) {
  "use cache";
  cacheLife("hours");
  cacheTag("product", `product:${id}`);

  const product = await db.product.findUnique({ where: { id } });
  return <ProductView product={product} />;
}
```

Invalidate specific product:

```typescript
revalidateTag(`product:${productId}`);
```

Invalidate all products:

```typescript
revalidateTag("product");
```
