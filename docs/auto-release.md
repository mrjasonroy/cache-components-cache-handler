# Autonomous releases

This package keeps itself current with Next.js with **no human and no paid
services**. The end-to-end loop:

```
nextjs-version-check.yml (daily cron)
  detects a new Next.js → branch nextjs-<v> → bump next + package version
  → run e2e (memory + redis) → open a PR (as the RELEASE_PAT identity)
        └─ ci.yml runs the required checks on the PR:
             lint-and-typecheck · unit-tests · test-summary
             (test-summary is green only if the full e2e matrix passes:
              memory, redis, valkey, elasticache)
        └─ auto-merge is enabled on the PR
             checks green → it squash-merges itself → branch deleted
                  └─ tag-on-version-merge.yml → tag v<v> → dispatches publish.yml
                       └─ npm publish (OIDC, tokenless) + GitHub release
```

**The e2e suite is the reviewer.** If the matrix is green the bump ships; if it
goes red the PR just sits open and waits for you. There is no AI in this loop —
an earlier "ambient agent" design was removed because the test suite already
encodes the merge gate.

## One-time setup: `RELEASE_PAT`

GitHub deliberately stops the built-in `GITHUB_TOKEN` from driving a release:
a PR opened by `GITHUB_TOKEN` does **not** trigger CI, and a merge performed by
it does **not** fire the post-merge tag/publish chain (the anti-recursion rule).
So the bot needs to act as a real identity — one free, long-lived token does it.

1. Create a **fine-grained personal access token**
   (GitHub → Settings → Developer settings → Fine-grained tokens):
   - **Repository access:** only `cache-components-cache-handler`
   - **Expiration:** the longest available (or no expiration)
   - **Permissions:** **Contents: Read and write** + **Pull requests: Read and write**
     (nothing else — no admin, no workflows)

2. Add it as a repo secret named **`RELEASE_PAT`**:
   ```bash
   gh secret set RELEASE_PAT
   ```

That's it. It costs nothing and there is no second token to rotate (npm publish
uses OIDC trusted publishing — see [publishing](./publishing/AUTOMATED_RELEASE.md)).

### Without the PAT

The loop degrades gracefully: `nextjs-version-check` still opens the bump PR, but
auto-merge stays off and the workflow logs a warning. Merge the PR yourself once
CI is green — the tag and publish still fire automatically from your merge.

## Branch protection

`main` requires the status checks `lint-and-typecheck`, `unit-tests`, and
`test-summary`, and does **not** require an approving review — the checks are the
gate, and no bot can give itself an approval. Required conversation resolution
stays on (only matters when a human leaves review comments). Auto-merge and
delete-branch-on-merge are enabled at the repo level.

To re-add a human approval gate later:

```bash
gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input - <<'JSON'
{ "required_status_checks": { "strict": false,
    "contexts": ["lint-and-typecheck", "unit-tests", "test-summary"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null, "required_conversation_resolution": true }
JSON
```
