# Contributing to cache-components-cache-handler

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to this project.

## Code of Conduct

- Be respectful and constructive
- Help create a welcoming environment
- Follow the project's code standards

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/cache-components-cache-handler
   cd cache-components-cache-handler
   ```
3. **Install dependencies**:
   ```bash
   pnpm install
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feature/my-new-feature
   ```

## Development Workflow

### Making Changes

1. Make your changes in your feature branch
2. Follow the existing code style (enforced by Biome)
3. Add or update tests as needed
4. Update documentation if needed

### Before Submitting

Run these commands to ensure your changes are ready:

```bash
# Format your code
pnpm format

# Check linting
pnpm lint

# Type check
pnpm typecheck

# Run tests
pnpm test

# Run E2E tests (optional but recommended)
pnpm test:e2e

# Or run everything at once
pnpm lint && pnpm typecheck && pnpm test
```

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```bash
feat: add support for custom TTL per cache entry
fix: correct Redis connection timeout handling
docs: update installation instructions
test: add tests for tag-based invalidation
chore: update dependencies
```

## Submitting a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/my-new-feature
   ```

2. **Open a Pull Request** on GitHub from your fork to the main repository

3. **Fill out the PR template** with:
   - Clear description of changes
   - Type of change (bug fix, feature, etc.)
   - Testing performed
   - Related issues

4. **Wait for review**:
   - Maintainers will review your PR
   - Address any feedback or requested changes
   - All CI checks must pass (lint, typecheck, tests)
   - At least 1 approving review is required

## Branch Protection

The `main` branch is protected with the following rules:

- ✅ **Required Reviews**: At least 1 approving review from a maintainer
- ✅ **Status Checks**: All CI tests must pass (lint, typecheck, unit tests, E2E tests)
- ✅ **Conversation Resolution**: All review comments must be resolved
- ✅ **Dismiss Stale Reviews**: New commits dismiss previous approvals
- ❌ **No Force Pushes**: Cannot force push to main
- ❌ **No Deletions**: Cannot delete the main branch

## Testing

### Unit Tests

```bash
pnpm test
```

### E2E Tests

```bash
# Start Redis (for Redis tests)
pnpm docker:up

# Run E2E tests
pnpm test:e2e

# Stop Redis
pnpm docker:down
```

### Writing Tests

- Add tests for all new features
- Ensure bug fixes have tests to prevent regression
- Aim for good test coverage
- Use descriptive test names

## Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Biome (run `pnpm format`)
- **Linting**: Biome (run `pnpm lint`)
- **Line Length**: 100 characters
- **Indentation**: 2 spaces
- **Quotes**: Double quotes
- **Semicolons**: Always required

## Project Structure

```
cache-components-cache-handler/
├── packages/
│   └── cache-handler/          # Main package
│       ├── src/
│       │   ├── types.ts        # Type definitions
│       │   ├── handlers/       # Cache handler implementations
│       │   └── index.ts        # Public API
│       └── package.json
├── apps/
│   ├── e2e-test-app/          # E2E test application
│   └── redis-example/         # Redis example app
├── docs/                       # Documentation
└── .github/                    # GitHub configuration
```

## Need Help?

- 📖 Read the [documentation](./docs/)
- 🐛 Check [existing issues](https://github.com/mrjasonroy/cache-components-cache-handler/issues)
- 💬 Ask questions by opening a new issue

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing! 🎉
