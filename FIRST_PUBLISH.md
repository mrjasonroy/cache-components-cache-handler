# First Time Publish - Manual Setup

**You only need to do this ONCE to get the package on npm. After that, use automated trusted publishing.**

## Step 1: Login to npm

```bash
npm login
```

Enter your credentials.

## Step 2: Build and Publish Alpha

```bash
# Build
pnpm build

# Publish alpha version (one-time manual)
cd packages/cache-handler
npm publish --access public --tag alpha
```

**Expected output:**
```
+ @mrjasonroy/cache-components-cache-handler@16.0.0-alpha.0
```

**Important**: Using `--tag alpha` prevents this from becoming the default `latest` version.

## Step 3: Verify on npm

Visit: https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler

You should see v16.0.0-alpha.0 published with the `alpha` tag.

Check tags:
```bash
npm view @mrjasonroy/cache-components-cache-handler dist-tags
# Should show: { alpha: '16.0.0-alpha.0' }
```

## Step 4: Configure Trusted Publishing

Now that the package exists on npm, set up trusted publishing:

### 4.1: Go to Package Settings

https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler/access

### 4.2: Enable Trusted Publishing

1. Scroll to "Publishing Access"
2. Click "Configure Trusted Publishers"
3. Click "Add Trusted Publisher"
4. Fill in:
   - **Provider**: GitHub Actions
   - **Organization**: `mrjasonroy`
   - **Repository**: `cache-components-cache-handler`
   - **Workflow**: `publish.yml`
   - **Environment**: leave empty (or create "npm" environment if you want extra protection)

5. Click "Add"

### 4.3: Verify Configuration

You should see:
```
Trusted Publishers:
✓ GitHub Actions
  mrjasonroy/cache-components-cache-handler
  Workflow: publish.yml
```

## Step 5: Tag and Push

```bash
cd ../..  # Back to root

# Create initial alpha tag
git tag v16.0.0-alpha.0
git push origin v16.0.0-alpha.0
```

## Step 6: Create GitHub Prerelease

1. Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
2. Select tag: `v16.0.0-alpha.0`
3. **Check** "Set as a pre-release" ✓
4. Title: `v16.0.0-alpha.0`
5. Body:
```markdown
## ⚠️ Alpha Release

First alpha release for testing the automated publishing workflow!

### Features

- ✅ Full Next.js 16.0.1 support with Cache Components
- ✅ Memory cache handler
- ✅ Redis cache handler (ioredis)
- ✅ Composite handler for multi-tier caching
- ✅ TypeScript with full type safety
- ✅ Data cache handlers for "use cache" directive

### Installation

**For testing only:**

```bash
npm install @mrjasonroy/cache-components-cache-handler@alpha
# or specific version:
npm install @mrjasonroy/cache-components-cache-handler@16.0.0-alpha.0
```

### Quick Start

```typescript
import {
  MemoryCacheHandler,
  RedisCacheHandler,
  CompositeHandler,
  createMemoryDataCacheHandler,
  createRedisDataCacheHandler
} from '@mrjasonroy/cache-components-cache-handler'
```

See [README](https://github.com/mrjasonroy/cache-components-cache-handler#readme) for full documentation.

### Testing

- ✅ 41 unit tests passing
- ✅ Comprehensive e2e tests with Playwright
- ✅ Tested with both memory and Redis backends
```

6. Click "Publish release"

## Done! 🎉

Your package is now:
- ✅ Published to npm as `16.0.0-alpha.0`
- ✅ Tagged with `@alpha` (not affecting `@latest`)
- ✅ Configured for trusted publishing
- ✅ Ready for automated releases

## Next Steps

### Test the Workflow

Try the automated prerelease workflow:

1. Go to: https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/version-bump.yml
2. Run workflow → select "prerelease-alpha"
3. Creates `v16.0.0-alpha.1` tag automatically
4. Create GitHub Release (mark as prerelease)
5. Publishes automatically!

### When Ready for Stable

Follow [PRERELEASE.md](./PRERELEASE.md) to graduate from alpha → beta → rc → stable.

Or jump straight to stable:
1. Run version-bump workflow → select "graduate"
2. Creates `v16.0.0` tag
3. Create GitHub Release (NOT marked as prerelease)
4. Publishes as `@latest`

See [AUTOMATED_RELEASE.md](./AUTOMATED_RELEASE.md) for full details.
