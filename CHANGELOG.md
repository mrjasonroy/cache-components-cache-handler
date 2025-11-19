# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [16.0.0] - 2025-11-18

### Added

- `CHANGELOG.md` to track releases.
- Test coverage for the zero-config data cache factory, ensuring Redis/Valkey env handling works across backends.

### Changed

- Promoted the package from `16.0.0-alpha.6` to the first stable release aligned with Next.js 16.
- Updated the zero-config factory to load `ioredis` safely in pure ESM projects and to honor TLS/password options (including AWS ElastiCache env vars).
- Removed the unused CommonJS export entry; the package is now explicitly ESM-only.
- Reworked documentation (README, installation guide, Redis guide, package README) to reflect the modern APIs, supported backends, CI guarantees, and the motivation for this new repo.

### Fixed

- Redis/Valkey/ElastiCache handlers now apply `REDIS_PASSWORD`, `ELASTICACHE_*` env vars, and custom TLS options so production deployments connect successfully.
