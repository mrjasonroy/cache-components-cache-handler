# Reference Implementation Analysis - Index

This index helps you navigate the comprehensive analysis of the old `@fortedigital/nextjs-cache-handler` (v2.1.7) implementation, which serves as the reference for the new `better-nextjs-cache-handler` project.

## Quick Navigation

### For Understanding Architecture
Start here to learn how the old implementation works:
- **[REFERENCE_ANALYSIS.md](./REFERENCE_ANALYSIS.md)** - Complete overview
  - Section 1: Package structure and organization
  - Section 2: Key features (Redis, LRU, Composite handlers)
  - Section 3: Important implementation details
  - Section 4: Test patterns
  - Section 5: Next.js 16 features
  - Section 6: Critical functionality & edge cases
  - Section 7: Decision points for new implementation

### For Code Implementation
When implementing features, reference these patterns:
- **[CODE_PATTERNS.md](./CODE_PATTERNS.md)** - 15 essential patterns
  1. Handler interface & types
  2. Timeout pattern with AbortSignal
  3. Cursor-based iteration
  4. Multi-handler fault tolerance
  5. Buffer/string conversion
  6. Implicit tag tracking
  7. Tag extraction
  8. TTL calculation
  9. Expiration check
  10. LRU revalidation
  11. Composite handler
  12. Debug logging
  13. Redis Cluster adapter
  14. onCreation hook
  15. Redis set operations

Each pattern includes:
- Full working code example
- Explanation of why it's important
- Common pitfalls to avoid

### For Project Management
Track implementation progress:
- **[IMPLEMENTATION_CHECKLIST.md](./IMPLEMENTATION_CHECKLIST.md)** - 200+ items
  - Core types & interfaces (35+ items)
  - CacheHandler class (12+ items)
  - Redis handler (15+ items)
  - LRU handler (10+ items)
  - Composite handler (5+ items)
  - Helper utilities (20+ items)
  - Instrumentation (8+ items)
  - Error handling (8+ items)
  - Logging & debugging (5+ items)
  - Time handling (8+ items)
  - Edge cases (10+ items)
  - Testing requirements (10+ items)
  - Documentation requirements (8+ items)
  - Performance & production readiness (10+ items)
  - Code quality (10+ items)
  - Package setup (15+ items)

## Critical Information by Topic

### Handlers
See each handler implementation in CODE_PATTERNS.md:

**Redis Handler** (redis-strings)
- Pattern 2: Timeout pattern
- Pattern 3: Cursor-based iteration
- Pattern 5: Buffer conversion
- Pattern 6: Implicit tag tracking
- Pattern 15: Redis set operations
- Also: REFERENCE_ANALYSIS.md § 2.A

**LRU Handler** (local-lru)
- Pattern 10: LRU revalidation pattern
- Also: REFERENCE_ANALYSIS.md § 2.B

**Composite Handler**
- Pattern 11: Composite handler pattern
- Also: REFERENCE_ANALYSIS.md § 2.C

### Core Patterns (Read First)

1. **Handler Interface** (Pattern 1)
   - Required for all implementations
   - Type definitions essential

2. **Timeout & Abort** (Patterns 2, 13)
   - CRITICAL for production reliability
   - Memory leak prevention essential

3. **Multi-Handler** (Pattern 4)
   - Fault tolerance mechanism
   - Promise.allSettled() vs Promise.all()

4. **Buffer Handling** (Pattern 5)
   - Next.js 15+ compatibility
   - Both directions required

### Important Details

**Implicit vs Explicit Tags**
- Implicit: `_N_T_` prefix (system-generated)
- Explicit: user-defined tags
- Different revalidation logic
- See Pattern 6 & REFERENCE_ANALYSIS.md § 3

**Time Units (Critical!)**
- `lastModified`: milliseconds (Date.now())
- `lastModifiedAt`: seconds (Unix timestamp)
- `expireAt`: seconds (Unix timestamp)
- See Pattern 8 & REFERENCE_ANALYSIS.md § 3

**Memory Leak Prevention**
- Event listener cleanup (Pattern 2)
- Cursor-based iteration (Pattern 3)
- TTL-bound hashmaps (REFERENCE_ANALYSIS.md § 2.A)
- Non-blocking cleanup

**Error Handling**
- Promise.allSettled() for handlers (Pattern 4)
- Continue to next handler on failure
- No silent failures
- Comprehensive logging
- See REFERENCE_ANALYSIS.md § 6

## Implementation Roadmap

### Phase 1: Foundation (Types & Core)
Required before anything else:
1. Read REFERENCE_ANALYSIS.md § 1 (Package structure)
2. Read REFERENCE_ANALYSIS.md § 3 (Data structures)
3. Implement Pattern 1 (Handler interface)
4. Implement Pattern 8 (TTL calculation)
5. Setup IMPLEMENTATION_CHECKLIST.md "Core Types & Interfaces"

### Phase 2: CacheHandler
Main orchestrator:
1. Read REFERENCE_ANALYSIS.md § 3 (Cache value structure)
2. Implement Pattern 14 (onCreation hook)
3. Implement time handling (Pattern 8)
4. Implement expiration check (Pattern 9)
5. Setup IMPLEMENTATION_CHECKLIST.md "CacheHandler Class"

### Phase 3: Handlers
Three handler implementations:
1. **Redis Handler**
   - Pattern 2 (Timeout)
   - Pattern 3 (Cursor iteration)
   - Pattern 15 (Set operations)
   - IMPLEMENTATION_CHECKLIST.md "Redis Handler"

2. **LRU Handler**
   - Pattern 10 (Revalidation)
   - IMPLEMENTATION_CHECKLIST.md "LRU Handler"

3. **Composite Handler**
   - Pattern 11
   - IMPLEMENTATION_CHECKLIST.md "Composite Handler"

### Phase 4: Utilities
Helper functions:
1. Timeout & Abort (Patterns 2, 13)
2. Buffer conversion (Pattern 5)
3. Tag utilities (Patterns 6, 7)
4. TTL utilities (Pattern 8)
5. Debug logging (Pattern 12)
6. IMPLEMENTATION_CHECKLIST.md "Helper Utilities"

### Phase 5: Instrumentation
Build-time setup:
1. registerInitialCache() function
2. Pre-warm from disk
3. IMPLEMENTATION_CHECKLIST.md "Instrumentation"

### Phase 6: Testing & Documentation
Quality assurance:
1. IMPLEMENTATION_CHECKLIST.md "Testing Requirements"
2. IMPLEMENTATION_CHECKLIST.md "Documentation Requirements"

## Key Takeaways

### DO NOT MISS
From REFERENCE_ANALYSIS.md § 6:
1. Implicit tag revalidation (separate tracking)
2. Shared tag maps with TTL (prevents memory leaks)
3. Buffer/string conversion (both directions)
4. AbortSignal timeout pattern (EVERY operation)
5. Global singleton pattern (connection management)
6. Fallback false routes (Pages Router support)
7. Tag extraction from headers
8. Concurrent operations (Promise patterns)
9. Debug logging support
10. Entry expiration check (time units!)

### Critical Rules (From CODE_PATTERNS.md)
1. Always validate expireAt in SECONDS
2. Always use AbortSignal.timeout() for Redis
3. Always use Promise.allSettled() for handlers
4. Always handle Buffer conversion (both ways)
5. Always track implicit tags separately
6. Always clean up event listeners
7. Always use cursor-based HSCAN
8. Always check isReady before operations
9. Always log errors (no silent failures)
10. Always run revalidateTag + revalidateSharedKeys

## Cross-References

### Timeout Pattern
- CODE_PATTERNS.md Pattern 2
- CODE_PATTERNS.md Pattern 13
- REFERENCE_ANALYSIS.md § 3 (Timeout/Abort Handling)
- IMPLEMENTATION_CHECKLIST.md (Timeout & Abort Handling)

### Buffer Conversion
- CODE_PATTERNS.md Pattern 5
- REFERENCE_ANALYSIS.md § 3 (Buffer/String Conversion)
- IMPLEMENTATION_CHECKLIST.md (Buffer Conversion)

### Tag Handling
- CODE_PATTERNS.md Pattern 6 (Implicit tags)
- CODE_PATTERNS.md Pattern 7 (Tag extraction)
- REFERENCE_ANALYSIS.md § 3 (Tag Handling)
- IMPLEMENTATION_CHECKLIST.md (Tag & Revalidation)

### Error Handling
- CODE_PATTERNS.md Pattern 4 (Multi-handler)
- REFERENCE_ANALYSIS.md § 6 (Critical functionality)
- IMPLEMENTATION_CHECKLIST.md (Error Handling & Resilience)

### Redis Handler
- REFERENCE_ANALYSIS.md § 2.A (Features)
- REFERENCE_ANALYSIS.md § 3 (Implementation details)
- CODE_PATTERNS.md Pattern 15 (Redis operations)
- CODE_PATTERNS.md Pattern 3 (Cursor iteration)
- CODE_PATTERNS.md Pattern 2 (Timeout)

### LRU Handler
- REFERENCE_ANALYSIS.md § 2.B (Features)
- CODE_PATTERNS.md Pattern 10 (Revalidation)

### Composite Handler
- REFERENCE_ANALYSIS.md § 2.C (Features)
- CODE_PATTERNS.md Pattern 11 (Implementation)

## Testing Strategy

From REFERENCE_ANALYSIS.md § 4 & IMPLEMENTATION_CHECKLIST.md:

**Unit Tests**
- withAbortSignal (Pattern 2)
- Buffer conversion (Pattern 5)
- TTL calculation (Pattern 8)
- Tag extraction (Pattern 7)
- Age estimation (Pattern 8)

**Integration Tests**
- Handler get/set/revalidateTag
- Composite routing
- Error paths

**Edge Cases to Test**
All items in IMPLEMENTATION_CHECKLIST.md "Edge Cases"

**E2E Tests**
- Actual Redis (Docker)
- Full Next.js 16 cache flow
- Tag revalidation in production

## Questions to Answer Before Coding

1. **What is an implicit tag?**
   - Answer: CODE_PATTERNS.md Pattern 6 & REFERENCE_ANALYSIS.md § 3

2. **How should timeouts work?**
   - Answer: CODE_PATTERNS.md Pattern 2

3. **Why are there two hash maps in Redis?**
   - Answer: REFERENCE_ANALYSIS.md § 2.A (prevents memory leaks)

4. **What's the expiration check logic?**
   - Answer: CODE_PATTERNS.md Pattern 9

5. **How do handlers communicate?**
   - Answer: CODE_PATTERNS.md Pattern 4 & 11

6. **What about Buffer conversion?**
   - Answer: CODE_PATTERNS.md Pattern 5

7. **When should I use Promise.all vs allSettled?**
   - Answer: CODE_PATTERNS.md Pattern 4 & 15

8. **How is the Redis client managed?**
   - Answer: REFERENCE_ANALYSIS.md § 3 (Connection Management)

9. **What are the edge cases?**
   - Answer: REFERENCE_ANALYSIS.md § 6 & IMPLEMENTATION_CHECKLIST.md

10. **How to ensure reliability?**
    - Answer: All of REFERENCE_ANALYSIS.md § 6

---

**Last Updated**: November 10, 2025
**Source**: @fortedigital/nextjs-cache-handler v2.1.7
**Target**: better-nextjs-cache-handler (improved, cleaner version)

