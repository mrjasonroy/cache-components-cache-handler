# Next.js 16 Breaking Changes

## Critical Breaking Changes for Cache Handler Testing

### 1. searchParams is Now Async (Promise-based) 🚨 CRITICAL

**Before (Next.js 15)**:
```tsx
export default async function Page({
  searchParams
}: {
  searchParams: { id?: string }
}) {
  const id = searchParams.id; // Direct access
  // ...
}
```

**After (Next.js 16)** ✅:
```tsx
export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>  // Now a Promise!
}) {
  const params = await searchParams;  // MUST await!
  const id = params.id;
  // ...
}
```

**🔥 CRITICAL: Not Awaiting BREAKS Caching!**

If you don't await `searchParams` or `params`, **cacheComponents will NOT work**:

```tsx
// ❌ BREAKS CACHING - Promise never resolves, blocks cache
export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>
}) {
  // NOT awaiting - cache handler can't cache this!
  const data = await fetchData();
  return <div>...</div>;
}

// ✅ CORRECT - Awaiting allows caching
export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>
}) {
  const params = await searchParams;  // Must await!
  const data = await fetchData();
  return <div>...</div>;
}
```

**Why This Matters for Tests**:
- ❌ **NOT AWAITING**: Cache handler never caches → every load is slow
- ❌ **NOT AWAITING**: Query params undefined → tests fail
- ✅ **AWAITING**: Cache works → 10s → <1s as expected
- ✅ **AWAITING**: Query params received → stable test IDs work

**Pro Tip: Pass Promises to Children**
You can pass the Promise down to child components to allow parent caching:

```tsx
export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>
}) {
  'use cache';

  // Don't await here - pass Promise down
  return <ChildComponent searchParams={searchParams} />;
}

async function ChildComponent({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>
}) {
  const params = await searchParams;  // Await in child
  // ...
}
```

This allows the parent to cache while children resolve params dynamically!

### 2. params is Also Async

**Before**:
```tsx
export default async function Page({
  params
}: {
  params: { slug: string }
}) {
  const { slug } = params;
}
```

**After**:
```tsx
export default async function Page({
  params
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params;
}
```

### 3. Dynamic APIs (cookies, headers) Require Suspense

**This hasn't changed from RC**, but it's now strictly enforced:

```tsx
// ❌ ERROR: Uncached data accessed outside <Suspense>
export default async function Page() {
  const session = (await cookies()).get('session');
}

// ✅ CORRECT
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <UserSession />
    </Suspense>
  );
}

async function UserSession() {
  const session = (await cookies()).get('session');
  return <div>{session}</div>;
}
```

### 4. Cache Components is Default

**Before**: Had to enable manually
**After**: `cacheComponents: true` is the default

```ts
// next.config.js
const config = {
  // cacheComponents: true  // No longer needed, it's default
}
```

### 5. cacheLife Replaces revalidate

**Before**:
```tsx
export const revalidate = 3600;
```

**After**:
```tsx
import { cacheLife } from 'next/cache';

export default async function Page() {
  'use cache';
  cacheLife('hours');  // Or 'days', 'weeks', 'max', custom number
}
```

## Testing Implications

### Query Param Tests (Pattern A)

All pages using `searchParams` must:
1. Type it as `Promise<{...}>`
2. Await it before accessing properties

**Files Updated**:
- `/slow-db/page.tsx`
- `/mixed-cache/page.tsx`
- `/products/page.tsx`

### Cookie Tests (Pattern B)

All pages using `cookies()` must:
1. Wrap components in `<Suspense>`
2. Provide fallback UI
3. Expect sequential streaming (not parallel)

**Files Using This Pattern**:
- `/dynamic-suspense/page.tsx`
- `/live-game/page.tsx`

## Migration Checklist

- [x] Update all `searchParams` to `Promise<{...}>`
- [x] Add `await searchParams` before accessing
- [x] Update all `params` to `Promise<{...}>`
- [x] Ensure cookies/headers wrapped in Suspense
- [x] Update timing expectations for sequential streaming
- [ ] Update documentation with these changes
- [ ] Run full test suite

## References

- [Next.js 16 Upgrade Guide](https://nextjs.org/docs/app/getting-started/upgrading)
- [Async Request APIs](https://nextjs.org/docs/app/api-reference/functions/cookies#async-cookies)
- [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components)
