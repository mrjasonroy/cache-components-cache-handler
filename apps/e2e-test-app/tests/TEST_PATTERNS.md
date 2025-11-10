# Test Patterns: Static vs Dynamic

This document explains the two core patterns we're testing and why both are essential for comprehensive cache handler validation.

## Pattern A: Pure Static Routes (No Dynamic APIs)

### Characteristics
- Uses `searchParams` (query params) for stable test IDs
- No `cookies()`, `headers()`, or other dynamic APIs
- Fully cacheable at build time
- No Suspense boundaries needed

### When to Use
- Testing pure caching behavior without dynamic content
- Verifying cache handlers work for static pages
- Testing `"use cache"` and `"use cache: remote"` in isolation

### Example Pages
- `/slow-db` - 10s remote cache (DB simulation)
- `/mixed-cache` - Mixed default + remote caches

### Example Test
```typescript
const testId = `test-${Date.now()}`;
await page.goto(`http://localhost:3000/slow-db?testId=${testId}`);

// First load: 10s (cache miss)
// Second load: <1s (cache hit!)
```

### Why This Matters
Proves our cache handlers work for fully static, pre-renderable content. This is the simplest case and should work flawlessly.

---

## Pattern B: Static Shell + Dynamic Content (With Suspense)

### Characteristics
- Uses `cookies()` or `headers()` for runtime data
- **Requires** `<Suspense>` boundaries around dynamic components
- Static shell pre-renders, dynamic content streams
- Fallback UI displays instantly

### When to Use
- Testing real-world patterns: cached layout + user-specific data
- Verifying cache handlers respect Suspense boundaries
- Testing mixed static/dynamic scenarios

### Example Pages
- `/dynamic-suspense` - Static header + dynamic user session + cached prefs

### Example Code
```tsx
export default async function Page() {
	const header = await getStaticHeader(); // "use cache: remote"

	return (
		<div>
			{/* Static shell - pre-rendered */}
			<h1>{header.title}</h1>

			{/* Dynamic content - streams with Suspense */}
			<Suspense fallback={<Skeleton />}>
				<UserSession /> {/* Uses cookies() */}
			</Suspense>

			{/* Cached dynamic content */}
			<Suspense fallback={<Skeleton />}>
				<UserPreferences /> {/* Uses cookies() but result cached */}
			</Suspense>
		</div>
	);
}
```

### Why This Matters
Proves our cache handlers work in production scenarios where:
- Some content is static and cached
- Some content is dynamic and always fresh
- Some content uses dynamic APIs but is still cached

---

## Pattern C: Error Case (Dynamic APIs Without Suspense)

### Characteristics
- Uses `cookies()` or `headers()` directly in page component
- **No** Suspense boundary
- Should throw error: "Uncached data was accessed outside of `<Suspense>`"

### When to Use
- Verify proper error handling
- Document what NOT to do
- Ensure our cache handler doesn't break Next.js error mechanisms

### Example Page
- `/error-cookies-no-suspense` - Intentional error case

### Why This Matters
Proves that our cache handler doesn't interfere with Next.js's safety mechanisms. Dynamic APIs outside Suspense should error, not silently break caching.

---

## Test Coverage Matrix

| Test Scenario | Pattern | Page | Cache Type | Dynamic API | Suspense |
|---------------|---------|------|------------|-------------|----------|
| Basic remote cache | A | `/slow-db` | remote | ❌ | ❌ |
| Mixed caches | A | `/mixed-cache` | default + remote | ❌ | ❌ |
| Static + dynamic | B | `/dynamic-suspense` | remote | ✅ cookies | ✅ |
| Error handling | C | `/error-cookies-no-suspense` | N/A | ✅ cookies | ❌ |
| revalidatePath | A | `/products` | default + remote | ❌ | ❌ |
| Nested caching | B | `/live-game` | remote | ✅ cookies | ✅ |

---

## Key Insights

### 1. searchParams vs cookies
- **searchParams** (via query params): Static pattern, no Suspense needed
- **cookies()**: Dynamic pattern, **requires Suspense**

### 2. Caching with Dynamic APIs
You CAN cache content that uses dynamic APIs, but:
1. Wrap the component in `<Suspense>`
2. Use `"use cache: remote"` in the data-fetching function
3. The dynamic API (cookies) is used to determine the cache key, but the result is cached

### 3. Why Both Patterns Matter
- **Pattern A** tests cache handlers in ideal conditions (pure static)
- **Pattern B** tests cache handlers in realistic conditions (mixed static/dynamic)
- **Pattern C** tests error handling (improper usage)

All three are essential for production-ready cache handlers.

---

## Migration Guide: Cookies to Query Params

If you have a test using cookies and want to convert to pure static:

### Before (Dynamic)
```tsx
export default async function Page() {
	const testId = (await cookies()).get('test-id')?.value || 'default';
	// ... ERROR: Uncached data outside Suspense!
}
```

### After (Static)
```tsx
export default async function Page({
	searchParams
}: {
	searchParams: { testId?: string }
}) {
	const testId = searchParams.testId || 'default';
	// ✅ Works! Fully static, cacheable
}
```

### Test Update
```typescript
// Before
await context.request.post('/api/test-setup', { data: { testId, scenario: 'test' } });
await page.goto('/page');

// After
await page.goto(`/page?testId=${testId}`);
```

---

## Future Test Ideas

1. **Headers pattern** - Test using `headers()` with Suspense
2. **Params from generateStaticParams** - Static params don't require Suspense
3. **Nested Suspense** - Multiple levels of streaming content
4. **Error boundaries** - How cache handlers interact with error states
5. **Loading states** - Verify fallback UI works correctly
