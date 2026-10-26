# CLAUDE.md — qualio-action

The GitHub Action (composite, `action.yml`) that customers' `.github/workflows/qualio.yml` calls to run Qualio's generated Playwright tests on their own runners and report to Qualio. Product rules live in the global `../CLAUDE.md`; the platform is `../qualio-webapp`.

## Contract with qualio-webapp

- **Workflow → action:** the Coder writes the workflow in `../qualio-webapp/packages/agents/src/coder/scaffold.ts` (`workflowFile()`, `QUALIO_ACTION_REF`). It passes `working-directory`, `api-key`, `api-url` and `base-url`, and puts the test account secrets (`E2E_<ROLE>_USERNAME/_PASSWORD`) in the job-level `env`, which this action's steps inherit.
- **Action → reporter:** the generated tests folder carries `support/qualio-reporter.ts` (from `../qualio-webapp/packages/reporter`). It reports only when `QUALIO_API_URL` and `QUALIO_API_KEY` are set, and reads `QUALIO_COMMIT_SHA` (falling back to `GITHUB_SHA`) and the branch from `GITHUB_HEAD_REF`/`GITHUB_REF_NAME`. The generated `playwright.config.ts` reads `QUALIO_BASE_URL`.
- **Dispatch:** Qualio's **Run tests** and post-heal re-runs dispatch the workflow file `qualio.yml` (`workflow_dispatch`).
- When you add or rename an input, update `workflowFile()` and its tests in qualio-webapp, the Getting Started page (`apps/web/src/app/docs/getting-started/page.tsx`) and this README.

## Rules

- **Backwards compatible within `v1`:** customers' `qualio.yml` is never overwritten by Qualio, so old workflows must keep working. Only add optional inputs; breaking changes need `v2`.
- **No secrets in logs:** never `echo` inputs; pass `api-key` to steps only through `env`.
- **Composite only:** steps use `shell: bash` and `working-directory: ${{ inputs.working-directory }}`; third-party actions are pinned to a major version (`actions/*@v4`).
- **Never fail silently:** a failing test must fail the job; the HTML report upload runs `if: !cancelled()`.
- **Playwright version:** browsers are cached per the tests folder's `@playwright/test` version. Keep `test/fixture` on the same version as qualio-webapp (`packages/reporter`, `docker/hosted-runner`).
- Check changes with the `Test` workflow (actionlint plus `uses: ./` on `test/fixture`), and run the fixture locally (see the README).
