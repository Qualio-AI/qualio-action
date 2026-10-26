# Qualio E2E action

Runs the Playwright tests that [Qualio AI](../qualio-webapp) generates in your repository and reports the results to Qualio: pass/fail per test, logs, and failure artifacts (videos, screenshots, traces, DOM and ARIA snapshots). Failures go to Qualio's Runner, which heals selector drift with a commit to the same pull request and never hides a real application bug.

The tests run on your own GitHub Actions runner, inside your network, so Qualio never needs access to private environments.

## Usage

Qualio's first pull request adds this workflow as `.github/workflows/qualio.yml`. You can also write it yourself:

```yaml
name: Qualio E2E

on:
  pull_request:
    paths: ['e2e/**']
  workflow_dispatch:

concurrency:
  group: qualio-e2e-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # Test accounts, one pair per role (read by e2e/support/env.ts).
    env:
      E2E_ADMIN_USERNAME: ${{ secrets.E2E_ADMIN_USERNAME }}
      E2E_ADMIN_PASSWORD: ${{ secrets.E2E_ADMIN_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: qualio-ai/qualio-action@v1
        with:
          working-directory: e2e
          api-key: ${{ secrets.QUALIO_API_KEY }}
          api-url: ${{ vars.QUALIO_API_URL || 'https://your-qualio-host' }}
          base-url: ${{ vars.QUALIO_BASE_URL }}
```

Keep `workflow_dispatch`: Qualio's **Run tests** button and the re-run after a heal dispatch the workflow by its file name, `qualio.yml`.

## What it does

1. Sets up Node.js.
2. Installs the tests folder's dependencies (`npm ci` with a lockfile, `npm install` otherwise).
3. Installs Chromium and its system dependencies, caching the browser per Playwright version.
4. Runs `npx playwright test` with `QUALIO_API_URL`, `QUALIO_API_KEY`, `QUALIO_BASE_URL` and `QUALIO_COMMIT_SHA` set, which the generated `support/qualio-reporter.ts` uses to report to Qualio.
5. Uploads Playwright's HTML report as the `playwright-report` artifact.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `working-directory` | `e2e` | The tests folder (holds `package.json` and `playwright.config.ts`). |
| `api-key` | required | Your Project API Key, stored as the `QUALIO_API_KEY` secret. Without it, the tests still run but nothing is reported. |
| `api-url` | required | The Qualio URL that results are reported to. |
| `base-url` | `''` | The environment under test. Empty uses the target URL in `playwright.config.ts`. |
| `commit-sha` | PR head SHA, else `github.sha` | The commit the results belong to. |
| `node-version` | `20` | The Node.js version. |
| `upload-report` | `true` | Keep the HTML report as a workflow artifact. |
| `report-retention-days` | `14` | Days to keep the report. |

## Secrets and variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `QUALIO_API_KEY` | Secret | Required. The Project API Key from Qualio (**Settings → API keys**). |
| `E2E_<ROLE>_USERNAME` / `E2E_<ROLE>_PASSWORD` | Secrets | One pair per test account role (e.g. `E2E_ADMIN_…`), passed through the job's `env`. |
| `QUALIO_BASE_URL` | Variable | Optional. The environment under test. |
| `QUALIO_API_URL` | Variable | Optional. Overrides the Qualio URL. |

## Versioning

Releases are tagged `v1.x.y`, and the `v1` tag moves to the latest compatible release. Pin `@v1` to get fixes, or a full tag or commit SHA to stay fixed. Inputs only change in a backwards-incompatible way in a new major version.

## Development

`test/fixture` is a stand-in for a generated tests folder. The `Test` workflow runs actionlint and runs the action on the fixture with `uses: ./`. To try the fixture locally:

```sh
cd test/fixture && npm install
QUALIO_API_URL=http://qualio.test QUALIO_COMMIT_SHA=local E2E_ADMIN_USERNAME=admin@example.test npx playwright test
```
