# Automated Publishing (Recommended)

**This project uses GitHub Actions for automated publishing.**

See [AUTOMATED_RELEASE.md](./AUTOMATED_RELEASE.md) for the full automated workflow.

## Quick Start: Publish a New Version

### 1. First Time Only

If this is the first publish, see [FIRST_PUBLISH.md](./FIRST_PUBLISH.md).

After that, no setup needed - uses npm Trusted Publishing!

### 2. Bump Version

Go to: https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/version-bump.yml

Click "Run workflow" and select:
- **patch**: Bug fixes (16.0.0 → 16.0.1)
- **minor**: Features (16.0.0 → 16.1.0)
- **major**: Breaking changes (16.0.0 → 17.0.0)
- **specific**: Enter exact version (e.g., 16.1.0)

### 3. Create GitHub Release

1. Workflow creates tag automatically
2. Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
3. Select the new tag
4. Click "Generate release notes"
5. Click "Publish release"

### 4. Publishing Happens Automatically!

- Runs all tests (lint, typecheck, unit, e2e)
- Publishes to npm with provenance
- Comments on release with install command
- Done! ✨

## Manual Publishing (Not Recommended)

Only use if GitHub Actions is down:

```bash
# Build
pnpm build

# Publish
cd packages/cache-handler
npm publish --access public

# Tag
git tag v16.0.1
git push origin v16.0.1
```

**But you shouldn't need to!** Use the automated workflow above.

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
