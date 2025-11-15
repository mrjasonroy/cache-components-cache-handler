# Release Checklist

This document outlines the complete process for releasing new versions of the cache handler packages to npm.

## Version Strategy

We align our package versions with Next.js major.minor versions:

- **Package version**: `16.0.0` aligns with Next.js `16.0.x`
- **Peer dependency**: `"next": "~16.0.0"` pins to Next.js 16.0.x
- **Patch versions**: Use for bug fixes and features between Next.js releases
- **Next.js updates**: Bump package major.minor when Next.js updates

### Examples

- Next.js `16.0.1` released → No package update needed (peer dep covers it)
- Bug fix in cache handler → Bump to `16.0.1`
- New feature in cache handler → Bump to `16.0.2`
- Next.js `16.1.0` released → Bump package to `16.1.0`, update peer dep to `~16.1.0`
- Next.js `17.0.0` released → Bump package to `17.0.0`, update peer dep to `~17.0.0`

## Automated Workflows

### Next.js Version Check (Daily)

The `nextjs-version-check.yml` workflow runs daily to check for new Next.js releases:

- **Trigger**: Daily at 00:00 UTC + manual
- **Action**: Detects new Next.js major.minor versions
- **Result**: Creates PR with updated versions and test results
- **Location**: `.github/workflows/nextjs-version-check.yml`

### Next.js Canary Testing (Daily)

The `nextjs-canary-test.yml` workflow tests compatibility with upcoming Next.js versions:

- **Trigger**: Daily at 06:00 UTC + manual
- **Versions**: Tests against `canary`, `rc`, and `latest`
- **Failures**:
  - Canary/RC failures = warnings only (early notice)
  - Latest failures = critical (blocks release)
- **Action**: Creates GitHub issue on canary failures
- **Location**: `.github/workflows/nextjs-canary-test.yml`

## Pre-Release Checklist

### 1. Local Verification

Run all checks locally before starting the release:

```bash
# Clean build
pnpm clean
pnpm install

# Run all checks
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test

# Run e2e tests with both cache handlers
pnpm test:e2e              # Memory cache
pnpm test:e2e:redis        # Redis cache
```

**All commands must pass with zero errors.**

### 2. GitHub CI Verification

Before releasing, ensure GitHub Actions CI is passing:

- Go to: `https://github.com/mrjasonroy/cache-components-cache-handler/actions`
- Check that latest commit has all green checks:
  - ✅ Lint and typecheck
  - ✅ Unit tests (41+ tests)
  - ✅ E2E tests with memory cache
  - ✅ E2E tests with Redis cache

**Do not proceed if any CI checks are failing.**

### 3. Version Updates

Update package versions to match Next.js:

```bash
# For Next.js 16.1.0 release, update to 16.1.0
cd packages/cache-handler
npm version 16.1.0 --no-git-tag-version
cd ../..

cd packages/cache-handler-redis
npm version 16.1.0 --no-git-tag-version
cd ../..

# Update peer dependencies in both packages
# Edit package.json: "next": "~16.1.0"
```

### 4. Update Next.js Dependency

Update Next.js in all apps to the matching version:

```bash
# Update root devDependency
pnpm add -D next@16.1.0

# Update e2e-test-app
cd apps/e2e-test-app
pnpm add next@16.1.0
cd ../..

# Update legacy-cache-test
cd apps/legacy-cache-test
pnpm add next@16.1.0
cd ../..

# Reinstall all dependencies
pnpm install
```

### 5. Final Testing

Run the full test suite again with the new versions:

```bash
pnpm build
pnpm test
pnpm test:e2e
pnpm test:e2e:redis
```

### 6. Commit Changes

Create a release commit:

```bash
git add .
git commit -m "chore: prepare release 16.1.0

- Updated packages to 16.1.0
- Updated Next.js to 16.1.0
- Updated peer dependencies to ~16.1.0
- All tests passing

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

git push origin main
```

### 7. Wait for CI

Wait for GitHub Actions to complete on the main branch. **All checks must be green.**

## Publishing to npm

### 1. Build Packages

Ensure clean build artifacts:

```bash
pnpm clean
pnpm install
pnpm build
```

### 2. Verify Package Contents

Check what will be published:

```bash
cd packages/cache-handler
npm pack --dry-run

cd ../cache-handler-redis
npm pack --dry-run
```

**Verify**:
- Only `dist/` folder is included
- No source files (`src/`) are included
- No test files are included
- `package.json`, `README.md` are included

### 3. Login to npm

```bash
npm login
# Enter credentials for @mrjasonroy scope
```

### 4. Publish Core Package

```bash
cd packages/cache-handler

# Dry run first to verify
npm publish --dry-run --access public

# Actually publish
npm publish --access public
```

### 5. Publish Redis Package

```bash
cd ../cache-handler-redis

# Dry run first
npm publish --dry-run --access public

# Actually publish
npm publish --access public
```

### 6. Verify Published Packages

Check npm to ensure packages are live:

```bash
npm view @mrjasonroy/cache-components-cache-handler
npm view @mrjasonroy/cache-components-cache-handler-redis
```

**Verify**:
- Version matches what you published
- Peer dependencies are correct
- Repository links are correct

## Post-Release

### 1. Create GitHub Release

Create a release on GitHub:

```bash
# Create and push a git tag
git tag v16.1.0
git push origin v16.1.0
```

Then create release on GitHub:
- Go to: `https://github.com/mrjasonroy/cache-components-cache-handler/releases/new`
- Tag: `v16.1.0`
- Title: `v16.1.0 - Next.js 16.1.0 Support`
- Body:

```markdown
## What's Changed

### Next.js Support
- Updated to support Next.js 16.1.0
- Peer dependency: `next@~16.1.0`

### Features
- [List any new features]

### Bug Fixes
- [List any bug fixes]

### Testing
- ✅ All unit tests passing (41+ tests)
- ✅ E2E tests with memory cache passing
- ✅ E2E tests with Redis cache passing

### Installation

```bash
npm install @mrjasonroy/cache-components-cache-handler@16.1.0
npm install @mrjasonroy/cache-components-cache-handler-redis@16.1.0
```

**Full Changelog**: https://github.com/mrjasonroy/cache-components-cache-handler/compare/v16.0.0...v16.1.0
```

### 2. Test Installation

Test installing the published packages in a fresh Next.js app:

```bash
# Create test app
npx create-next-app@latest test-installation --typescript --app --no-tailwind
cd test-installation

# Install our packages
npm install @mrjasonroy/cache-components-cache-handler@16.1.0

# Configure next.config.ts to use the handler
# Test that it works
npm run build
```

### 3. Update Documentation

If there are breaking changes or new features:
- Update main README.md
- Update package READMEs
- Add examples if needed

## Troubleshooting

### CI is failing

**Do not release if CI is failing.** Fix the issues first:

1. Check the GitHub Actions logs
2. Reproduce the failure locally
3. Fix the issue
4. Push the fix
5. Wait for CI to pass
6. Then proceed with release

### npm publish fails

**Authentication error**:
```bash
npm login
# Re-enter credentials
```

**Version already exists**:
```bash
# Bump the patch version
npm version patch --no-git-tag-version
# Try publishing again
```

**Validation errors**:
- Check package.json is valid
- Ensure peer dependencies are correct
- Verify exports field is correct

### Published package is broken

**If you catch it within 72 hours**:
```bash
npm unpublish @mrjasonroy/cache-components-cache-handler@16.1.0
# Fix the issue
# Republish the same version
```

**If it's been > 72 hours**:
```bash
# Publish a patch version with the fix
npm version patch
npm publish --access public
```

## Emergency Procedures

### Unpublishing a Bad Release

Only do this within 72 hours and if the package is critically broken:

```bash
npm unpublish @mrjasonroy/cache-components-cache-handler@16.1.0
npm unpublish @mrjasonroy/cache-components-cache-handler-redis@16.1.0
```

Then fix and republish:

```bash
# Fix the issue
pnpm build
pnpm test

# Republish
cd packages/cache-handler
npm publish --access public

cd ../cache-handler-redis
npm publish --access public
```

### Deprecating a Version

If you need to warn users about a version:

```bash
npm deprecate @mrjasonroy/cache-components-cache-handler@16.1.0 "Critical bug - please upgrade to 16.1.1"
```

## Release Frequency

- **Next.js major.minor releases**: Update and release within 1-2 days
- **Bug fixes**: Release as patch versions as needed
- **Features**: Release as patch versions (e.g., 16.0.1, 16.0.2) between Next.js releases
- **Automated PRs**: Review and merge automated Next.js update PRs from the version check workflow

## Contacts

- **Package owner**: Jason Roy (@mrjasonroy)
- **npm scope**: @mrjasonroy
- **GitHub org**: mrjasonroy
- **Issues**: https://github.com/mrjasonroy/cache-components-cache-handler/issues
