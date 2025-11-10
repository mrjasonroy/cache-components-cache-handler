# E2E Test Suite - Next Steps & Cleanup

**Last Updated:** 2025-11-14

---

## 🎯 Critical Missing Tests for Cache Components

### 1. **cacheLife() API - PRIORITY 1** ❌

**Status:** Completely missing - This is the core API for controlling cache behavior!

**Why Critical:** `cacheLife()` controls TTL, stale-while-revalidate, and expiration - fundamental to cache components.

**Test File:** `tests/e2e/cache-life.spec.ts` (needs creation)

#### Required Tests:
- **Preset Profiles** (5 tests)
  - Test each preset: 'seconds', 'minutes', 'hours', 'days', 'weeks', 'max'
  - Verify timing behavior matches expected durations

- **Custom Profiles** (3 tests)
  - Define custom profile in next.config.mjs
  - Test with stale/revalidate/expire properties
  - Test overriding preset names

- **Cache Timing Properties** (3 tests)
  - `stale`: Client uses cached data without server check
  - `revalidate`: Background refresh after period
  - `expire`: Synchronous regeneration after inactivity

- **Edge Cases** (4 tests)
  - 30-second minimum for router cache
  - Nested components (shortest duration wins)
  - Invalid config validation
  - Interaction with revalidateTag

**Estimated Effort:** 2-3 hours

---

### 2. **cacheTag() Limits & Edge Cases - PRIORITY 2** ⚠️

**Status:** Basic tests exist, missing boundary/error cases

**Test File:** `tests/e2e/cache-tag-limits.spec.ts` (needs creation)

#### Required Tests:
- **Tag Length Limits** (3 tests)
  - Test 255 chars (valid)
  - Test 256 chars (boundary)
  - Test 257 chars (should error with clear message)

- **Tag Count Limits** (3 tests)
  - Test 127 tags (valid)
  - Test 128 tags (boundary)
  - Test 129 tags (should error)

- **Tag Behavior** (3 tests)
  - Idempotency (same tag multiple times)
  - Dynamic tag generation from data
  - Case sensitivity verification

**Estimated Effort:** 1-2 hours

---

### 3. **revalidateTag() Profile Behaviors - PRIORITY 3** ⚠️

**Status:** Basic revalidation works, missing profile-based behaviors

**Test File:** `tests/e2e/revalidate-tag-profiles.spec.ts` (needs creation)

#### Required Tests:
- **Stale-While-Revalidate** (2 tests)
  - Test `revalidateTag(tag, 'max')` serves stale content immediately
  - Verify background refetch happens

- **Immediate Expiration** (2 tests)
  - Test `revalidateTag(tag, { expire: 0 })`
  - Compare blocking vs non-blocking behavior

- **Custom Profiles** (2 tests)
  - Test with custom cache life profile
  - Verify profile properties are respected

**Estimated Effort:** 1-2 hours

---

### 4. **revalidatePath() Type Parameter - PRIORITY 4** ⚠️

**Status:** Basic path revalidation works, missing type parameter tests

**Test File:** `tests/e2e/revalidate-path-types.spec.ts` (needs creation)

#### Required Tests:
- **Type: 'page'** (2 tests)
  - Revalidates single page only
  - Doesn't cascade to children

- **Type: 'layout'** (2 tests)
  - Revalidates layout + all nested pages
  - Verify cascade behavior

- **Context Differences** (2 tests)
  - Server Action: immediate UI update
  - Route Handler: marks for next visit

**Estimated Effort:** 1 hour

---

### 5. **Error Handling & Edge Cases - PRIORITY 5** ❌

**Test File:** `tests/e2e/error-handling.spec.ts` (needs creation)

#### Required Tests:
- **Suspense Requirements** (3 tests)
  - Test "Uncached data accessed outside Suspense" error
  - Test cookies/headers without Suspense
  - Verify helpful error messages

- **Serialization** (3 tests)
  - Serializable arguments work
  - Non-serializable but not introspected work
  - Non-serializable + introspected fail properly

- **Runtime API Restrictions** (2 tests)
  - Test searchParams incompatible with "use cache"
  - Proper error for violations

**Estimated Effort:** 1-2 hours

---

## 🧹 Cleanup Tasks

### 1. **Remove Obsolete Route Handler** - HIGH PRIORITY

**File:** `apps/e2e-test-app/app/api/update/route.ts`

**Reason:** This is now replaced by Server Action in `app/revalidate-test/actions.ts`. The route handler version causes errors ("updateTag can only be called from Server Actions").

**Action:**
```bash
rm apps/e2e-test-app/app/api/update/route.ts
rmdir apps/e2e-test-app/app/api/update
```

---

### 2. **Update Test Skip Comments** - MEDIUM PRIORITY

**Files:**
- `tests/e2e/revalidation.spec.ts`
- `tests/e2e/suspense.spec.ts`

**Current State:** Tests are skipped with `.skip()` but no clear documentation why.

**Action:** Add clear comments explaining:
```typescript
test.skip("E2E-201: revalidateTag invalidates cached component", async ({ page }) => {
  // SKIPPED: This functionality is covered by cache-timing.spec.ts
  // and revalidation.spec.ts E2E-202. Keeping for reference.
```

---

### 3. **Clean Build Artifacts** - LOW PRIORITY

**Directories:**
- `apps/e2e-test-app/.next` (10MB)
- `apps/e2e-test-app/test-results` (4KB)
- `apps/e2e-test-app/playwright-report` (if exists)

**Action:** These are gitignored, but for clean development:
```bash
pnpm clean  # Removes .next and node_modules
```

**Note:** Turbo caching means rebuilds are fast, so cleaning is safe.

---

### 4. **Consolidate Test Setup** - MEDIUM PRIORITY

**Current State:**
- `app/api/test-setup/route.ts` - Used for test initialization
- `app/api/test-clear/route.ts` - Used for cache clearing

**Potential:** These might not be used anymore since we're using Server Actions. Verify usage:

```bash
grep -r "test-setup\|test-clear" apps/e2e-test-app/tests/
```

If unused, remove them.

---

### 5. **Update PROGRESS.md** - HIGH PRIORITY

**Current State:** Last updated 2025-01-10, doesn't reflect e2e test completion

**Action:** Update to reflect:
- ✅ E2E tests passing (21/21)
- ✅ Cache handler working in production
- 🚧 Missing: cacheLife tests, unit tests, Redis package

---

## 📊 Test Coverage Summary

### Current Coverage
- **Basic Caching:** ✅ 100%
- **Tag-Based Revalidation:** ✅ 90% (missing profile behaviors)
- **Path Revalidation:** ✅ 80% (missing type parameter)
- **Suspense/PPR:** ✅ 95% (missing error cases)
- **cacheLife API:** ❌ 0%
- **Edge Cases:** ⚠️ 40%

### Target Coverage
- **All Core APIs:** 95%+
- **Error Handling:** 80%+
- **Production Scenarios:** 100%

---

## 🚀 Recommended Implementation Order

### Phase 1: Critical Tests (This Week)
1. **cacheLife() API tests** - 2-3 hours
2. **Remove obsolete `/api/update` route** - 5 minutes
3. **Update PROGRESS.md** - 10 minutes

### Phase 2: Complete Coverage (Next Week)
4. **cacheTag() limits tests** - 1-2 hours
5. **revalidateTag() profile tests** - 1-2 hours
6. **Error handling tests** - 1-2 hours

### Phase 3: Polish (Week After)
7. **revalidatePath() type tests** - 1 hour
8. **Document all skip reasons** - 30 minutes
9. **Clean up unused test routes** - 30 minutes

---

## 💡 Additional Improvements

### 1. **Unit Tests for Cache Handler**
Currently only e2e tests exist. Add unit tests:
- `packages/cache-handler/src/data-cache/memory.test.ts` (file exists but empty)
- Test LRU eviction
- Test tag indexing
- Test edge cases

### 2. **Performance Benchmarks**
Add benchmark tests to track:
- Cache hit/miss performance
- Memory usage with large caches
- Tag index efficiency

### 3. **Integration Tests with Redis**
When Redis package is ready:
- Docker compose for Redis
- Integration tests
- Failover scenarios

---

## 📝 Notes

### Why cacheLife() is Critical
Without `cacheLife()` tests, we can't verify:
- TTL/expiration working correctly
- Stale-while-revalidate behavior
- Profile inheritance and overrides
- Router cache minimums

This is the **most important missing piece** for production confidence.

### Test Philosophy
Focus on:
1. **Timing-based proofs** (3s → <1s = caching works)
2. **State verification** (timestamps change/don't change)
3. **Isolation** (tag A doesn't affect tag B)
4. **Error messages** (helpful, actionable)

### When to Skip Cleanup
Don't clean up if it helps debugging:
- `test-results/` - Useful for CI screenshots
- `.next/` - Fast rebuilds with Turbo
- Skip comments - Document intent
