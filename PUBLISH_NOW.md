# Publish to npm - Quick Start

Follow these steps **IN ORDER** to publish v16.0.0 to npm.

## Step 1: Login to npm

```bash
npm login
```

Enter your npm credentials. If you don't have an account:
- Go to https://www.npmjs.com/signup
- Create account and verify email
- Then run `npm login`

Verify you're logged in:
```bash
npm whoami
```

## Step 2: Final Build

```bash
pnpm clean
pnpm install
pnpm build
```

All should complete successfully.

## Step 3: Publish Package

```bash
cd packages/cache-handler

# DRY RUN first (doesn't actually publish)
npm publish --dry-run --access public

# If dry run looks good, PUBLISH FOR REAL
npm publish --access public
```

**Expected output**:
```
+ @mrjasonroy/cache-components-cache-handler@16.0.0
```

## Step 4: Verify Published

```bash
# Check it's live
npm view @mrjasonroy/cache-components-cache-handler
```

Visit npm:
- https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler

## Step 5: Push to GitHub

```bash
cd ../..  # Back to root

# Push commits
git push origin main

# Create and push tag
git tag v16.0.0
git push origin v16.0.0
```

## Step 6: Create GitHub Release

- Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
- Tag: `v16.0.0`
- Title: `v16.0.0 - Initial Release`
- Body: See NPM_SETUP.md for suggested release notes
- Click "Publish release"

## Done! 🎉

Your packages are now live on npm!

Test installation:
```bash
cd /tmp
npx create-next-app@latest test-install --typescript --app
cd test-install
npm install @mrjasonroy/cache-components-cache-handler
npm run build
```

## Troubleshooting

### "need auth" error
Run `npm login` again

### "402 Payment Required"
You forgot `--access public` flag

### "Version already exists"
The version is already published (maybe you already did it?)
Check: `npm view @mrjasonroy/cache-components-cache-handler versions`

### "package.json validation failed"
Check package.json is valid JSON

### Any other issues
See `NPM_SETUP.md` for complete troubleshooting guide

---

**For detailed information**, see:
- `NPM_SETUP.md` - Complete npm setup and troubleshooting
- `RELEASE.md` - Full release process and version strategy
