# Architecture & Design Decisions

## Core Decisions

### 1. **Monorepo with Turborepo**
**Decision:** Use Turborepo for monorepo management
**Rationale:**
- Fast, incremental builds
- Built-in caching
- Simple configuration
- Better than Lerna/Nx for our scale
- Great developer experience

**Alternatives Considered:**
- Nx: Too complex for our needs
- Lerna: Legacy, less maintained
- Manual workspace: Too much manual work

---

### 2. **pnpm Over npm/yarn**
**Decision:** Use pnpm as package manager
**Rationale:**
- Faster installation
- Better disk space efficiency
- Strict dependency resolution
- First-class workspace support
- Industry standard for monorepos

---

### 3. **Biome Over ESLint + Prettier**
**Decision:** Use Biome for linting and formatting
**Rationale:**
- Single tool for both linting and formatting
- Much faster than ESLint + Prettier combo
- Built-in import sorting
- Written in Rust - extremely fast
- Growing ecosystem

**Trade-offs:**
- Fewer plugins than ESLint
- Newer tool (less mature)
- Worth it for speed and simplicity

---

### 4. **Next.js 16+ Only**
**Decision:** Support only Next.js 16 and above
**Rationale:**
- Next.js 16 has completely new caching system
- "use cache" directive is fundamentally different
- Trying to support both old and new would be complex
- Clean break allows for better API design
- Users on older Next.js can use old package

---

### 5. **TypeScript Strict Mode**
**Decision:** Enable all strict TypeScript checks
**Rationale:**
- Catch bugs at compile time
- Better IDE experience
- Self-documenting code
- Industry best practice
- No `any` types allowed

---

### 6. **Memory Handler with LRU**
**Decision:** Implement in-memory cache with LRU eviction
**Rationale:**
- Good for development
- Good for single-instance deployments
- Simple, predictable behavior
- No external dependencies
- Fast

**Implementation Details:**
- Use native Map (maintains insertion order)
- Tag indexing with separate Map
- Configurable max size
- Automatic expiration checking

---

### 7. **Tag-Based Revalidation**
**Decision:** Use Redis Sets for tag-to-key mapping
**Rationale:**
- Efficient lookups
- Easy to add/remove tags
- Atomic operations
- Scales well

**Alternative Considered:**
- Key scanning: Too slow
- Separate index table: More complex

---

### 8. **Separate Packages for Each Adapter**
**Decision:** Split into multiple packages:
- `@mrjasonroy/better-nextjs-cache-handler` (core + memory)
- `@mrjasonroy/better-nextjs-cache-handler-redis`
- `@mrjasonroy/better-nextjs-cache-handler-elasticache`

**Rationale:**
- Users only install what they need
- Smaller bundle sizes
- Clear separation of concerns
- Easier to maintain
- Can version independently if needed

---

### 9. **Lock-Step Versioning**
**Decision:** All packages share the same version number
**Rationale:**
- Simpler to communicate ("install v1.0.0")
- Guaranteed compatibility
- Easier CI/CD
- Less confusion for users

**Trade-off:**
- Minor version bumps affect all packages
- Acceptable for our use case

---

### 10. **Docker Compose for Local Development**
**Decision:** Provide docker-compose.yml for Redis
**Rationale:**
- Easy local setup
- Consistent environment
- Matches production setup
- Good for integration tests
- Industry standard

---

### 11. **Vitest Over Jest**
**Decision:** Use Vitest for unit testing
**Rationale:**
- Faster than Jest
- Better ESM support
- Vite-based (modern)
- Compatible with Jest API
- Better watch mode

---

### 12. **Playwright for E2E**
**Decision:** Use Playwright over Cypress
**Rationale:**
- Better multi-browser support
- Faster execution
- Better debugging tools
- Official Microsoft support
- Works great in CI

---

### 13. **Vercel for Initial Hosting**
**Decision:** Start with Vercel, migrate to K8s later
**Rationale:**
- Zero-config Next.js deployment
- Free for open source
- Preview deployments for PRs
- Can migrate later
- Faster time to launch

---

### 14. **AI-First Automation**
**Decision:** Use AI for version checking and release notes
**Rationale:**
- Automate repetitive tasks
- Catch breaking changes early
- Better release notes
- Demonstrates modern workflow
- Saves maintainer time

---

### 15. **Semantic Versioning with Conventional Commits**
**Decision:** Use semantic-release with conventional commits
**Rationale:**
- Automatic version bumps
- Clear changelog
- Standard in industry
- Works great with AI tools
- Predictable releases

---

## API Design Decisions

### 1. **Factory Functions Over Classes**
**Decision:** Export factory functions like `createMemoryCacheHandler()`
**Rationale:**
- Easier to use
- More functional style
- Can hide implementation details
- Easier to test
- Modern JavaScript pattern

**Example:**
```typescript
// Preferred
const handler = createMemoryCacheHandler({ maxSize: 1000 });

// Not preferred
const handler = new MemoryCacheHandler({ maxSize: 1000 });
```

---

### 2. **Async Everything**
**Decision:** All cache operations return Promises
**Rationale:**
- Consistent API
- Works for both sync (memory) and async (Redis) handlers
- Future-proof
- Follows Next.js expectations

---

### 3. **Explicit Context Parameter**
**Decision:** Pass context as separate parameter to `set()`
**Rationale:**
```typescript
// Clear separation of data and metadata
await handler.set(key, value, { tags: ['user'], revalidate: 3600 });
```

---

### 4. **Optional Delete Method**
**Decision:** Make `delete()` optional in interface
**Rationale:**
- Not all handlers need it
- Revalidation is primary invalidation method
- Follows Next.js patterns

---

## Performance Decisions

### 1. **In-Memory Tag Index**
**Decision:** Keep tag-to-key mapping in memory
**Rationale:**
- Fast lookups
- Small memory footprint
- Acceptable for bounded cache

**Trade-off:**
- Lost on restart (acceptable - cache is ephemeral)

---

### 2. **Lazy Expiration**
**Decision:** Check expiration on read, not with timers
**Rationale:**
- Simpler implementation
- No background processes
- Sufficient for use case
- Lower resource usage

---

## Future Decisions to Make

1. **Redis Fallback Strategy**
   - Should Redis handler fallback to memory on failure?
   - **Leaning toward:** Yes, with warning

2. **Metrics/Observability**
   - Built-in metrics or pluggable?
   - **Leaning toward:** Pluggable later

3. **Cache Warming**
   - Build-time or runtime?
   - **Need:** More research on Next.js 16 build process

---

**Last Updated:** 2025-01-10
