# Prerelease Versions

This guide covers publishing alpha, beta, and rc (release candidate) versions.

## Version Schema

We support standard npm prerelease tags:

- **alpha**: Early testing, unstable (`16.0.0-alpha.0`, `16.0.0-alpha.1`, ...)
- **beta**: Feature complete, testing (`16.0.0-beta.0`, `16.0.0-beta.1`, ...)
- **rc**: Release candidate, final testing (`16.0.0-rc.0`, `16.0.0-rc.1`, ...)
- **production**: Stable release (`16.0.0`)

## Publishing Prerelease Versions

### 1. Bump to Prerelease Version

Go to: https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/version-bump.yml

Click "Run workflow" and select:
- **prerelease-alpha**: Bump to next alpha (`16.0.0-alpha.0` → `16.0.0-alpha.1`)
- **prerelease-beta**: Bump to next beta (`16.0.0-beta.0` → `16.0.0-beta.1`)
- **prerelease-rc**: Bump to next rc (`16.0.0-rc.0` → `16.0.0-rc.1`)

Or use **specific** to set exact version: `16.1.0-alpha.0`

### 2. Create GitHub Prerelease

1. Workflow creates tag (e.g., `v16.0.0-alpha.0`)
2. Go to: https://github.com/mrjasonroy/cache-components-cache-handler/releases/new
3. Select the tag
4. **Important**: Check "Set as a pre-release" ✓
5. Title: `v16.0.0-alpha.0`
6. Body:
```markdown
## ⚠️ Alpha Release

This is a prerelease version for testing. Not recommended for production.

### Changes
- [List changes]

### Installation

```bash
npm install @mrjasonroy/cache-components-cache-handler@16.0.0-alpha.0
# Or by tag:
npm install @mrjasonroy/cache-components-cache-handler@alpha
```

### Testing Needed
- [ ] Test feature X
- [ ] Verify compatibility with Y
```

7. Click "Publish release"

### 3. Automatic Publishing

The publish workflow will:
- Run all tests
- Publish to npm with appropriate dist-tag:
  - `16.0.0-alpha.X` → `@alpha` tag
  - `16.0.0-beta.X` → `@beta` tag
  - `16.0.0-rc.X` → `@rc` tag
- Comment on release with install command

## Installing Prerelease Versions

### By Specific Version
```bash
npm install @mrjasonroy/cache-components-cache-handler@16.0.0-alpha.0
```

### By Tag (Latest of That Type)
```bash
# Latest alpha
npm install @mrjasonroy/cache-components-cache-handler@alpha

# Latest beta
npm install @mrjasonroy/cache-components-cache-handler@beta

# Latest rc
npm install @mrjasonroy/cache-components-cache-handler@rc

# Latest stable (default)
npm install @mrjasonroy/cache-components-cache-handler
# or
npm install @mrjasonroy/cache-components-cache-handler@latest
```

## Graduating to Stable

When ready to release as stable:

### Option 1: Graduate Current Prerelease

Go to version-bump workflow and select **graduate**:
- `16.0.0-alpha.5` → `16.0.0`
- `16.1.0-rc.2` → `16.1.0`

### Option 2: Specific Version

Use **specific** and enter: `16.0.0`

Then create a regular release (NOT marked as prerelease).

## Version Progression Examples

### Alpha → Beta → RC → Stable

```bash
# Alpha testing
16.0.0-alpha.0
16.0.0-alpha.1
16.0.0-alpha.2

# Beta testing (feature complete)
16.0.0-beta.0
16.0.0-beta.1

# Release candidate (final testing)
16.0.0-rc.0
16.0.0-rc.1

# Stable release
16.0.0
```

### Patch Prerelease

```bash
# Stable
16.0.0

# Testing patch fix
16.0.1-alpha.0
16.0.1-alpha.1

# Stable patch
16.0.1
```

### Minor Prerelease

```bash
# Current stable
16.0.0

# New feature testing
16.1.0-alpha.0
16.1.0-beta.0
16.1.0-rc.0

# New stable feature
16.1.0
```

## npm Dist Tags

After publishing, check tags:

```bash
npm view @mrjasonroy/cache-components-cache-handler dist-tags
```

Expected output:
```json
{
  "latest": "16.0.0",
  "alpha": "16.1.0-alpha.0",
  "beta": "16.0.0-beta.1",
  "rc": "16.0.0-rc.0"
}
```

## Best Practices

### When to Use Each

- **alpha**: Breaking changes, experimental features, early development
- **beta**: Feature complete, needs wider testing
- **rc**: Final testing before stable, no new features
- **stable**: Production ready

### Testing Requirements

Before graduating to stable:
- ✅ All unit tests passing
- ✅ All e2e tests passing (memory + Redis)
- ✅ Tested in real application
- ✅ Documentation updated
- ✅ Breaking changes documented

### Communication

In release notes, always include:
- ⚠️ Warning that it's a prerelease
- What's being tested
- Known issues
- Feedback channels

## Troubleshooting

### Wrong dist-tag published

Manually update the tag:

```bash
# Move latest tag
npm dist-tag add @mrjasonroy/cache-components-cache-handler@16.0.0 latest

# Update alpha tag
npm dist-tag add @mrjasonroy/cache-components-cache-handler@16.1.0-alpha.0 alpha
```

### Accidentally published as latest

If you published a prerelease as `latest`:

```bash
# Move latest back to stable version
npm dist-tag add @mrjasonroy/cache-components-cache-handler@16.0.0 latest

# Add prerelease to correct tag
npm dist-tag add @mrjasonroy/cache-components-cache-handler@16.1.0-alpha.0 alpha
```

### Remove a prerelease

You can deprecate but not unpublish after 72 hours:

```bash
npm deprecate @mrjasonroy/cache-components-cache-handler@16.0.0-alpha.0 "This alpha version is deprecated. Use @latest instead."
```

## Quick Reference

| Action | Workflow Input |
|--------|---------------|
| Next alpha | `prerelease-alpha` |
| Next beta | `prerelease-beta` |
| Next rc | `prerelease-rc` |
| Graduate to stable | `graduate` |
| Specific version | `specific` → enter version |

| Version | Install Command |
|---------|----------------|
| Specific | `npm install pkg@16.0.0-alpha.0` |
| Latest alpha | `npm install pkg@alpha` |
| Latest beta | `npm install pkg@beta` |
| Latest rc | `npm install pkg@rc` |
| Latest stable | `npm install pkg` or `pkg@latest` |
