## Next.js deploy tests (v16.4.2)

- `baseline`: 16 suites pass, 2 fail, 10 ran no tests; tests 203/578 passed
- `pkg-16.5.1`: 12 suites pass, 6 fail, 10 ran no tests; tests 111/578 passed
- `branch`: 12 suites pass, 6 fail, 10 ran no tests; tests 41/532 passed

**4 regression(s)** of `branch` vs `baseline`.

Cells are `status passed/total`. `pkg-16.5.1` is informational.

| Suite | baseline | pkg-16.5.1 | branch | Verdict | Notes |
|---|---|---|---|---|---|
| `test/e2e/app-dir/actions-revalidate-remount` | pass 1/1 | pass 1/1 | pass 1/1 | ok |  |
| `test/e2e/app-dir/app-static` | pass 89/96 | fail 0/96 (89 failed) | fail 0/96 (89 failed) | **REGRESSION** |  |
| `test/e2e/app-dir/cache-components` | pass 71/79 | pass 71/79 | fail 3/33 (30 failed) | **REGRESSION** |  |
| `test/e2e/app-dir/cache-components-request-apis` | pass 2/2 | pass 2/2 | pass 2/2 | ok |  |
| `test/e2e/app-dir/cache-components-segment-configs` | pass 1/3 | pass 1/3 | pass 1/3 | ok |  |
| `test/e2e/app-dir/non-ascii-cache-item-name` | fail 0/1 (1 failed) | fail 0/1 (1 failed) | fail 0/1 (1 failed) | no baseline pass | fixture cacheHandler kept |
| `test/e2e/app-dir/non-ascii-cache-tags` | pass 6/6 | pass 6/6 | pass 6/6 | ok |  |
| `test/e2e/app-dir/ppr` | no tests ran (22 skipped) | no tests ran (22 skipped) | no tests ran (22 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/ppr-full` | no tests ran (194 skipped) | no tests ran (194 skipped) | no tests ran (194 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/ppr-metadata-blocking` | no tests ran (3 skipped) | no tests ran (3 skipped) | no tests ran (3 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/ppr-unstable-cache` | no tests ran (1 skipped) | no tests ran (1 skipped) | no tests ran (1 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/revalidate-path-with-rewrites` | pass 2/2 | pass 2/2 | pass 2/2 | ok |  |
| `test/e2e/app-dir/revalidatetag-rsc` | pass 1/1 | pass 1/1 | pass 1/1 | ok |  |
| `test/e2e/app-dir/use-cache` | no tests ran (104 skipped) | no tests ran (104 skipped) | no tests ran (104 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-close-over-function` | pass 1/1 | pass 1/1 | pass 1/1 | ok |  |
| `test/e2e/app-dir/use-cache-custom-handler` | no tests ran (9 skipped) | no tests ran (9 skipped) | no tests ran (9 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-default-profile-expire-zero` | pass 2/2 | pass 2/2 | pass 2/2 | ok |  |
| `test/e2e/app-dir/use-cache-draft-mode-isolation` | no tests ran (5 skipped) | no tests ran (5 skipped) | no tests ran (5 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-hanging` | pass 1/1 | pass 1/1 | pass 1/1 | ok |  |
| `test/e2e/app-dir/use-cache-infinity-profile` | pass 2/2 | fail 1/2 (1 failed) | fail 1/2 (1 failed) | **REGRESSION** | fixture cacheHandlers.default kept |
| `test/e2e/app-dir/use-cache-metadata-route-handler` | pass 10/10 | pass 10/10 | fail 6/10 (4 failed) | **REGRESSION** |  |
| `test/e2e/app-dir/use-cache-private` | pass 9/9 | fail 8/9 (1 failed) | pass 9/9 | ok |  |
| `test/e2e/app-dir/use-cache-route-handler-only` | pass 3/4 | fail 2/4 (1 failed) | pass 3/4 | ok |  |
| `test/e2e/app-dir/use-cache-search-params` | no tests ran (7 skipped) | no tests ran (7 skipped) | no tests ran (7 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-segment-configs` | fail 0/1 (1 failed) | fail 0/1 (1 failed) | fail 0/1 (1 failed) | no baseline pass |  |
| `test/e2e/app-dir/use-cache-swr` | no tests ran (7 skipped) | no tests ran (7 skipped) | no tests ran (7 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-unknown-cache-kind` | no tests ran (3 skipped) | no tests ran (3 skipped) | no tests ran (3 skipped) | skipped in deploy mode |  |
| `test/e2e/app-dir/use-cache-with-server-function-props` | pass 2/2 | pass 2/2 | pass 2/2 | ok |  |
