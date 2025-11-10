# Known Issues & Blockers

**Status:** 🟢 No blocking issues

---

## 🐛 Current Issues

None! 🎉

---

## ⚠️ Potential Issues

### 1. **Next.js 16 API Stability**
**Status:** Monitoring
**Description:** Next.js 16 cache API may change in minor versions
**Impact:** May need to update types
**Mitigation:**
- Automated testing against new versions
- AI monitoring for breaking changes
**Action Required:** None yet

### 2. **Turbopack Module Resolution**
**Status:** Known limitation
**Description:** Turbopack has issues resolving symlinked packages (discovered in original repo)
**Impact:** May affect local development with pnpm workspaces
**Mitigation:**
- Use webpack for development if needed
- Build packages before running examples
**Action Required:** Document in README

---

## 📝 Technical Debt

None yet - clean start! 🎉

---

## 🔮 Future Considerations

### 1. **Memory Leaks in Tag Index**
**Description:** If cache grows unbounded, tag index could grow too
**Mitigation:** LRU eviction handles this
**Priority:** Low
**Action:** Monitor in production

### 2. **Redis Connection Pooling**
**Description:** Need to implement proper connection pool for Redis
**Priority:** Medium
**Action:** Include in Redis package implementation

### 3. **Error Handling Standardization**
**Description:** Need consistent error types across handlers
**Priority:** Medium
**Action:** Define error hierarchy in Phase 2

---

## 🚫 Non-Issues (Things We Decided Against)

### 1. **Supporting Old Next.js Versions**
**Decision:** Only support Next.js 16+
**Rationale:** See DECISIONS.md

### 2. **Single Package for All Adapters**
**Decision:** Separate packages
**Rationale:** See DECISIONS.md

### 3. **Background Expiration with Timers**
**Decision:** Lazy expiration on read
**Rationale:** Simpler, sufficient for use case

---

## 📊 Issue Tracking

**Total Issues:** 0
**Blocking:** 0
**High Priority:** 0
**Medium Priority:** 0
**Low Priority:** 0

---

**Last Updated:** 2025-01-10

---

## How to Report Issues

If you find an issue:
1. Add it to this file under "Current Issues"
2. Include: Description, Impact, Mitigation, Action Required
3. Assign priority
4. Update status regularly
