# Automated Release Process

This project uses GitHub Actions to automate versioning and publishing to npm.

## Setup (One-Time)

**This project uses npm Trusted Publishing - no tokens needed!**

### First Publish (Manual)

The package must exist on npm before configuring trusted publishing:

See [FIRST_PUBLISH.md](./FIRST_PUBLISH.md) for the initial setup.

### After First Publish

Trusted publishing is already configured! No NPM_TOKEN needed.

**How it works:**
- npm trusts GitHub Actions from this repo
- Publishing uses OIDC (OpenID Connect) authentication
- More secure than long-lived tokens
- No secrets to manage or rotate

## Release Workflow

### Option 1: Patch/Minor/Major Bump (Recommended)

For bug fixes, features, or breaking changes:

1. **Trigger Version Bump**:
   - Go to: https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/version-bump.yml
   - Click "Run workflow"
   - Select version bump type:
     - **patch**: Bug fixes (16.0.0 → 16.0.1)
     - **minor**: New features (16.0.0 → 16.1.0)
     - **major**: Breaking changes (16.0.0 → 17.0.0)
   - Click "Run workflow"

2. **Wait for Automation**:
   - Workflow bumps version in package.json
   - Commits changes to main
   - Creates git tag (e.g., `v16.0.1`)
   - Pushes everything

3. **Create GitHub Release**:
   - Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
   - Select the new tag (e.g., `v16.0.1`)
   - Click "Generate release notes"
   - Edit notes if needed
   - Click "Publish release"

4. **Automatic npm Publishing**:
   - Publishing workflow triggers automatically
   - Runs tests
   - Publishes to npm
   - Done! ✨

### Option 2: Align with Next.js Version

When Next.js releases a new version (e.g., 16.1.0):

1. **Trigger Version Bump**:
   - Go to: https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/version-bump.yml
   - Click "Run workflow"
   - Select "specific"
   - Enter version: `16.1.0`
   - Click "Run workflow"

2. **Update Next.js Dependency**:
   ```bash
   # Locally or via PR
   cd packages/cache-handler
   # Update peerDependencies in package.json to "~16.1.0"

   # Update apps
   cd ../../apps/e2e-test-app
   pnpm add next@16.1.0
   cd ../legacy-cache-test
   pnpm add next@16.1.0

   # Commit and push
   git add .
   git commit -m "chore: update Next.js to 16.1.0"
   git push origin main
   ```

3. **Create GitHub Release** (as above)

4. **Automatic Publishing** happens

## Workflow Details

### Version Bump Workflow (`.github/workflows/version-bump.yml`)

**Triggers**: Manual via GitHub UI

**What it does**:
1. Bumps version in `packages/cache-handler/package.json`
2. Updates pnpm lockfile
3. Commits to main branch
4. Creates and pushes git tag
5. Provides instructions for next steps

**Permissions needed**: None (uses default `GITHUB_TOKEN`)

### Publish Workflow (`.github/workflows/publish.yml`)

**Triggers**: When a GitHub Release is published

**What it does**:
1. Checks out code
2. Installs dependencies
3. Builds packages
4. Runs tests
5. Publishes to npm with provenance
6. Verifies package is live

**Permissions needed**: `NPM_TOKEN` secret

### CI Workflow (`.github/workflows/ci.yml`)

**Triggers**: Every push and PR

**What it does**:
- Linting
- Type checking
- Unit tests (41 tests)
- E2E tests with memory cache
- E2E tests with Redis

## Version Strategy

We align our versions with Next.js:

- **Package version**: `16.0.0` = Next.js `16.0.x`
- **Peer dependency**: `"next": "~16.0.0"` (allows 16.0.x)
- **Patch bumps**: Bug fixes between Next.js releases
- **Minor bumps**: Features between Next.js releases
- **Major bumps**: Follow Next.js major versions

## Multiple Maintainers

**Adding maintainers**:

1. **npm**: Add as collaborator on npm
   - Go to: https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler
   - Settings → Collaborators → Add

2. **GitHub**: Add to repo with write access
   - Settings → Collaborators → Add people

**Maintainers can**:
- ✅ Push code changes
- ✅ Trigger version bumps
- ✅ Create releases
- ❌ Don't need npm credentials (handled by GitHub Actions)

## Troubleshooting

### Publish fails with "401 Unauthorized"

**Problem**: NPM_TOKEN is invalid or expired

**Solution**:
1. Generate new token on npm
2. Update GitHub secret
3. Retry the release

### Publish fails with "You do not have permission"

**Problem**: npm token doesn't have publish rights

**Solution**:
1. Ensure token type is "Automation"
2. Ensure you own the `@mrjasonroy` scope
3. Regenerate token if needed

### Version bump workflow fails

**Problem**: Git push rejected

**Solution**:
- Check branch protection rules
- Ensure workflow has write permissions
- Check if tag already exists

### Tests fail during publish

**Problem**: Code isn't ready for release

**Solution**:
1. Fix the failing tests locally
2. Push fixes to main
3. Trigger version bump again
4. Create new release

## Manual Override

If you ever need to publish manually:

```bash
# Build
pnpm build

# Publish
cd packages/cache-handler
npm publish --access public

# Create tag
git tag v16.0.1
git push origin v16.0.1
```

**But you shouldn't need to!** Use the automated workflow.

## Quick Reference

| Task | Action |
|------|--------|
| Bug fix release | Run version-bump workflow → select "patch" |
| Feature release | Run version-bump workflow → select "minor" |
| Next.js update | Run version-bump workflow → select "specific" → enter version |
| Publish to npm | Create GitHub Release (publishes automatically) |
| Check published | https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler |
| View releases | https://github.com/mrjasonroy/cache-components-cache-handler/releases |
| Run workflows | https://github.com/mrjasonroy/cache-components-cache-handler/actions |

## Example: Full Release Flow

**Scenario**: Fix a bug and release

1. Make fix in code
2. Push to main (CI runs automatically)
3. Go to Actions → Version Bump → Run workflow → select "patch"
4. Wait for workflow to complete
5. Go to Releases → New release → Select new tag → Generate notes → Publish
6. Wait ~2 minutes for npm publish workflow
7. Check npm: `npm view @mrjasonroy/cache-components-cache-handler`
8. Done! ✨

**Time to release**: ~5 minutes, mostly automated
