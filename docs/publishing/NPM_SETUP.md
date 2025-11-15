# npm Publishing Setup Guide

Complete guide to set up npm publishing for the first time.

## Prerequisites

1. **npm Account**
   - Go to https://www.npmjs.com/signup
   - Create account if you don't have one
   - Verify your email address

2. **Two-Factor Authentication (Required for Publishing)**
   - Go to https://www.npmjs.com/settings/your-username/twofa
   - Enable 2FA (required for publishing scoped packages)
   - Save your recovery codes!

## Initial Setup

### 1. Login to npm

```bash
npm login
```

You'll be prompted for:
- **Username**: your npm username
- **Password**: your npm password
- **Email**: your npm email
- **OTP**: one-time password from your 2FA app (if enabled)

### 2. Verify Login

```bash
npm whoami
```

Should show your npm username.

### 3. Check Scope Access

Our packages use the `@mrjasonroy` scope. Check if you own this scope:

```bash
npm access list packages
```

If the scope doesn't exist, you'll need to create it with your first publish.

## Publishing Workflow

### Pre-Publish Checklist

Run these commands to verify everything is ready:

```bash
# 1. Clean build
pnpm clean
pnpm install

# 2. Run all checks
pnpm build
pnpm lint
pnpm typecheck
pnpm test

# 3. Test e2e
pnpm test:e2e
```

**All must pass before publishing!**

### First Time Publishing

#### 1. Build Packages

```bash
pnpm build
```

#### 2. Verify Package Contents

Check what will be published (dry run):

```bash
# Check core package
cd packages/cache-handler
npm pack --dry-run

# Check Redis package
cd ../cache-handler-redis
npm pack --dry-run
```

**Verify output includes**:
- ✅ `dist/` folder only
- ✅ `package.json`
- ✅ `README.md`
- ❌ NO `src/` folder
- ❌ NO test files
- ❌ NO `.ts` source files

#### 3. Publish Core Package

```bash
cd packages/cache-handler

# Dry run first (simulates publish without actually publishing)
npm publish --dry-run --access public

# If dry run looks good, publish for real
npm publish --access public
```

**Important**:
- `--access public` is required for scoped packages
- You'll be prompted for 2FA code if enabled
- First publish of `@mrjasonroy/cache-components-cache-handler`

#### 4. Publish Redis Package

```bash
cd ../cache-handler-redis

# Dry run
npm publish --dry-run --access public

# Actually publish
npm publish --access public
```

#### 5. Verify Published Packages

```bash
# Check they're live on npm
npm view @mrjasonroy/cache-components-cache-handler
npm view @mrjasonroy/cache-components-cache-handler-redis

# Check on npm website
open https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler
open https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler-redis
```

### Post-Publish

#### 1. Create Git Tag

```bash
git tag v16.0.0
git push origin v16.0.0
git push origin main
```

#### 2. Create GitHub Release

- Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
- Select tag: `v16.0.0`
- Title: `v16.0.0 - Initial Release`
- Body:

```markdown
## 🎉 Initial Release

First stable release of the Next.js 16 Cache Components handler!

### Features

- ✅ Full support for Next.js 16.0.1 Cache Components
- ✅ Memory cache handler with tag-based invalidation
- ✅ Redis cache handler for distributed caching
- ✅ TypeScript support with full type safety
- ✅ Composite handler for multi-tier caching

### Packages

- `@mrjasonroy/cache-components-cache-handler@16.0.0`
- `@mrjasonroy/cache-components-cache-handler-redis@16.0.0`

### Installation

```bash
npm install @mrjasonroy/cache-components-cache-handler
# or
npm install @mrjasonroy/cache-components-cache-handler-redis
```

### Documentation

See [README.md](https://github.com/mrjasonroy/cache-components-cache-handler#readme) for usage instructions.

### Testing

- ✅ 41+ unit tests passing
- ✅ Comprehensive e2e tests with Playwright
- ✅ Tested with both memory and Redis backends

**Full Changelog**: https://github.com/mrjasonroy/cache-components-cache-handler/commits/v16.0.0
```

#### 3. Test Installation

Create a new Next.js app and test the package:

```bash
cd /tmp
npx create-next-app@latest test-cache-handler --typescript --app
cd test-cache-handler

# Install your package
npm install @mrjasonroy/cache-components-cache-handler

# Test it works
npm run build
```

## Troubleshooting

### Error: "You must sign in to publish packages"

```bash
npm login
# Re-enter credentials
```

### Error: "You do not have permission to publish"

This means:
1. The package name is already taken (try a different scope/name)
2. You need to be added as a maintainer (if someone else owns it)
3. You need 2FA enabled

**Solution**: Use the `@mrjasonroy` scope which you own, or create your own scope.

### Error: "402 Payment Required"

This means you're trying to publish a private scoped package without a paid npm account.

**Solution**: Use `--access public` flag:
```bash
npm publish --access public
```

### Error: "npm ERR! need auth This command requires you to be logged in"

```bash
npm logout
npm login
```

### Error: "Version 16.0.0 already exists"

The version has already been published. You need to bump the version:

```bash
# Patch version (16.0.0 -> 16.0.1)
npm version patch --no-git-tag-version

# Then publish
npm publish --access public
```

### Error: "package.json validation failed"

Check:
- Valid JSON in package.json
- All required fields present (name, version, description, license, repository)
- Peer dependencies are valid semver ranges

## Advanced: Automation Tokens

For CI/CD automation (future):

### 1. Create Automation Token

- Go to: https://www.npmjs.com/settings/your-username/tokens
- Click "Generate New Token"
- Select "Automation" type
- Copy the token (starts with `npm_`)
- **Save it securely!** You won't see it again.

### 2. Add to GitHub Secrets

- Go to: https://github.com/mrjasonroy/cache-components-cache-handler/settings/secrets/actions
- Click "New repository secret"
- Name: `NPM_TOKEN`
- Value: paste your npm token
- Click "Add secret"

### 3. Create Publish Workflow

Create `.github/workflows/publish.yml`:

```yaml
name: Publish to npm

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install

      - name: Build packages
        run: pnpm build

      - name: Publish core package
        run: cd packages/cache-handler && npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Publish Redis package
        run: cd packages/cache-handler-redis && npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

This will automatically publish to npm when you create a GitHub release.

## Quick Reference

### Common Commands

```bash
# Login
npm login

# Check who you're logged in as
npm whoami

# Logout
npm logout

# View published package
npm view @mrjasonroy/cache-components-cache-handler

# Check package versions
npm view @mrjasonroy/cache-components-cache-handler versions

# Unpublish (only within 72 hours)
npm unpublish @mrjasonroy/cache-components-cache-handler@16.0.0

# Deprecate a version
npm deprecate @mrjasonroy/cache-components-cache-handler@16.0.0 "Use 16.0.1 instead"
```

### Package Names

- Core: `@mrjasonroy/cache-components-cache-handler`
- Redis: `@mrjasonroy/cache-components-cache-handler-redis`

### Current Version

- **16.0.0** (initial release, aligned with Next.js 16.0.1)

## Support

- npm docs: https://docs.npmjs.com/
- Publishing scoped packages: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages
- npm support: https://www.npmjs.com/support
