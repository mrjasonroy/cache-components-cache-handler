# Cache Handler Testing Strategy

## Goal
**Prove that our cache handlers correctly implement Next.js caching behavior**, not test Next.js itself.

We're verifying that:
- Our handlers store and retrieve data correctly
- Cache invalidation (revalidateTag, revalidatePath, updateTag) works
- Different cache types (default vs remote) are isolated
- Cache survives expected scenarios (persistence, parallel requests)

## Testing Approach: Timing + Stable IDs

### Why Timing?
**Timing doesn't lie.** If a 10-second operation becomes instant (<1s), the cache is working. If it becomes slow again after invalidation, cache busting works.

### Why Stable IDs?
**Reliable verification.** Instead of random IDs that make comparisons flaky, we inject stable test IDs via POST requests. This lets us:
- Verify exact cache hits (same ID + same timestamp = cached)
- Run parallel tests without interference (different cookies per browser context)
- Debug failures easily (know exactly what data should be present)

### Test Pattern
```typescript
// 1. Setup: Inject stable test ID via POST
POST /api/test-setup { testId: "test-123", scenario: "slow-db" }
  → Sets cookie: test-id-slow-db=test-123

// 2. First load: Slow (cache miss)
GET /slow-db
  → Reads cookie → Uses testId="test-123"
  → 10s delay simulating DB query
  → Returns: { userId: "test-123", timestamp: 1234567890 }
  ✅ Assert: duration > 10s

// 3. Second load: Fast (cache hit!)
GET /slow-db (reload)
  → Cache handler returns cached data
  → No delay, instant response
  ✅ Assert: duration < 1s
  ✅ Assert: userId = "test-123" (same)
  ✅ Assert: timestamp = 1234567890 (same = cached!)

// 4. Invalidate cache
POST /api/revalidate-tag { tag: "top-user" }
  → Our handler marks tag as stale

// 5. Third load: Slow again (cache miss after invalidation)
GET /slow-db (reload)
  → Cache miss, executes function again
  → 10s delay
  → Returns: { userId: "test-123", timestamp: 9876543210 }
  ✅ Assert: duration > 10s
  ✅ Assert: userId = "test-123" (same testId)
  ✅ Assert: timestamp ≠ 1234567890 (different = fresh data!)

// 6. Cleanup
POST /api/test-clear
  → Deletes all test cookies
```

## What We're Testing

### 1. Basic Remote Cache (`"use cache: remote"`)
**Purpose:** Database queries, API calls, external data
**Delay:** 10s (simulates slow DB)
**Tag:** `"top-user"`

**Tests:**
- ✅ Cache hit: 10s → <1s
- ✅ Same data returned (stable ID + timestamp match)
- ✅ revalidateTag invalidates cache: <1s → 10s
- ✅ Fresh data after invalidation (new timestamp)

**What this proves:**
- Our remote cache handler stores data correctly
- Retrieval works (cache hits are instant)
- Tag tracking works (can invalidate by tag)

---

### 2. Default Cache (`"use cache"`)
**Purpose:** Layout components, UI computation
**Delay:** 5s (simulates expensive computation)
**Tag:** `"layout"`

**Tests:**
- ✅ Cache hit: 5s → <1s
- ✅ Navigation away and back still cached
- ✅ Different from remote cache (isolation)

**What this proves:**
- Default cache handler works separately from remote
- Layout caching persists across navigation
- Cache types don't interfere

---

### 3. Mixed Cache (Default + Remote)
**Purpose:** Page with layout (default) + data (remote)
**Structure:**
- Layout: 5s, "use cache", tag: "layout"
- Stats: 8s, "use cache: remote", tag: "stats"
- Orders: 8s, "use cache: remote", tag: "orders"

**Tests:**
- ✅ First load: ~8s (parallel, max delay)
- ✅ All cached: <1s
- ✅ Revalidate "stats" only: stats refetches (8s), others instant
- ✅ Layout and orders unchanged (isolation)

**What this proves:**
- Both cache types coexist on same page
- Tag-based invalidation is granular (only affected cache refetches)
- Our handlers track tags correctly

---

### 4. Multi-Remote Sources
**Purpose:** Multiple external data sources on one page
**Structure:**
- User DB: 5s, "use cache: remote", tag: "user-db"
- Weather API: 5s, "use cache: remote", tag: "weather-api"
- Stock API: 5s, "use cache: remote", tag: "stock-api"

**Tests:**
- ✅ All sources cached independently
- ✅ Revalidate "weather-api": only weather refetches (5s), others instant
- ✅ Other sources unaffected

**What this proves:**
- Remote cache isolates different data sources
- Tag system works for multiple sources
- Granular invalidation works

---

### 5. Nested Cache (Uncached Parent + Cached Child)
**Purpose:** Live data parent with cached child component
**Structure:**
- Page: No cache, 2s
- LiveScores: No cache, 3s
- TeamRecord: "use cache: remote", 8s DB query, tag: "team"

**Tests:**
- ✅ First load: 8s (max of parallel)
- ✅ Second load: ~3s (TeamRecord cached, saved 8s!)
- ✅ Page and LiveScores always fresh (uncached)
- ✅ TeamRecord stays cached (same data)

**What this proves:**
- Cache works for individual components, not just full pages
- Uncached parent doesn't prevent child caching
- Real-world pattern: live scores + static team record

---

### 6. revalidatePath (Full Path Invalidation)
**Purpose:** Clear all caches under a path
**Structure:** `/products`
- ProductLayout: 4s, "use cache", tag: "product-layout"
- ProductList: 4s, "use cache: remote", tag: "product-list"
- Reviews: 4s, "use cache: remote", tag: "reviews"

**Tests:**
- ✅ All cached: <1s
- ✅ revalidatePath("/products"): ALL refetch (4s)
- ✅ Both default and remote caches cleared
- ✅ Other paths unaffected

**What this proves:**
- revalidatePath clears all cache types (not just one)
- Path-based invalidation works
- Our handlers respond to revalidatePath correctly

---

### 7. updateTag (Server Actions - Read-Your-Own-Writes)
**Purpose:** Immediate consistency in Server Actions
**Structure:**
- Counter: "use cache: remote", 5s DB query, tag: "counter"
- Server Action: increment + updateTag("counter")

**Tests:**
- ✅ updateTag: Waits for fresh data (5s), immediate consistency
- ✅ revalidateTag (profile="max"): Serves stale (<1s), background refresh
- ✅ Different behavior proves our handler supports both

**What this proves:**
- updateTag forces wait for fresh data (no stale)
- revalidateTag with profile="max" serves stale (different behavior)
- Our handler implements both correctly

---

### 8. Redis Persistence
**Purpose:** Cache survives Next.js restart
**Structure:**
- Page with 10s remote cache

**Tests:**
- ✅ Data cached: <1s
- ✅ Restart Next.js server (Redis stays up)
- ✅ Still cached: <1s (proves Redis persistence)
- ✅ Flush Redis: 10s again (cache miss)

**What this proves:**
- Redis handler stores data persistently
- Cache survives server restarts
- Production-ready for multi-instance deployments

---

### 9. Parallel Tests
**Purpose:** Multiple tests run simultaneously without interference
**Tests:**
- ✅ Two browser contexts with different test IDs
- ✅ Both load /slow-db in parallel
- ✅ Each gets their own stable ID (cookies per context)
- ✅ No cross-contamination

**What this proves:**
- Test infrastructure is solid
- Cookie-based test IDs work correctly
- Can run tests in parallel for speed

---

## Test Infrastructure

### APIs
- `POST /api/test-setup` - Set stable test ID for scenario (stores in cookie)
- `GET /api/test-setup?scenario=X` - Get current test ID
- `POST /api/test-clear` - Clear all test cookies
- `POST /api/revalidate-tag` - Invalidate cache by tag
- `POST /api/revalidate-path` - Invalidate cache by path
- Server Actions for updateTag testing

### Pages
- `/slow-db` - 10s remote cache (DB query)
- `/cached-layout-page` - 5s default cache (layout)
- `/mixed-cache` - Layout + remote data
- `/multi-remote` - Multiple remote sources
- `/live-game` - Uncached parent + cached child
- `/products` - revalidatePath test
- `/counter` - updateTag Server Action test

### Verification Methods
1. **Timing:** Duration proves cache hit/miss
2. **Stable IDs:** Verify exact data matches
3. **Timestamps:** Prove cached vs fresh data
4. **Parallel execution:** Prove isolation

---

## Critical: Dynamic APIs and Suspense Boundaries

### Dynamic APIs (Runtime-Only)
These APIs are **NOT cacheable** and require special handling:
- `cookies()` - Request-specific cookies
- `headers()` - Request headers
- `searchParams` - URL query parameters (as prop)
- `params` - Route params (unless from generateStaticParams)

### The Error: Uncached Data Outside Suspense
When dynamic APIs are accessed outside `<Suspense>`, Next.js throws:
```
Error: Route "/path": Uncached data was accessed outside of <Suspense>.
This delays the entire page from rendering
```

### The Solution: Suspense Boundaries
Wrap components that use dynamic APIs in `<Suspense>`:

```tsx
// ❌ WRONG - Blocks entire page render
export default async function Page() {
  const session = (await cookies()).get('session')?.value  // Error!
  return <div>{session}</div>
}

// ✅ CORRECT - Static shell + dynamic streaming
export default function Page() {
  return (
    <div>
      <h1>Pre-rendered Static Shell</h1>
      <Suspense fallback={<Skeleton />}>
        <UserSession />  {/* Uses cookies() inside */}
      </Suspense>
    </div>
  )
}

async function UserSession() {
  const session = (await cookies()).get('session')?.value  // Works!
  return <div>{session}</div>
}
```

### How It Works
1. **Static shell pre-renders** - Everything outside `<Suspense>`, including fallback UI
2. **Fallback displays instantly** - User sees skeleton immediately
3. **Dynamic content streams** - Component inside boundary executes on request
4. **Content replaces fallback** - When ready, dynamic content replaces skeleton

### Testing Both Patterns

We MUST test both scenarios to ensure our cache handler works correctly:

#### Pattern A: Pure Static Routes (No Dynamic APIs)
- Uses stable IDs via query params (`searchParams.testId`)
- Fully cacheable, no Suspense needed
- Tests pure caching behavior

#### Pattern B: Static Shell + Dynamic Content (With Suspense)
- Uses cookies for stable IDs (dynamic API)
- Static shell caches, dynamic content streams
- Tests real-world pattern: cached layout + runtime user data

## What We're NOT Testing

❌ How Next.js decides when to cache (not our concern)
❌ How Next.js generates cache keys (internal implementation)
❌ Next.js request handling (trust the framework)
❌ Browser behavior (trust Playwright)

## What We ARE Testing

✅ Our cache handlers store/retrieve data correctly
✅ Tag-based invalidation works
✅ Path-based invalidation works
✅ Different cache types are isolated
✅ Cache persistence (Redis)
✅ Real-world patterns (nested caching, mixed sources)
✅ Production scenarios (Server Actions, parallel requests)
✅ **NEW: Dynamic APIs with Suspense boundaries**
✅ **NEW: Static shell + dynamic streaming content**
✅ **NEW: Error handling for improper dynamic API usage**

---

## Success Criteria

A test passes when:
1. **Timing is correct:** Slow operations become fast (cached), then slow again (invalidated)
2. **Data is correct:** Stable IDs match, timestamps prove cache hits
3. **Isolation works:** Invalidating one cache doesn't affect others
4. **Behavior matches docs:** revalidateTag, updateTag, revalidatePath work as documented

If all tests pass, we've proven our cache handlers are **production-ready** and **Next.js-compatible**.
