# PR triage bot

`.github/workflows/pr-triage.yml` answers outside contributors' PRs within minutes.

- **On open/update** (and when the PR author replies): Claude reviews the PR against `main`, then
  posts a review and labels it `triage: ready to merge`, `triage: changes requested`, or
  `triage: needs maintainer`. Ready and needs-maintainer PRs @-mention the maintainer.
- **Weekly sweep** (Mondays): reminds the maintainer about PRs waiting on them for 7+ days, and checks
  in with contributors whose PRs have waited on them for 14+ days.
- **Never merges, approves, closes or pushes.** Merging stays with the maintainer.
- **Never runs PR code.** It checks out `main` and reads the PR through `gh pr diff`.

Re-run on one PR: `gh workflow run pr-triage.yml -f pr=<number>`.

## Setup

The bot authenticates with a Claude subscription token, not a pay-per-token API key:

```bash
claude setup-token                              # prints a long-lived OAuth token
gh secret set CLAUDE_CODE_OAUTH_TOKEN           # paste it
```
