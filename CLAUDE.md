# CLAUDE.md — qualio-action

The GitHub Action (composite, `action.yml`) that customers' `.github/workflows/qualio.yml` calls to run Qualio's generated Playwright tests on their own runners and report to Qualio. Product rules live in the global `../CLAUDE.md`; the platform is `../qualio-webapp`.

## Contract with qualio-webapp

- **Workflow → action:** the Coder writes the workflow in `../qualio-webapp/packages/agents/src/coder/scaffold.ts` (`workflowFile()`, `QUALIO_ACTION_REF`). It passes `working-directory`, `api-key`, `api-url` and `base-url`, and puts the test account secrets (`E2E_<ROLE>_USERNAME/_PASSWORD`) in the job-level `env`, which this action's steps inherit.
- **Action → reporter:** the generated tests folder carries `support/qualio-reporter.ts` (from `../qualio-webapp/packages/reporter`). It reports only when `QUALIO_API_URL` and `QUALIO_API_KEY` are set, and reads `QUALIO_COMMIT_SHA` (falling back to `GITHUB_SHA`) and the branch from `GITHUB_HEAD_REF`/`GITHUB_REF_NAME`. The generated `playwright.config.ts` reads `QUALIO_BASE_URL`.
- **First test suite (setup):** every run with an api-key first calls `scripts/qualio.mjs setup` → `POST /v1/setup/start`. Until the project has a ready suite, the job runs the mapper Qualio returns (`npx playwright test -c qualio-map.config.ts`; it posts to `/v1/setup/:suiteId/pages` and `/mapped` itself), polls `/v1/setup/:suiteId/status`, and for each `validate` downloads `/v1/tests/bundle` with `suiteId` and runs it with `QUALIO_RUN_ROUND=<check>`. The setup pull request is opened by a person (Qualio's onboarding gives a pre-filled GitHub link; Qualio never writes to the repository); in `repo` mode the tests folder may not exist yet on it.
- **Dispatch:** Qualio's **Run tests** and post-heal re-runs dispatch the workflow file `qualio.yml` (`workflow_dispatch`).
- **Pull request sync and the GitHub outbox:** on `pull_request` events `scripts/qualio.mjs sync` posts the event's pull request (never repository contents) to `/v1/pr/sync`; `outbox` (start and end of every job, input `github-token`) reads `/v1/pr/outbox`, sends each item (`COMMENT`, `STATUS`, `DISPATCH`, `LABEL`) with the GitHub REST API and acks it at `/v1/pr/outbox/:id/ack` (403/429/5xx stay pending for the next job; other 4xx are acked with the error); `errored` posts `/v1/runs/errored` when the job failed before results were reported. All three steps are `continue-on-error`. The served workflow grants `pull-requests`, `issues`, `statuses` and `actions` write for them.
- **Comment job:** `command: comment` (the served workflow's `comment` job, on `issue_comment`, no checkout) skips everything but `comment` (posts the event's comment to `/v1/pr/comment`) and the outbox, which then waits up to `reply-wait-minutes` while `/v1/pr/outbox` answers `waiting: true` (an agent is answering).
- **Tests served by Qualio (`tests-source: qualio`):** the workflow comes from `servedWorkflowFile()` in the same `scaffold.ts`. `scripts/qualio.mjs` calls `POST /v1/tests/bundle` (download), `/v1/tests/heal/status` (wait) and `/v1/tests/promote` (pull request closed). The action sets `QUALIO_RUN_FILE` (the reporter writes `{ runId, status, url, heal }` there) and `QUALIO_RUN_ROUND=2` for the re-run after a heal; the bundle's `.qualio-bundle.json` is sent by the reporter.
- When you add or rename an input, update `workflowFile()` and its tests in qualio-webapp, the Getting Started page (`apps/web/src/app/docs/getting-started/page.tsx`) and this README.

## Rules

- **Backwards compatible within `v1`:** customers' `qualio.yml` is never overwritten by Qualio, so old workflows must keep working. Only add optional inputs; breaking changes need `v2`.
- **No secrets in logs:** never `echo` inputs; pass `api-key` to steps only through `env`.
- **Composite only:** steps use `shell: bash` and `working-directory: ${{ steps.check.outputs.dir }}` (the `working-directory` input, or the downloaded tests with `tests-source: qualio`); third-party actions are pinned to a major version (`actions/*@v4`).
- **Never fail silently:** a failing test must fail the job; the HTML report upload runs `if: !cancelled()`.
- **Playwright version:** browsers are cached per the tests folder's `@playwright/test` version. Keep `test/fixture` on the same version as qualio-webapp (`packages/reporter`, `packages/crawler`).
- **Steps:** a preflight checks the tests folder (and warns, without echoing it, when the key is empty); the test output is `tee`'d to `$RUNNER_TEMP/qualio-playwright.log` so the job summary and the `qualio-run-url` output can pick up the reporter's `[qualio] Results reported: <url>` line. Keep that log line format in step with `../qualio-webapp/packages/reporter`.
- **Job summary style:** the setup's summary uses the same icons and GitHub alerts as Qualio's comments (local `alert`, `cell`, `details` in `scripts/qualio.mjs`, copies of `@qualio/shared/github-markdown`); the webapp's onboarding E2E checks it.
- **Qualio mode never fails silently either:** the first run's step continues on error so the heal and re-run can follow, and the final `Result` step fails the job unless the re-run passed. A `proposed` heal (the project asks first) ends the wait at once and fails the job with a pointer to Qualio; there is no re-run until someone decides.
- Check changes with the `Test` workflow (actionlint, `uses: ./` on `test/fixture`, the missing-folder failure path, `tests-source: qualio` and the setup against `test/stub-qualio.mjs`), and run the fixture and the stub locally (see the README).

## Releasing

Lives at `Qualio-AI/qualio-action`, referenced as `qualio-ai/qualio-action@v1` (owner names are case-insensitive); customers outside the organization need the repository public. Publishing a GitHub release `vX.Y.Z` runs `.github/workflows/release.yml`, which moves the major tag (`v1`); `v1` is on `v1.1.0`. The README's Part 3 has the step-by-step publishing guide.
