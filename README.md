# Qualio E2E action

Runs the Playwright tests that [Qualio AI](https://github.com/qualio-ai) generates in your repository, then reports the results to Qualio. It sends pass/fail per test, logs, and failure artifacts (videos, screenshots, traces, DOM and ARIA snapshots). Failures go to Qualio's Runner, which fixes test drift (renamed buttons, moved fields) with a commit to the same pull request. It never hides a real application bug.

The tests run on your own GitHub Actions runner, inside your network, so Qualio never needs access to private environments.

```yaml
- uses: actions/checkout@v4
- uses: qualio-ai/qualio-action@v1
  with:
    api-key: ${{ secrets.QUALIO_API_KEY }}
    api-url: https://qualio.example.com   # your Qualio URL
```

Projects that keep their tests in Qualio don't commit a tests folder at all: the action downloads the tests for the branch, and when Qualio heals a failure it runs them again in the same job.

```yaml
- uses: qualio-ai/qualio-action@v1
  with:
    tests-source: qualio
    api-key: ${{ secrets.QUALIO_API_KEY }}
    api-url: https://qualio.example.com
```

`https://qualio.example.com` stands for your Qualio address throughout this README.

**Contents**

- [Part 1: Set up Qualio for your repository](#part-1-set-up-qualio-for-your-repository) (customers)
- [Part 2: Action reference](#part-2-action-reference)
- [Part 3: Publishing this action](#part-3-publishing-this-action) (Qualio maintainers)
- [Development](#development)

---

## Part 1: Set up Qualio for your repository

This is the whole flow, from an empty Qualio workspace to a tested, self-healing pull request. Qualio's in-app guide (**Docs → Getting started**, opened from a project) shows the same steps with your project's own values filled in.

### What you need

- A Qualio account with a workspace (you are its **Owner** or **Admin**).
- A GitHub repository for the tests. It can be your application's repository or a separate one. You need **admin** rights on it to install the GitHub App and add secrets.
- An environment of your application to test (staging, preview or test), with one test account per user role (e.g. *Admin*, *Teacher*). Never use production accounts.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`) for the commands below. Every step can also be done in the browser.

### How it fits together

```
Qualio (agents)                         Your GitHub repository
───────────────                         ──────────────────────
Analyst writes the spec
Coder writes the tests  ──── PR ───►    e2e/ (tests) + .github/workflows/qualio.yml
                                              │  pull_request / Run tests
                                              ▼
                                        GitHub Actions runner
                                          qualio-ai/qualio-action@v1
                                          npm ci → Chromium → playwright test
Runs, artifacts, heal  ◄── results ──     e2e/support/qualio-reporter.ts
Runner heals drift     ──── commit ──►    same PR, "[qualio-heal]"
```

### Step 1: Create the project

1. In your workspace, choose **New project**.
2. Pick the **target mode**:
   - **Public URL:** Qualio can reach the app over the internet (e.g. `https://staging.example.com`). Qualio can crawl it and can also run tests itself (**Run in Qualio**), with or without GitHub.
   - **Private (GitHub Actions):** the app is only reachable inside your network. The tests run only in your CI, through this action.
3. **Private projects:** copy the **Project API key** shown after creation. It is shown only once (you can generate a new one later, see Step 4).
4. The setup wizard continues with test accounts, the first crawl and a first test suite. Every step can be skipped and resumed from the project overview.
5. In **Project settings**, write the **project overview**: what the app does, its main user journeys, domain terms and business rules. All agents read it first.

### Step 2: Add test accounts

Under **Project settings → Test accounts**, add one account per role with its username and password. Qualio stores the passwords encrypted and uses them for crawling and hosted runs. In CI, each role becomes a pair of repository secrets:

| Role in Qualio | Secrets in GitHub |
| --- | --- |
| `Admin` | `E2E_ADMIN_USERNAME`, `E2E_ADMIN_PASSWORD` |
| `Head teacher` | `E2E_HEAD_TEACHER_USERNAME`, `E2E_HEAD_TEACHER_PASSWORD` |

(Upper case, with spaces and dashes turned into `_`. Projects without roles use `E2E_USERNAME` / `E2E_PASSWORD`.)

### Step 3: Map the application

Open **Map → Start crawl**. Qualio opens the app in a browser, signed out and then as each role. It follows links but never submits forms, and it records each page's accessibility tree, form fields and verified locators. Each crawl adds a new version to the **Knowledge base**. For a Private app, Qualio cannot crawl it, so describe the pages in the project overview and feature chats instead.

### Step 4: Connect the GitHub repository

1. Open **Project settings → GitHub → Connect GitHub**.
2. GitHub asks you to install the **Qualio GitHub App**. Install it on the account or organization that owns the tests repository, and select **Only select repositories → your repository**. The app needs read and write access to contents, pull requests, workflows and actions (to open PRs, commit heals and start **Run tests**).
3. Back in Qualio, choose:
   - the **repository**,
   - the **target branch** that Qualio's pull requests go into (e.g. `main`),
   - the **tests folder** (default `e2e`). This is the action's `working-directory`.
4. If you didn't copy a key in Step 1, open **Settings → API keys** and generate one for the project. Keys can be rotated and revoked there. Qualio stores only a hash, so copy the key now.

### Step 5: Add the repository secrets and variables

In GitHub, open the repository's **Settings → Secrets and variables → Actions**:

- **Secrets** tab → **New repository secret** for each secret.
- **Variables** tab → **New repository variable** for each variable.

Or use the GitHub CLI (each `gh secret set` prompts for the value, so it never lands in your shell history):

```sh
REPO=your-org/your-repo

# Required: lets the workflow report results to Qualio.
gh secret set QUALIO_API_KEY --repo $REPO

# One pair per test account role (see Step 2).
gh secret set E2E_ADMIN_USERNAME --repo $REPO
gh secret set E2E_ADMIN_PASSWORD --repo $REPO

# Optional: the environment under test (default: the target URL from Qualio).
gh variable set QUALIO_BASE_URL --repo $REPO --body https://staging.example.com

# Optional: where your runners reach Qualio (default: written into qualio.yml by Qualio).
gh variable set QUALIO_API_URL --repo $REPO --body https://qualio.example.com
```

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `QUALIO_API_KEY` | Secret | Yes | The Project API key. Without it the tests still run, but nothing is reported or healed. |
| `E2E_<ROLE>_USERNAME`, `E2E_<ROLE>_PASSWORD` | Secrets | If the app needs sign-in | One pair per test account role. |
| `QUALIO_BASE_URL` | Variable | No | The URL of the environment under test. |
| `QUALIO_API_URL` | Variable | No | The Qualio URL your runners report to. |

Check that the key works:

```sh
curl -H "Authorization: Bearer <your key>" https://qualio.example.com/v1/auth/verify
```

### Step 6: Make sure the runner can reach your app

The tests open your app from the GitHub Actions runner, so the runner needs network access to it:

- **App reachable from the internet** (public staging, preview deployments): the generated workflow's `runs-on: ubuntu-latest` works as is.
- **App only inside your network:** use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) that sits in that network, and change `runs-on` in `.github/workflows/qualio.yml` to its labels (e.g. `runs-on: [self-hosted, linux]`). The runner needs Linux or macOS, Node.js-compatible tooling and outbound HTTPS to GitHub and to Qualio. The action installs Chromium and its system packages (on Linux this needs `sudo`).

The runner always needs outbound HTTPS to Qualio (`QUALIO_API_URL`) to report results. Qualio never connects into your network.

### Step 7: Create your first feature

Approve the **first test suite** the Planner proposed (Step 1's wizard, or the project overview), or create a feature yourself:

1. **Features → New feature**: describe what users should be able to do. Features also arrive as **Tickets**, pasted, from Jira (**Project settings → Jira → Connect with Jira**) or from `POST /v1/tickets`.
2. Answer the **Analyst's** clarifying questions in the feature chat.
3. Review the user stories and test cases, then choose **Approve spec**.
4. The **Coder** writes Playwright + TypeScript tests (Page Object Model, accessible locators), type-checks them, and opens a pull request from `qualio-bot/<FEATURE-KEY>` (e.g. `qualio-bot/SCH-9`, or `qualio-bot/F-1001`) into your target branch.

The **first** Qualio pull request also adds:

- `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/support/*` (test fixture, accounts, the Qualio reporter);
- `.github/workflows/qualio.yml`, which calls this action:

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
    # Test accounts, read by e2e/support/env.ts.
    env:
      E2E_ADMIN_USERNAME: ${{ secrets.E2E_ADMIN_USERNAME }}
      E2E_ADMIN_PASSWORD: ${{ secrets.E2E_ADMIN_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: qualio-ai/qualio-action@v1
        with:
          working-directory: e2e
          api-key: ${{ secrets.QUALIO_API_KEY }}
          api-url: ${{ vars.QUALIO_API_URL || 'https://qualio.example.com' }}
          base-url: ${{ vars.QUALIO_BASE_URL }}
```

Qualio never overwrites this file afterwards, so you can customise it (runner, triggers, timeout). Keep `workflow_dispatch` and the file name `qualio.yml`: Qualio's **Run tests** button and the re-run after a heal start the workflow by that name. If you add a role later, add its two `env` lines here as well.

### Step 8: The run, the results and self-healing

1. The pull request triggers **Qualio E2E**. The action installs the dependencies and Chromium, runs `npx playwright test`, and the Qualio reporter sends every result to Qualio, with videos, screenshots, traces and page snapshots of failures.
2. The run appears in Qualio under **Runs** and on the feature, which moves to **Passing** or **Failing**. The GitHub job summary links to it, and Playwright's HTML report is kept as the `playwright-report` artifact.
3. **Pass:** the check is green. Review the code like any pull request and merge it. The feature becomes **Merged**.
4. **Fail:** Qualio's Runner classifies each failure:
   - **Test drift** (selector, text or layout change while the app behaves as specified): Qualio fixes the page objects and pushes a commit tagged `[qualio-heal]` (with a `Qualio-Heal-Attempt: n/3` trailer) to the same pull request, and the workflow runs again. It makes at most 3 attempts per pull request and never removes assertions or skips tests.
   - **Application bug** (server errors, failed requests, error pages, or a control that disappeared): the tests are **not** changed. Qualio comments on the pull request, sets a failing `qualio/regression` commit status, and, for Jira tickets, comments on the issue mentioning its reporter. Fix the app, or update the spec in the chat if the change was intended.
5. **Run tests** on a feature re-runs the workflow at any time.

To make the tests gate merges, add the **Qualio E2E / e2e** check under **Settings → Branches → Branch protection rules → Require status checks to pass** (and `qualio/regression` if you want regressions to block too).

### Running the tests locally

```sh
cd e2e
npm install
npx playwright install chromium
E2E_ADMIN_USERNAME=… E2E_ADMIN_PASSWORD=… QUALIO_BASE_URL=https://staging.example.com npx playwright test
```

Without `QUALIO_API_KEY`, local runs are not reported to Qualio.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Unable to resolve action qualio-ai/qualio-action@v1` | The `uses:` line must be exactly `qualio-ai/qualio-action@v1`. If your organization restricts actions (**Settings → Actions → General → Allow … actions**), allow `qualio-ai/qualio-action@*`. |
| `The tests folder 'e2e' does not exist` | `working-directory` must match the tests folder chosen in Qualio, and `actions/checkout` must run before the action. |
| `api-key or api-url is empty` warning, or `[qualio] … not set` | Add the `QUALIO_API_KEY` secret. Pull requests from **forks** get no secrets from GitHub, so their runs are never reported. |
| `[qualio] Could not register the run: 401` | The key is wrong, revoked or belongs to another project. Create a new one under **Settings → API keys** and update the secret. |
| `[qualio] Could not register the run: fetch failed` | The runner can't reach Qualio. Check `QUALIO_API_URL` and outbound HTTPS from the runner. |
| The run shows **Errored** in Qualio | The workflow stopped before reporting. Open the job's logs in GitHub. |
| Tests fail at sign-in | Set `E2E_<ROLE>_USERNAME` / `_PASSWORD` for every role, and add each pair to the job's `env` in `qualio.yml`. |
| `page.goto: net::ERR_NAME_NOT_RESOLVED` / timeouts | The runner can't reach the app. Check `QUALIO_BASE_URL`, or use a self-hosted runner (Step 6). |
| **Run tests** does nothing | `qualio.yml` must keep `workflow_dispatch` and its file name, and exist on the branch being run. |

---

## Part 2: Action reference

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `tests-source` | `repo` | `repo`: run the tests folder in the repository. `qualio`: download the project's tests from Qualio for this branch (see [Tests served by Qualio](#tests-served-by-qualio)). |
| `working-directory` | `e2e` | The tests folder (holds `package.json` and `playwright.config.ts`). Only with `tests-source: repo`. |
| `api-key` | required | The Project API key, from the `QUALIO_API_KEY` secret. If empty, the tests still run but nothing is reported (with a warning); `tests-source: qualio` fails instead, since it can't download the tests. |
| `api-url` | required | The Qualio URL that results are reported to. |
| `base-url` | `''` | The environment under test. Empty uses the target URL in `playwright.config.ts`. |
| `commit-sha` | PR head SHA, else `github.sha` | The commit the results belong to. |
| `heal-wait-minutes` | `10` | With `tests-source: qualio`, how long to wait for Qualio's heal of a failed run before giving up on the re-run. |
| `node-version` | `20` | The Node.js version. |
| `upload-report` | `true` | Keep Playwright's HTML report as the `playwright-report` artifact. |
| `report-retention-days` | `14` | Days to keep the report artifact. |

### Outputs

| Output | Description |
| --- | --- |
| `playwright-version` | The `@playwright/test` version installed in the tests folder. |
| `qualio-run-url` | The run's page in Qualio (the re-run's, after a heal). Empty when the results were not reported. |
| `heal-status` | With `tests-source: qualio`, how healing a failed run ended: `patched`, `not_healable`, `stopped`, `failed`, `timeout` or `none`. Empty when the tests passed or weren't run. |

### What it does

1. Checks that `working-directory` holds a tests folder, and warns if `api-key` or `api-url` is empty.
2. Sets up Node.js.
3. Installs the tests folder's dependencies (`npm ci` with a lockfile, `npm install` otherwise).
4. Installs Chromium and its system dependencies, caching the browser per Playwright version.
5. Runs `npx playwright test` with `QUALIO_API_URL`, `QUALIO_API_KEY`, `QUALIO_BASE_URL` and `QUALIO_COMMIT_SHA` set. The generated `support/qualio-reporter.ts` uses them to report to Qualio and request self-healing. A failing test fails the job.
6. Uploads Playwright's HTML report as the `playwright-report` artifact.
7. Writes a job summary with the result and a link to the run in Qualio.

Test account secrets (`E2E_<ROLE>_…`) are not inputs: set them in the job's `env`, which the action's steps inherit. The action never prints the API key.

### Tests served by Qualio

With `tests-source: qualio` (projects whose **Where tests live** setting is *Qualio*), the repository only holds `.github/workflows/qualio.yml`, which Qualio's Getting started page gives you. The workflow should run on `pull_request` with `types: [opened, synchronize, reopened, closed]` and on `workflow_dispatch`.

1. The action downloads the tests for the branch (`POST /v1/tests/bundle`) into `$RUNNER_TEMP/qualio-e2e`: the main tests, plus heals Qualio made on this branch. Before Qualio has generated any tests, it logs a notice and runs nothing.
2. It installs and runs them as above. The reporter writes the run id to a file so the action can follow the heal.
3. If tests fail, it waits up to `heal-wait-minutes` for Qualio's verdict (`POST /v1/tests/heal/status`). When Qualio patched the tests, it downloads them again and re-runs them; the job's result is the re-run's. Real application bugs are never healed, so the job fails.
4. When the pull request closes, the action tells Qualio (`POST /v1/tests/promote`): merged, the branch's heals become the main tests; closed without merging, they are dropped. Nothing is run.

Run the tests on the target branch on demand with Qualio's **Run tests** (it dispatches the workflow). There's deliberately no `push` trigger: a merge's push would race the promotion of the pull request's heals.

### Versioning

Releases are tagged `v1.x.y`, and the `v1` tag moves to the latest `v1` release. Pin `@v1` to receive fixes automatically, or a full tag (`@v1.2.0`) or commit SHA to stay fixed. Within `v1`, inputs are only ever added, never removed or changed incompatibly.

---

## Part 3: Publishing this action

Every customer's `qualio.yml` calls `qualio-ai/qualio-action@v1`. That reference resolves only once this repository is **public**, at **`github.com/qualio-ai/qualio-action`**, with a **`v1`** tag. Until then, every customer workflow fails with "Unable to resolve action". The default reference lives in `qualio-webapp/packages/agents/src/coder/scaffold.ts` (`QUALIO_ACTION_REF`).

### 1. Create the `qualio-ai` organization (once)

1. On GitHub, open your avatar menu → **Your organizations → New organization** (the Free plan is enough).
2. Name it **`qualio-ai`**. If that name is taken, pick another and update `QUALIO_ACTION_REF` in qualio-webapp, its tests, `.env.example`, the Getting Started page and this README.
3. Add the other maintainers as members.

### 2. Move the repository into the organization

The repository currently lives at `ThiagoSilvaF/qualio-action`. **Transfer** it (GitHub keeps redirects, issues and history):

1. Open `https://github.com/ThiagoSilvaF/qualio-action` → **Settings → General → Danger Zone → Transfer**.
2. Enter `qualio-ai` as the new owner and confirm.
3. Point your local clone at the new location:

   ```sh
   cd qualio-action
   git remote set-url origin https://github.com/qualio-ai/qualio-action.git
   git fetch origin
   ```

Alternatively, create an empty **public** `qualio-ai/qualio-action` repository (no README or license, so there is no conflicting history) and push to it:

```sh
git remote set-url origin https://github.com/qualio-ai/qualio-action.git
git push -u origin main
```

### 3. Make it public and allow it to be used

1. **Settings → General → Danger Zone → Change visibility → Public**. Other organizations' workflows can only use actions from public repositories (or, on GitHub Enterprise, internal repositories that allow access).
2. **Settings → Actions → General**: allow actions (needed for this repository's own `Test` and `Release` workflows). Under **Workflow permissions**, keep the default read permissions. The `Release` workflow asks for `contents: write` itself.
3. Optional: protect `main` (**Settings → Branches**) and require the `lint`, `fixture` and `missing-folder` checks.

### 4. Check that the tests pass

Pushing to `main` runs the **Test** workflow: actionlint, the action on `test/fixture` (with `uses: ./`), and a run with a missing folder that must fail cleanly. Open **Actions → Test** and make sure it is green before releasing.

### 5. Release `v1.0.0`

With the GitHub CLI, from an up-to-date `main`:

```sh
gh release create v1.0.0 --repo qualio-ai/qualio-action --target main \
  --title "v1.0.0" --notes "First release of the Qualio E2E action."
```

Or in the browser: **Releases → Draft a new release → Choose a tag → type `v1.0.0` → Create new tag on publish**, target `main`, add notes, then **Publish release**.

Publishing the release runs the **Release** workflow, which creates (or moves) the **`v1`** tag to the same commit. Check it:

```sh
git fetch --tags --force origin
git rev-parse v1.0.0^{commit} v1^{commit}   # both lines must be the same SHA
```

If the workflow can't push the tag (for example, an organization policy forces read-only tokens), move it by hand:

```sh
git tag -f v1 v1.0.0 && git push -f origin refs/tags/v1
```

### 6. Optional: list it on the GitHub Marketplace

Listing isn't required for `uses: qualio-ai/qualio-action@v1` to work, but it makes the action discoverable.

Requirements: the repository is public, it has exactly one action metadata file at the root (`action.yml`, as here), and whoever publishes uses **two-factor authentication**. Listings are not reviewed by GitHub and go live straight away.

1. An organization owner accepts the [GitHub Marketplace Developer Agreement](https://docs.github.com/en/actions/sharing-automations/creating-actions/publishing-actions-in-github-marketplace). Until then, the **Publish** checkbox is disabled.
2. The action's `name:` must be unique on the Marketplace, and must not match a Marketplace category, a GitHub feature or another user's or organization's name. If **Qualio E2E** is rejected, change `name:` in `action.yml` (e.g. `Qualio AI E2E Tests`). This doesn't affect `uses:`.
3. When drafting a release, tick **Publish this Action to the GitHub Marketplace**, choose the categories (*Testing*, *Continuous integration*) and publish. The `branding` (icon `check-circle`, colour `purple`) is already set.

### 7. Point Qualio at the published action

`qualio-webapp` already defaults to `qualio-ai/qualio-action@v1`, so no change is needed. To test unreleased changes, set `QUALIO_ACTION_REF` in qualio-webapp's `.env` (e.g. `qualio-ai/qualio-action@my-branch` or a fork). This only affects workflows Qualio generates from then on, because an existing `qualio.yml` is never overwritten.

### 8. Verify end to end from a scratch repository

1. Create a private test repository with a Qualio project connected to it (Part 1, Steps 1–5). The [school demo](https://github.com/ThiagoSilvaF/qualio-school-demo) makes a good target app.
2. Approve a feature. Qualio's pull request adds `e2e/` and `qualio.yml`.
3. Confirm the **Qualio E2E** check runs, its summary links to the run in Qualio, and the run appears under **Runs**.

### Later releases

1. Merge the changes to `main` and wait for **Test** to pass.
2. `gh release create v1.1.0 …` (a feature or new optional input) or `v1.0.1` (a fix). **Release** moves `v1`.
3. **Never break `v1`.** Customers' workflows are never rewritten, so removing or renaming an input, or changing a default's meaning, needs `v2.0.0`. That release creates a `v2` tag automatically, and you then update `QUALIO_ACTION_REF` in qualio-webapp to `@v2`.
4. When you add or rename an input, also update `workflowFile()` and its tests in qualio-webapp, the in-app Getting Started page and this README.

To withdraw a bad release, move `v1` back to the previous good tag (`git tag -f v1 v1.0.0 && git push -f origin refs/tags/v1`), then mark the bad release as a pre-release or delete it.

---

## Development

- `action.yml`: the composite action. Steps use `shell: bash` and never echo secrets.
- `scripts/qualio.mjs`: the Qualio API calls of `tests-source: qualio` (download the tests, wait for the heal, keep or drop heals when a pull request closes). Node 20, no dependencies.
- `test/fixture`: a stand-in for a generated tests folder (`@playwright/test` pinned to the same version as qualio-webapp).
- `test/stub-qualio.mjs`: a stub of Qualio's CI API that serves a failing test, reports it healed, then serves the fixed one.
- `.github/workflows/test.yml`: actionlint, the action on the fixture (`uses: ./`), the missing-folder failure path, and `tests-source: qualio` against the stub (fail, heal, re-run, pass).
- `.github/workflows/release.yml`: moves the major tag on each published release.

Run the fixture locally:

```sh
cd test/fixture && npm install && npx playwright install chromium
QUALIO_API_URL=http://qualio.test QUALIO_COMMIT_SHA=local E2E_ADMIN_USERNAME=admin@example.test npx playwright test
```

Check `tests-source: qualio` locally against the stub (the first run fails, the second passes after the "heal"):

```sh
node test/stub-qualio.mjs 4555 &
export QUALIO_API_URL=http://localhost:4555 QUALIO_API_KEY=qk_stub QUALIO_POLL_MS=200
node scripts/qualio.mjs download /tmp/qualio-e2e demo/x && cd /tmp/qualio-e2e && npm install
QUALIO_RUN_FILE=/tmp/qualio-run.json npx playwright test; node "$OLDPWD/scripts/qualio.mjs" wait /tmp/qualio-run.json 1
node "$OLDPWD/scripts/qualio.mjs" download . demo/x && QUALIO_RUN_ROUND=2 npx playwright test
```

To run the workflows locally, use [act](https://github.com/nektos/act): `act -j fixture`.
