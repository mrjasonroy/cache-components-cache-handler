# E2E Test Matrix for Next.js 16 Cache Components

This document outlines all test scenarios for validating cache handler behavior with Next.js 16+ cache components.

## Test Categories

### 1. Basic "use cache" Directive Tests

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-001 | `use cache` in async Server Component | Component output is cached, handler.set() called | HIGH |
| E2E-002 | `use cache` in page component | Page is cached, subsequent visits serve from cache | HIGH |
| E2E-003 | `use cache` in async utility function | Function result is cached across calls | HIGH |
| E2E-004 | Cached component with dynamic data | Data is fetched once, cached for subsequent requests | HIGH |
| E2E-005 | Multiple cached components on same page | Each component cached independently | MEDIUM |

### 2. Suspense Boundary Tests

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-101 | Cached component WITH Suspense boundary | Renders correctly, shows fallback during load | HIGH |
| E2E-102 | Cached component WITHOUT Suspense (no dynamic APIs) | Works fine, no error | HIGH |
| E2E-103 | Component accessing cookies WITHOUT Suspense | Error: "Uncached data was accessed outside of Suspense" | HIGH |
| E2E-104 | Component accessing headers WITHOUT Suspense | Error: "Uncached data was accessed outside of Suspense" | HIGH |
| E2E-105 | Nested Suspense boundaries with cached content | All boundaries work correctly | MEDIUM |

### 3. Tag-Based Revalidation Tests

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-201 | `revalidateTag()` invalidates cached component | Cache invalidated, fresh render on next request | HIGH |
| E2E-202 | `updateTag()` immediate expiration | Cache invalidated within same request | HIGH |
| E2E-203 | Multiple tags on single component | All tags work for revalidation | MEDIUM |
| E2E-204 | Revalidating tag affects only tagged components | Other cached components unaffected | HIGH |
| E2E-205 | Revalidating non-existent tag | No error, graceful handling | LOW |

### 4. cacheLife() Tests

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-301 | `cacheLife('hours')` with use cache | Cache expires after configured time | HIGH |
| E2E-302 | `cacheLife('days')` with use cache | Cache persists for days | MEDIUM |
| E2E-303 | Custom cacheLife with seconds | Cache respects custom TTL | HIGH |
| E2E-304 | cacheLife without use cache | Error or ignored | LOW |

### 5. Cache Handler Integration Tests

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-401 | Verify handler.set() called on first render | Cache handler receives set() call with correct data | HIGH |
| E2E-402 | Verify handler.get() called on subsequent render | Cache handler get() returns cached value | HIGH |
| E2E-403 | Verify handler.revalidateTag() called | Handler receives revalidateTag() call | HIGH |
| E2E-404 | Verify cache tags stored correctly | Tags passed to handler in context | HIGH |
| E2E-405 | Verify cache keys are consistent | Same component generates same key | MEDIUM |
| E2E-406 | Verify handler receives implicit tags | Implicit _N_T_ tags present in meta | HIGH |

### 6. Error Handling & Edge Cases

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-501 | Handler.get() throws error | Falls back to re-render, no crash | HIGH |
| E2E-502 | Handler.set() throws error | Continues rendering, logs error | MEDIUM |
| E2E-503 | Cached function with non-serializable args | Error or warning | MEDIUM |
| E2E-504 | use cache in Client Component | Build error or runtime error | LOW |
| E2E-505 | use cache with Edge Runtime | Error message | LOW |

### 7. Build-Time vs Runtime Caching

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-601 | Cached component during build | Handler called during build process | MEDIUM |
| E2E-602 | Cached component at runtime | Handler called at runtime | HIGH |
| E2E-603 | Static generation with cache | Cache populated during build | LOW |

### 8. Complex Scenarios

| Test ID | Scenario | Expected Behavior | Priority |
|---------|----------|-------------------|----------|
| E2E-701 | Nested cached components | All levels cached correctly | MEDIUM |
| E2E-702 | Cached layout + cached page | Both cached independently | HIGH |
| E2E-703 | Parallel data fetching in cached component | All fetches cached | MEDIUM |
| E2E-704 | Sequential revalidations | Cache invalidates correctly each time | HIGH |
| E2E-705 | High-frequency cache updates | Handler performs well under load | LOW |

## Test Implementation Plan

### Phase 1: Critical Path (Must Have)
- E2E-001, E2E-002, E2E-003 - Basic caching works
- E2E-101, E2E-103 - Suspense boundary behavior
- E2E-201, E2E-202 - Tag-based revalidation
- E2E-401, E2E-402, E2E-403 - Handler integration
- E2E-501 - Error handling

### Phase 2: Core Functionality (Should Have)
- E2E-004, E2E-005 - Multiple components
- E2E-203, E2E-204 - Multiple tags
- E2E-301, E2E-303 - cacheLife
- E2E-404, E2E-406 - Correct data to handler
- E2E-602, E2E-704 - Runtime behavior

### Phase 3: Edge Cases (Nice to Have)
- E2E-102, E2E-104, E2E-105 - Edge Suspense cases
- E2E-205, E2E-304, E2E-405 - Edge cases
- E2E-502, E2E-503 - Error scenarios
- E2E-601, E2E-603 - Build-time
- E2E-701, E2E-702, E2E-703, E2E-705 - Complex scenarios

## Test Environment Setup

### Required
- Next.js 16+ with cacheComponents enabled
- Playwright for E2E testing
- Test database or mock API for data fetching
- Our cache handler configured

### Test App Structure
```
apps/e2e-test-app/
├── app/
│   ├── layout.tsx
│   ├── page.tsx (basic cached page)
│   ├── cached-component/
│   │   └── page.tsx (cached Server Component)
│   ├── cached-function/
│   │   └── page.tsx (cached utility function)
│   ├── suspense-test/
│   │   └── page.tsx (Suspense boundary tests)
│   ├── revalidate-test/
│   │   └── page.tsx (tag revalidation)
│   └── api/
│       ├── revalidate/
│       │   └── route.ts (trigger revalidateTag)
│       └── update/
│           └── route.ts (trigger updateTag)
├── tests/
│   └── e2e/
│       ├── basic-caching.spec.ts
│       ├── suspense.spec.ts
│       ├── revalidation.spec.ts
│       ├── handler-integration.spec.ts
│       └── error-handling.spec.ts
└── next.config.ts (with our cache handler)
```

## Success Criteria

✅ **All Phase 1 tests pass** - Basic caching functionality works
✅ **Handler integration verified** - Our handler receives correct calls
✅ **Tags work correctly** - Revalidation invalidates correct components
✅ **Error handling graceful** - No crashes on handler errors
✅ **Documentation updated** - Test results documented

## Next Steps

1. Create test app with Next.js 16
2. Implement Phase 1 tests
3. Run tests and document results
4. Fix any issues in cache handler
5. Implement Phase 2 tests
6. Repeat until all critical tests pass
