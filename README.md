# Qualio E2E action

Runs your repository's Playwright E2E tests (written by [Qualio AI](https://github.com/Qualio-AI), owned by you) and reports the results to Qualio: pass/fail per test, logs, and failure artifacts (videos, screenshots, traces, DOM and ARIA snapshots). Failures go to Qualio's Runner, which fixes test drift (renamed buttons, moved fields): the action re-runs the tests with the fix in the same job, and Qualio suggests it on the pull request. It never hides a real application bug.

The tests run on your own GitHub Actions runner, inside your network, so Qualio never needs access to private environments.

```yaml
- uses: actions/checkout@v4
- uses: qualio-ai/qualio-action@v1
  with:
    api-key: ${{ secrets.QUALIO_API_KEY }}
    api-url: https://qualio.example.com   # your Qualio URL
```

The tests live in the folder the `config` block's `tests.path` names (`e2e` by default). Qualio's changes to them (new tests, fixes) arrive as suggestions on the pull request, or as commits in **Qualio's pull request into your branch** (`qualio/pr-<n>`): you commit or merge them like any other code. The action only ever pushes Qualio's own `qualio/*` branches, which is why the workflow grants `contents: write`.

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
Coder writes the tests                  pull request (your branch)
        │                                     │  pull_request / Run tests
        ▼                                     ▼
Qualio's changes (not committed) ──►    GitHub Actions runner: qualio-ai/qualio-action@v1
                                          checkout e2e/ → snapshot to Qualio → Qualio's changes on top
                                          npm ci → Chromium → playwright test (Qualio's reporter)
Runs, artifacts, heal   ◄── results ──    re-run with the fix after a heal
Suggestions, Qualio PR  ──── outbox ──►   review suggestions on your PR, qualio/pr-<n> → your branch
```

Qualio keeps the specs, the runs, the logs and the artifacts. It keeps a copy of the tests folder only while a pull request needs it (at most 14 days), and never the rest of your repository.

### Step 1: Create the project

1. In your workspace, choose **New project**.
2. Optionally give the **application URL in CI**: where the app runs inside your GitHub Actions job (default `http://localhost:3000`). Qualio never reaches your app itself: it is mapped and tested in your CI, by this action.
3. Copy the **Project API key** shown after creation. It is shown only once (you can generate a new one later, see Step 4).
4. The setup wizard continues with test accounts, the repository and the **setup pull request** (Step 3). Every step can be skipped and resumed from the project overview.
5. In **Project settings**, write the **project overview**: what the app does, its main user journeys, domain terms and business rules. All agents read it first.

### Step 2: Add test accounts

Under **Project settings → Test accounts**, add one account per role with its username and password. Qualio stores the passwords encrypted. In CI, where the app is mapped and tested, each role becomes a pair of repository secrets:

| Role in Qualio | Secrets in GitHub |
| --- | --- |
| `Admin` | `E2E_ADMIN_USERNAME`, `E2E_ADMIN_PASSWORD` |
| `Head teacher` | `E2E_HEAD_TEACHER_USERNAME`, `E2E_HEAD_TEACHER_PASSWORD` |

(Upper case, with spaces and dashes turned into `_`. Projects without roles use `E2E_USERNAME` / `E2E_PASSWORD`.)

### Step 3: The setup pull request maps the app and sets up the first test suite

The wizard's **Open setup pull request** (after Step 4's GitHub connection) commits `.github/workflows/qualio.yml` to `qualio-bot/setup`. Edit its **Start the application** step so your app runs in the job, add the secrets (Step 5), and push. The workflow's **first run**:

1. maps the application in the job with the mapper Qualio sends (signed out, then as each role; it follows links but never submits forms), and uploads each page's accessibility tree, form fields, verified locators and a screenshot to Qualio's **Knowledge base**;
2. waits while Qualio plans the features, writes their specs (approved automatically) and writes the Playwright tests;
3. runs those tests in the job. Tests that fail are repaired by Qualio and run again (up to 4 checks); tests that still fail are left out and listed, and a failure that looks like an application bug (server errors, error pages, missing controls) is never "repaired" into passing: it is left out and reported as a possible bug.

The job passes once every delivered test has passed. Qualio then opens a pull request into the setup branch that adds them to the tests folder (`qualio/qualio-bot/setup`): merge it, then the setup pull request. This first run takes longer than later ones; the workflow allows 120 minutes.

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

After the first test suite (Step 3), create features yourself:

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
   - **Test drift** (selector, text or layout change while the app behaves as specified): Qualio fixes the page objects, the action writes the fix into the job's checkout and runs the tests again. Once they pass, Qualio suggests the fix on the pull request (a review with ```` ```suggestion ```` blocks), or adds it to its pull request into your branch when the lines aren't in your diff. Commit the suggestion or merge Qualio's pull request. With *Balanced* or *Autonomous* self-healing a verified fix makes the check green right away; main keeps failing until the fix is committed. It makes at most 3 attempts per pull request and never removes assertions or skips tests.
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
| `Unable to resolve action qualio-ai/qualio-action@v1` | The `uses:` line must be exactly `qualio-ai/qualio-action@v1`. If your organization restricts actions (**Settings → Actions → General → Allow … actions**), allow `qualio-ai/qualio-action@*`. While the action's repository is private, only repositories in the `Qualio-AI` organization can use it (Part 3, step 1). |
| `The tests folder 'e2e' does not exist` | `tests.path` in the `config` block must name your tests folder, and `actions/checkout` must run before the action. |
| `can't push Qualio's branch (qualio/*)` warning | Add `contents: write` to the workflow's `permissions`: the action pushes only Qualio's own `qualio/*` branches. Until then Qualio's changes are shown in its pull request report. |
| `could not open the pull request` warning | Allow it in the repository's **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**, or open the pull request from the compare link in the warning. |
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
| `tests-source` | `''` | **Deprecated and ignored**: the tests always live in the repository (a notice asks to remove it). |
| `working-directory` | `''` | **Deprecated.** The tests folder when the config doesn't set `tests.path` (which wins). Empty uses the project's folder in Qualio (`e2e`). |
| `api-key` | required | The Project API key, from the `QUALIO_API_KEY` secret. If empty, the tests in `working-directory` (or `e2e`) still run but nothing is reported (with a warning). |
| `api-url` | required | The Qualio URL that results are reported to. |
| `base-url` | `''` | The environment under test. Empty uses the target URL in `playwright.config.ts`. |
| `config` | `''` | How Qualio works on this project, as YAML (`version: 1`): `overview` (documents in the repository), `specs.approval`, `self-healing` (`sensitivity`, `sure-from`, `rules`), `mapping` (`max-pages`, `start-paths`, `exclude`), `roles`, `github` (`target-branch`, `report`) and `jira` (`projects`, `board`, `columns`). Sent to Qualio (`POST /v1/config/sync`) in every job with a checkout; the settings it sets are read-only in Qualio. On a pull request, stricter changes apply to its branch at once and looser ones when it merges. An invalid config fails the job. See [Configuration](#configuration). |
| `config-file` | `''` | A YAML file in the repository with the same config (e.g. `.qualio/config.yml`), instead of `config`. Needs `actions/checkout`. |
| `commit-sha` | PR head SHA, else `github.sha` | The commit the results belong to. |
| `setup-wait-minutes` | `25` | The first run (no test suite yet) maps the app and checks the generated tests in the job. How long that may take before the job gives up; a re-run continues where it stopped. Keep it a few minutes under the job's `timeout-minutes`. |
| `heal-wait-minutes` | `10` | How long to wait for Qualio's heal of a failed run before giving up on the re-run. |
| `live-diagnosis` | `true` | While Qualio diagnoses failed tests, let it look at the running app from this job (see *Live diagnosis* below). `false` turns it off. |
| `node-version` | `20` | The Node.js version. |
| `upload-report` | `true` | Keep Playwright's HTML report as the `playwright-report` artifact. |
| `report-retention-days` | `14` | Days to keep the report artifact. |
| `command` | `test` | `test` runs the tests. `comment` is for the workflow's `comment` job (on `issue_comment`): it only tells Qualio about a new pull request comment (`POST /v1/pr/comment`), then posts Qualio's answer. |
| `reply-wait-minutes` | `3` | With `command: comment`, how long to wait for Qualio's answer before leaving it for the next job. |
| `github-token` | `${{ github.token }}` | Sends Qualio's pull request report (one comment, edited in place), its suggestions and its pull request into your branch, reactions, statuses, labels and re-runs (when Qualio's GitHub App isn't installed or lacks the permission). The workflow needs `permissions` `contents: write` (only Qualio's `qualio/*` branches are pushed), `pull-requests: write`, `issues: write`, `statuses: write` and `actions: write`. Empty sends nothing. |

### Outputs

| Output | Description |
| --- | --- |
| `playwright-version` | The `@playwright/test` version installed in the tests folder. |
| `qualio-run-url` | The run's page in Qualio (the re-run's, after a heal). Empty when the results were not reported. |
| `config-scope` | Where this job's config applied: `project`, `branch` or `none`. Empty without `config`/`config-file`. |
| `setup-state` | `ready` (the project already had its first suite) or `completed` (this job set it up). Empty when the setup didn't run (no `api-key`). |
| `heal-status` | How healing a failed run ended: `patched`, `proposed` (the project asks first: someone decides in Qualio), `declined`, `not_healable`, `stopped`, `failed`, `timeout` or `none`. Empty when the tests passed or weren't run. |

### Configuration

Qualio is configured from the workflow, so nobody needs its dashboard to set it up:

```yaml
      - uses: qualio-ai/qualio-action@v1
        with:
          api-key: ${{ secrets.QUALIO_API_KEY }}
          api-url: ${{ vars.QUALIO_API_URL }}
          config: |
            version: 1
            overview: docs/qualio/          # .md/.txt files the agents read: domain rules, journeys, skills
            tests:
              path: e2e                     # the E2E tests folder (package.json, playwright.config.ts)
              # suggestions: report-only    # review (default) | report-only: diffs in the report, no review comments
            specs:
              approval: automatic           # automatic | ask-me-first
            self-healing:
              sensitivity: balanced         # supervised | balanced | autonomous
            mapping:
              max-pages: 25
              exclude: [/logout]
            roles:                          # credentials: secrets E2E_<ROLE>_USERNAME / _PASSWORD
              - name: Admin
                description: Can do everything
```

The step **Sync the Qualio config** sends the YAML, then the overview documents Qualio asks for (only those whose content it doesn't have yet; at most 50 files and 256 KB). Qualio validates it: problems fail the job as `::error title=Qualio config::<key>: <problem>`, unknown keys are warnings, and anything that looks like a secret is refused. The target branch's config is the project's; a pull request's stricter changes apply to its branch at once, and its looser and project-wide ones when it merges. The job summary lists what changed.

### What it does

1. Warns if `api-key` or `api-url` is empty. Jobs of Qualio's own pull requests (`qualio/*`) and closed pull requests only tell Qualio about the pull request.
2. On every pull request event, tells Qualio what the pull request is (`POST /v1/pr/sync`: number, title, description, branch, head commit, merged, who opened it, and the names of test account secrets that were empty). This is how Qualio follows pull requests; it never reads the repository.
3. With `config` or `config-file`, sends Qualio the config and the overview documents it names (see [Configuration](#configuration)).
4. Sends what Qualio queued for GitHub (see below), at the start and the end of the job.
5. Asks Qualio whether the project has a first test suite (`POST /v1/setup/start`). If not, sets it up in this job: runs the mapper Qualio sends, waits for the suite (`/v1/setup/:id/status`), and writes each check of it into the tests folder of the checkout (`/v1/tests/changes` with `suiteId`) and runs it (`QUALIO_RUN_ROUND` = the check; no retries and a 20-second test timeout, so a wrong locator fails fast) until it is ready; the job then ends (`setup-state` output `completed`). Up to `setup-wait-minutes` (default 25).
6. **Prepares the tests** (`POST /v1/tests/prepare`, `/v1/tests/snapshot`): finds the tests folder (`tests.path`), sends Qualio a snapshot of it (hashes, then the contents Qualio doesn't have; never `node_modules` or Playwright's output), and writes the changes Qualio offers on this branch on top of the checkout (new tests and verified fixes: they run here before they're committed, and while they wait to be). Nothing is committed. A project whose tests Qualio still kept gets the whole folder until its move pull request is merged.
7. Installs the tests folder's dependencies (`npm ci` with a lockfile, `npm install` otherwise) and Chromium, caching the browser per Playwright version.
8. Runs `npx playwright test` with `QUALIO_API_URL`, `QUALIO_API_KEY`, `QUALIO_BASE_URL`, `QUALIO_COMMIT_SHA`, `QUALIO_RUN_MANIFEST` (the changes it applied) and `QUALIO_REPORTER` (Qualio's reporter, which this action brings: the generated `playwright.config.ts` adds it).
9. If tests fail, waits up to `heal-wait-minutes` for Qualio's verdict (`POST /v1/tests/heal/status`). When Qualio patched the tests, writes the fix on top (`/v1/tests/changes`) and runs them again; the job's result is the re-run's. Real application bugs are never healed, so the job fails. When the verdict is `proposed` (the self-healing level asks first), the job fails with a link: accept the fix in Qualio (it is then checked by the next run and suggested), or mark it as a bug.

**Live diagnosis.** While step 9 waits, Qualio may ask to see pages of your running app, for example to check whether a button was renamed or removed. Qualio never reaches your app; this job does it for Qualio. It starts Playwright MCP (`@playwright/mcp`, pinned, run with `npx`) on the Chromium your tests' Playwright already installed. It opens only the paths Qualio asks for on `base-url`'s origin, signed out or signed in as a role with that role's `E2E_<ROLE>_USERNAME`/`_PASSWORD` secrets. The secrets stay in the job and are passed only to the browser. Each page's accessibility snapshot is sent back, and a page that redirects to another site is not. Before Qualio applies a fix, the job also checks the fix's locators (for example `getByRole('button', { name: 'Log in' })`) on the page they belong on and reports how many elements each finds. A fix whose locators don't find exactly one element is proposed instead of applied. Nothing is clicked or filled in beyond the sign-in, and the browser process gets no other secrets (not `api-key` or `GITHUB_TOKEN`). The job log lists every page shown. Set `live-diagnosis: false` to turn it off.

**Exploring beyond links** (with `mapping.explore: true` in the config). On the first run, after the map, Qualio may ask this job to click buttons, tabs and menus on mapped pages to find what links can't reach, such as dialogs and tab panels. This happens in a separate browser where every request that could change data is blocked before it leaves the page: non-GET `fetch` and XHR (GraphQL queries are allowed), beacons, and POST form submits. Nothing is saved, deleted or sent. Sign-out, links off `base-url`'s origin and `mapping.exclude` URLs are never clicked. The job log lists every click and every write it blocked. `live-diagnosis: false` turns this off too.
10. Uploads Playwright's HTML report as the `playwright-report` artifact and writes a job summary with the result and a link to the run in Qualio. A job that fails before the reporter sent results tells Qualio (`POST /v1/runs/errored`).

Test account secrets (`E2E_<ROLE>_…`) are not inputs: set them in the job's `env`, which the action's steps inherit. The action never prints the API key.

### What Qualio sends to GitHub

At the start and end of every job the action sends what Qualio queued (`POST /v1/pr/outbox`, then `POST /v1/pr/outbox/:id/ack` per item) with `github-token`:

- the pull request's Qualio report (one comment per pull request: posted once, then edited in place; found by its hidden `<!-- qualio:report -->` marker if Qualio lost its id), reactions on `/qualio` commands, commit statuses, labels and `workflow_dispatch` re-runs;
- **Qualio's changes to the tests** of a branch, once a run proved them: a fix whose lines are all in the pull request's diff becomes a review with one ```` ```suggestion ```` per hunk; everything else (new tests, new files, fixes elsewhere) becomes one commit each on `qualio/pr-<n>`, rebuilt from your branch's head and force-pushed, with a pull request into your branch. Merge it to take them, close it to turn them down (Qualio learns from the reason). A change whose lines you changed since is left out. When the developer's pull request closes, Qualio's pull request is closed and its branch deleted. With `tests.suggestions: report-only`, without `contents: write`, or when GitHub doesn't let Actions open pull requests, the changes are shown in the report instead.

Missing token permissions only print a warning; the items wait for the next job.

The workflow's `comment` job runs on `issue_comment` with `command: comment`, without a checkout: it sends a person's new pull request comment to Qualio (`POST /v1/pr/comment`), a reply to the Analyst or a `/qualio accept`, `/qualio reject <why>`, `/qualio bug`, `/qualio revert` or `/qualio run` command, and posts Qualio's answer from the outbox. The Qualio GitHub App has no Contents or Pull requests permission, so pull request conversations and changes always go through the workflow.

Run the tests on the target branch on demand with Qualio's **Run tests** (it dispatches the workflow).

### Versioning

Releases are tagged `v1.x.y`, and the `v1` tag moves to the latest `v1` release. Pin `@v1` to receive fixes automatically, or a full tag (`@v1.2.0`) or commit SHA to stay fixed. Within `v1`, inputs are only ever added, never removed or changed incompatibly.

---

## Part 3: Publishing this action

This repository lives at **[`github.com/Qualio-AI/qualio-action`](https://github.com/Qualio-AI/qualio-action)**. GitHub owner names are case-insensitive, so the `qualio-ai/qualio-action@v1` reference in customers' `qualio.yml` (the default `QUALIO_ACTION_REF` in `qualio-webapp/packages/agents/src/coder/scaffold.ts`) resolves to it. Released so far: `v1.0.0` and `v1.1.0` (`tests-source: qualio`), with `v1` on `v1.1.0`. The next release (tests in the repository, suggestions and Qualio's pull requests) must ship with qualio-webapp's phase 49: older `v1` releases call `/v1/tests/bundle`, which answers 410 from then on.

### 1. Make it public and allow it to be used

Customers' workflows can only use the action once the repository is **public**. Until then, they fail with "Unable to resolve action".

1. **Settings → General → Danger Zone → Change visibility → Public**. Other organizations' workflows can only use actions from public repositories (or, on GitHub Enterprise, internal repositories that allow access).
2. While it is private, repositories in the `Qualio-AI` organization (such as the school demo) can still use it: **Settings → Actions → General → Access → Accessible from repositories in the 'Qualio-AI' organization**.
3. **Settings → Actions → General**: allow actions (needed for this repository's own `Test` and `Release` workflows). Under **Workflow permissions**, keep the default read permissions. The `Release` workflow asks for `contents: write` itself.
4. Optional: protect `main` (**Settings → Branches**) and require the `lint`, `fixture`, `missing-folder`, `qualio-source` and `qualio-source-proposed` checks.

### 2. Check that the tests pass

Pushing to `main` runs the **Test** workflow: the node tests, actionlint, the action on `test/fixture` (with `uses: ./`), a run with a missing folder that must fail cleanly, and a heal on `test/heal-fixture` against the stub Qualio API (`test/stub-qualio.mjs`: fail, heal, re-run with the fix, pass). Open **Actions → Test** and make sure it is green before releasing.

### 3. Release a version

Use `vX.Y.Z`: a new minor version (`v1.2.0`) for a feature or a new optional input, a patch (`v1.1.1`) for a fix. With the GitHub CLI, from an up-to-date `main`:

```sh
gh release create v1.2.0 --repo Qualio-AI/qualio-action --target main \
  --title "v1.2.0" --notes "What changed for workflows using @v1."
```

Or in the browser: **Releases → Draft a new release → Choose a tag → type the version → Create new tag on publish**, target `main`, add notes, then **Publish release**.

Publishing the release runs the **Release** workflow, which moves the **`v1`** tag to the same commit. Check it:

```sh
git fetch --tags --force origin
git rev-parse v1.2.0^{commit} v1^{commit}   # both lines must be the same SHA
```

If the workflow can't push the tag (for example, an organization policy forces read-only tokens), or to release without creating a GitHub release, tag and move `v1` by hand:

```sh
git tag v1.2.0 && git push origin v1.2.0
git tag -f v1 v1.2.0 && git push -f origin refs/tags/v1
```

### 4. Optional: list it on the GitHub Marketplace

Listing isn't required for `uses: qualio-ai/qualio-action@v1` to work, but it makes the action discoverable.

Requirements: the repository is public, it has exactly one action metadata file at the root (`action.yml`, as here), and whoever publishes uses **two-factor authentication**. Listings are not reviewed by GitHub and go live straight away.

1. An organization owner accepts the [GitHub Marketplace Developer Agreement](https://docs.github.com/en/actions/sharing-automations/creating-actions/publishing-actions-in-github-marketplace). Until then, the **Publish** checkbox is disabled.
2. The action's `name:` must be unique on the Marketplace, and must not match a Marketplace category, a GitHub feature or another user's or organization's name. If **Qualio E2E** is rejected, change `name:` in `action.yml` (e.g. `Qualio AI E2E Tests`). This doesn't affect `uses:`.
3. When drafting a release, tick **Publish this Action to the GitHub Marketplace**, choose the categories (*Testing*, *Continuous integration*) and publish. The `branding` (icon `check-circle`, colour `purple`) is already set.

### 5. Point Qualio at the published action

`qualio-webapp` already defaults to `qualio-ai/qualio-action@v1`, so no change is needed. To test unreleased changes, set `QUALIO_ACTION_REF` in qualio-webapp's `.env` (e.g. `qualio-ai/qualio-action@my-branch` or a fork). This only affects workflows Qualio generates from then on, because an existing `qualio.yml` is never overwritten.

### 6. Verify end to end from a scratch repository

1. Create a private test repository with a Qualio project connected to it (Part 1, Steps 1–5). The [school demo](https://github.com/Qualio-AI/qualio-school-demo) makes a good target app.
2. Approve a feature, add the workflow from the Getting started page (or merge the setup pull request) and open any pull request.
3. Confirm the **Qualio E2E** check runs, its summary links to the run in Qualio, and the run appears under **Runs**. With *Qualio*, change a button label in the pull request: the summary should show **Heal: patched** and a passing re-run.

### Later releases

1. Merge the changes to `main` and wait for **Test** to pass.
2. Release the next version (step 3). **Release** moves `v1`.
3. **Never break `v1`.** Customers' workflows are never rewritten, so removing or renaming an input, or changing a default's meaning, needs `v2.0.0`. That release creates a `v2` tag automatically, and you then update `QUALIO_ACTION_REF` in qualio-webapp to `@v2`.
4. When you add or rename an input, also update `workflowFile()` / `servedWorkflowFile()` and their tests in qualio-webapp, the in-app Getting Started page and this README.

To withdraw a bad release, move `v1` back to the previous good tag (`git tag -f v1 v1.1.0 && git push -f origin refs/tags/v1`), then mark the bad release as a pre-release or delete it.

---

## Development

- `action.yml`: the composite action. Steps use `shell: bash` and never echo secrets.
- `scripts/qualio.mjs`: the Qualio API calls: `setup` (the first test suite: map, wait, check until ready), `prepare` (the tests folder: snapshot, Qualio's changes on top), `apply` (the fix, after a heal), `wait`, `sync`, `config`, `outbox` (the report, suggestions and Qualio's pull request with the Git data API), `comment`, `errored`. Node 20, no dependencies.
- `scripts/diff.mjs`: line diffs, the lines a pull request's diff shows, and the suggestion comments for a fix.
- `runtime/qualio-reporter.ts`: Qualio's Playwright reporter, a copy of `qualio-webapp/packages/reporter` (`pnpm reporter:sync` there).
- `test/fixture`: a stand-in for a tests folder (`@playwright/test` pinned to the same version as qualio-webapp). `test/heal-fixture`: one whose test fails until Qualio's fix is written on top.
- `test/stub-qualio.mjs`: a stub of Qualio's CI API and of GitHub's REST API (modes: `propose`, `setup`, `outbox`, `report-lost`, `changes`, `move`, `healed`).
- `test/*.test.mjs` (`node --test test/*.test.mjs`): diffs and suggestions, prepare and apply, the outbox (report, suggestions and the Qualio pull request), config.
- `.github/workflows/test.yml`: the node tests, actionlint, the action on the fixture (`uses: ./`), the missing-folder failure path, the heal against the stub (fail, heal, re-run with the fix, pass) and the first-suite setup (map, a failing check, a passing check).
- `.github/workflows/release.yml`: moves the major tag on each published release.

Run the fixture locally:

```sh
cd test/fixture && npm install && npx playwright install chromium
QUALIO_API_URL=http://qualio.test QUALIO_COMMIT_SHA=local E2E_ADMIN_USERNAME=admin@example.test npx playwright test
```

Check a heal locally against the stub (the first run fails, the second passes with the "fix" written on top):

```sh
node test/stub-qualio.mjs 4555 &
export QUALIO_API_URL=http://localhost:4555 QUALIO_API_KEY=qk_stub QUALIO_POLL_MS=200 GITHUB_WORKSPACE=$PWD
node scripts/qualio.mjs prepare demo/x && (cd test/heal-fixture && npm install && QUALIO_RUN_FILE=/tmp/qualio-run.json npx playwright test)
node scripts/qualio.mjs wait /tmp/qualio-run.json 1 && node scripts/qualio.mjs apply test/heal-fixture demo/x
(cd test/heal-fixture && QUALIO_RUN_ROUND=2 npx playwright test) && git checkout -- test/heal-fixture
```

To run the workflows locally, use [act](https://github.com/nektos/act): `act -j fixture`.
