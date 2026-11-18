# CLAUDE.md — qualio-basher-action

The GitHub Action of Qualio v2 (the Basher). Its product rules live in `../qualio-v2/CLAUDE.md`; its contract with
Qualio in `../qualio-v2/specs/tickets-pull-requests-and-tests.md` (The GitHub Action, The browser host). The global
`../CLAUDE.md` describes v1's `../qualio-action`, which this was copied from; only its Git guideline applies here.

- `scripts/qualio.mjs`: the whole job (sync, start, host, Qualio's asks, outbox, result).
- `scripts/host.mjs`: the job's browser host (relay channels to a local Chromium; fills `{{E2E_*}}` placeholders).
- `scripts/github.mjs`: posts the outbox with the job's `GITHUB_TOKEN`.
- `scripts/qualio-tests.mjs`: Qualio's tests run in the job (phase 21): download a task's tests into `$RUNNER_TEMP`, run them with this action's Playwright, post the report, upload the failures' evidence, delete the folder. `scripts/tests.mjs` dispatches Qualio's asks (and runs the team's own tests, `--shard` across a matrix).
- `@playwright/test` stays at the version `../qualio-v2` uses (it runs Qualio's tests here, and the worker's Playwright connects to this browser).
- Tests: `npm test` (node:test). `../qualio-v2/apps/worker/src/relay.test.ts` runs `scripts/host.mjs` against the real relay.
- Git: committing and pushing straight to `main` is allowed; never force-push a shared branch.
