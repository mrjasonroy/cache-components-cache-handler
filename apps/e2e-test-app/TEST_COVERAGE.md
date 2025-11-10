# E2E Test Coverage for Next.js 16 Cache APIs

This document tracks our test coverage for Next.js 16's cache APIs and identifies gaps.

## Test Status Legend
- ✅ **Implemented & Passing** - Test exists and validates the feature
- ⚠️ **Partial Coverage** - Basic test exists but missing edge cases
- ❌ **Missing** - No test coverage
- 🚧 **In Progress** - Currently being implemented

---

## 1. cacheLife() API

**Status**: ❌ **COMPLETELY MISSING**

**Documentation**: https://nextjs.org/docs/app/api-reference/functions/cacheLife

### Required Tests

#### Preset Profiles
- [ ] Test `'seconds'` profile timing
- [ ] Test `'minutes'` profile timing
- [ ] Test `'hours'` profile timing
- [ ] Test `'days'` profile timing
- [ ] Test `'weeks'` profile timing
- [ ] Test `'max'` profile timing

#### Custom Profiles
- [ ] Define custom profile in next.config and verify it works
- [ ] Test custom profile with all three properties (stale, revalidate, expire)
- [ ] Test custom profile overriding preset names

#### Inline Profiles
- [ ] Test inline profile object passed to cacheLife()
- [ ] Test inline profile scoped to specific function only

#### Cache Timing Properties
- [ ] Test `stale` - clients use cached data without server checks
- [ ] Test `revalidate` - background refresh after period
- [ ] Test `expire` - synchronous regeneration after no traffic

#### Edge Cases
- [ ] Test 30-second minimum enforcement for router cache
- [ ] Test nested components (shortest duration wins)
- [ ] Test invalid config (expire < revalidate) throws error
- [ ] Test empty object `cacheLife({})` uses defaults
- [ ] Test interaction with revalidateTag clearing cache

**Test File**: `tests/e2e/cache-life.spec.ts` (to be created)

---

## 2. cacheTag() API

**Status**: ⚠️ **PARTIALLY COVERED**

**Documentation**: https://nextjs.org/docs/app/api-reference/functions/cacheTag

### Covered Tests ✅
- ✅ Basic single tag assignment
- ✅ Multiple tags assignment

### Missing Tests

#### Tag Limits
- [ ] Test 256 character limit - boundary at 255, 256, 257
- [ ] Test 128 tag items limit - boundary at 127, 128, 129
- [ ] Verify proper error messages for exceeded limits

#### Tag Behavior
- [ ] Test idempotent behavior (same tag multiple times has no effect)
- [ ] Test dynamic tag generation from returned data properties
- [ ] Test case sensitivity of tags

#### Error Handling
- [ ] Test cacheTag() outside "use cache" context (should fail)
- [ ] Test cacheTag() with cacheComponents disabled

**Test File**: `tests/e2e/cache-tag-limits.spec.ts` (to be created)

---

## 3. revalidateTag() API

**Status**: ⚠️ **MISSING CRITICAL FEATURES**

**Documentation**: https://nextjs.org/docs/app/api-reference/functions/revalidateTag

### Covered Tests ✅
- ✅ Basic tag revalidation with deprecated single-argument form

### Missing Tests

#### Profile-Based Revalidation
- [ ] Test `revalidateTag(tag, 'max')` - stale-while-revalidate behavior
- [ ] Verify old content served immediately while new content fetches
- [ ] Test `revalidateTag(tag, { expire: 0 })` - immediate expiration
- [ ] Test custom cache life profile as second argument
- [ ] Compare behavior: single-arg (blocking) vs `'max'` (non-blocking)

#### Advanced Scenarios
- [ ] Test cross-page tag invalidation (same tag on multiple pages)
- [ ] Test revalidateTag in Server Actions vs Route Handlers
- [ ] Test case sensitivity of tag matching
- [ ] Test 256 character tag limit

**Test File**: `tests/e2e/revalidate-tag-profiles.spec.ts` (to be created)

---

## 4. revalidatePath() API

**Status**: ⚠️ **PARTIALLY COVERED**

**Documentation**: https://nextjs.org/docs/app/api-reference/functions/revalidatePath

### Covered Tests ✅
- ✅ Basic path revalidation for specific URL
- ✅ Clearing multiple caches under path

### Missing Tests

#### Type Parameter
- [ ] Test `revalidatePath('/blog/post-1', 'page')` - single page only
- [ ] Test `revalidatePath('/blog', 'layout')` - layout + nested pages
- [ ] Verify layout revalidation cascades to all children
- [ ] Test dynamic segment patterns with type

#### Path Constraints
- [ ] Test 1024 character limit for path
- [ ] Test case sensitivity
- [ ] Test special characters in paths

#### Context Differences
- [ ] Test Server Function behavior (immediate UI update)
- [ ] Test Route Handler behavior (marks for next visit)
- [ ] Test revalidation of Route Handler Data Cache

**Test File**: `tests/e2e/revalidate-path-advanced.spec.ts` (to be created)

---

## 5. updateTag() API

**Status**: ❌ **COMPLETELY MISSING**

**Documentation**: Part of cache-components docs

### Required Tests

#### Basic Functionality
- [ ] Test immediate cache expiration within request
- [ ] Compare with revalidateTag (immediate vs delayed)
- [ ] Test with custom cache life profiles

#### Use Cases
- [ ] Test webhook scenario requiring immediate expiration
- [ ] Test third-party service integration
- [ ] Test within Server Actions

**Test File**: `tests/e2e/update-tag.spec.ts` (to be created)

---

## 6. Cache Profiles (default vs remote)

**Status**: ⚠️ **PARTIALLY COVERED**

### Covered Tests ✅
- ✅ Basic remote cache testing
- ✅ Mixed default/remote cache testing
- ✅ Timing validation for remote cache

### Missing Tests

#### Profile Isolation
- [ ] Verify default profile changes don't affect remote
- [ ] Verify remote profile changes don't affect default
- [ ] Test with multiple custom profile names
- [ ] Test profile configuration in next.config.mjs

#### Profile Configuration
- [ ] Test defining custom profiles in next.config
- [ ] Test profile inheritance/fallbacks
- [ ] Test invalid profile names

**Test File**: `tests/e2e/cache-profiles.spec.ts` (to be created)

---

## 7. Partial Prerendering (PPR)

**Status**: ✅ **WELL COVERED**

### Covered Tests ✅
- ✅ Static shell renders immediately
- ✅ Dynamic content streams via Suspense
- ✅ Multiple Suspense boundaries
- ✅ Nested Suspense behavior

**Test Files**:
- `tests/e2e/dynamic-suspense-timing.spec.ts`
- `tests/e2e/suspense.spec.ts`

---

## 8. Edge Cases & Error Handling

**Status**: ❌ **MOSTLY MISSING**

### Required Tests

#### Serialization
- [ ] Test serializable function arguments work
- [ ] Test unserializable arguments (when not introspected) are acceptable
- [ ] Test unserializable arguments that ARE introspected fail properly

#### Suspense Requirements
- [ ] Test "Uncached data accessed outside Suspense" error
- [ ] Test runtime APIs (cookies, headers, searchParams) without Suspense
- [ ] Test proper error messages guide users to solution

#### Runtime API Restrictions
- [ ] Test cookies() requires Suspense wrapping
- [ ] Test headers() requires Suspense wrapping
- [ ] Test searchParams incompatible with "use cache"
- [ ] Test proper error handling for violations

#### Children Passthrough
- [ ] Test cached wrapper components accept non-serializable children
- [ ] Test children not introspected by cached component

#### Navigation State
- [ ] Test Activity component preserves state during navigation
- [ ] Test hidden/visible mode transitions

**Test File**: `tests/e2e/edge-cases.spec.ts` (to be created)

---

## Test Implementation Priority

### Phase 1: Critical Missing APIs (Week 1)
1. **cacheLife()** - Core API, completely untested
2. **revalidateTag with profiles** - Critical for production patterns
3. **updateTag()** - Important for immediate invalidation

### Phase 2: Edge Cases & Limits (Week 2)
4. **cacheTag limits** - Production robustness
5. **revalidatePath with type** - Layout cascading
6. **Cache profile isolation** - Multi-tier caching

### Phase 3: Error Handling (Week 3)
7. **Serialization requirements** - Developer experience
8. **Suspense error handling** - Better error messages
9. **Runtime API restrictions** - Proper guards

---

## Test Coverage Metrics

**Current Status** (as of test implementation):
- Total Features: 30
- Implemented: 18 (60%)
- Partial: 6 (20%)
- Missing: 6 (20%)

**Target**: 95% coverage of all documented Next.js 16 cache behaviors

---

## Running Tests

```bash
# Run all E2E tests
pnpm test:e2e

# Run specific test file
pnpm test:e2e tests/e2e/cache-life.spec.ts

# Run tests matching pattern
pnpm test:e2e --grep "cacheLife"

# Run tests in UI mode
pnpm test:e2e --ui
```

---

## Contributing

When adding new tests:
1. Update this document with ✅ for implemented tests
2. Follow existing test patterns for consistency
3. Use timing-based proofs where possible (10s → <1s)
4. Include both happy path and error cases
5. Document expected behavior in test descriptions
