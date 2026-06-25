# Ambient Version Agent

An AI agent (Claude Code) that turns the daily Next.js bump from a *deterministic
re-run of the existing tests* into an *actual review of the new version* —
reading release notes, writing fresh e2e tests for new cache-component behavior,
and deciding whether to ship.

## The autonomous loop

```
nextjs-version-check.yml (daily cron)
  └─ detects new Next.js → branch nextjs-<v> → bump → quick e2e → opens PR
        └─ dispatches ▶ ambient-version-agent.yml
              └─ Claude Code, per PR:
                   1. checks out the branch
                   2. reads the Next.js <v> release notes
                   3. runs the full suite (unit + e2e: memory & redis)
                   4. writes/adjusts e2e tests for new behavior, pushes them
                   5. clean  → comments summary, APPROVES, squash-merges
                      issue  → comments findings, leaves PR open (no approval)
                        └─ merge → tag-on-version-merge.yml → publish.yml (OIDC)
                              └─ npm publish + GitHub release (contributors credited)
```

Everything downstream of the merge is already automated and tokenless (see
[publishing](./publishing/AUTOMATED_RELEASE.md)). The agent closes the one gap
that required a human: **judging and merging** the bump.

## One-time setup

1. **`ANTHROPIC_API_KEY`** repo secret — the agent's model access.
   `gh secret set ANTHROPIC_API_KEY`

2. **An approval-capable identity.** GitHub forbids the default `GITHUB_TOKEN`
   from *approving* pull requests, so the agent needs its own identity:
   - **Recommended:** install the **Claude GitHub App** on this repo — the action
     then acts as `claude[bot]` and can approve/comment/merge. *or*
   - Set **`AGENT_GITHUB_TOKEN`** to a PAT / fine-grained token (account other
     than the PR author) with **Pull requests: read & write** and **Contents:
     read & write**. The workflow uses it via the `github_token` input.

3. Keep branch protection's **1 required approval** — that's the gate the agent
   satisfies. Required status checks still apply, so the agent's merge only goes
   through once CI is also green.

## Triggers

- **Automatic:** `nextjs-version-check.yml` dispatches the agent for each new
  bump PR.
- **Scheduled fallback:** runs daily (~02:00 UTC) and processes any open
  `nextjs-*` PR that wasn't handled.
- **Manual:** `gh workflow run ambient-version-agent.yml -f pr_number=<N>`.

## Guardrails

- The agent may only edit tests, version files, and lockfiles — it must **not**
  change library source to force tests green. A real regression is surfaced (PR
  left open + comment), never hidden.
- It must not approve on red.
- Concurrency is limited per-PR so two runs don't fight.

## Status

v0 scaffold. Validate with a manual run against a real bump PR before relying on
it unattended, and tune the prompt/allowed-tools as you learn what it gets right.
The action version (`anthropics/claude-code-action@v1`) and model id may need
pinning to whatever is current.
