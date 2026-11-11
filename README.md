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

The full setup guide lives in Qualio's docs, at `https://qualio.example.com/docs`. They are public, and when opened from a project they fill in that project's own values. In short:

1. **Create a project** in Qualio and copy its API key (Settings → API keys).
2. **Add the repository secrets** (Settings → Secrets and variables → Actions):
   - `QUALIO_API_KEY`
   - for each test role, `E2E_<ROLE>_USERNAME` and `E2E_<ROLE>_PASSWORD` (`Head teacher` → `E2E_HEAD_TEACHER_*`)

   Qualio never stores test-account credentials: they stay in your secrets and the job's `env`.
3. **Add `.github/workflows/qualio.yml`** in a pull request. The setup wizard's **Create in GitHub** opens GitHub's editor with the file filled in. Start your app in the `e2e` job, before the Qualio step.
4. **Allow GitHub Actions to create pull requests**: repository Settings → Actions → General → Workflow permissions. Qualio delivers new tests and some fixes as its own pull request into your branch.
5. **Push.** The first run maps the app in the job and runs the tests already in the folder `tests.path` names. Qualio reads them into features; nothing is generated.

Optional:
- **The Qualio GitHub App** adds the Qualio E2E check with decision buttons. Its permissions are Metadata (read), and Checks, Commit statuses, Actions and Issues (read and write). It **never** has Contents, Pull requests or Workflows, so it can't read code.
- **Jira Cloud**, connected with OAuth in Settings → Jira. The connected account needs *Browse projects* and *Add comments* in the chosen projects.

Where each topic lives in the docs:

| Topic | Docs page |
| --- | --- |
| The steps, with your values | `/docs/getting-started` |
| Every `config` key, with examples | `/docs/configuration` |
| Jobs, secrets, workflow permissions, inputs, `/qualio` commands | `/docs/workflow` |
| The GitHub App's permissions, branch protection | `/docs/github` |
| Jira permissions and OAuth scopes | `/docs/jira` |
| Verdicts, levels, rules | `/docs/self-healing` |
| Troubleshooting | `/docs/troubleshooting` |

## Part 2: Action reference

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `tests-source` | `''` | **Deprecated and ignored**: the tests always live in the repository (a notice asks to remove it). |
| `working-directory` | `''` | **Deprecated.** The tests folder when the config doesn't set `tests.path` (which wins). Empty uses the project's folder in Qualio (`e2e`). |
| `api-key` | required | The Project API key, from the `QUALIO_API_KEY` secret. If empty, the tests in `working-directory` (or `e2e`) still run but nothing is reported (with a warning). |
| `api-url` | required | The Qualio URL that results are reported to. |
| `base-url` | `''` | The environment under test. Empty uses the target URL in `playwright.config.ts`. |
| `config` | `''` | How Qualio works on this project, as YAML (`version: 1`): `overview` (documents in the repository), `specs.approval`, `mapping` (`start-paths`, `exclude`, `explore`), `roles`, `github` (`target-branch`, `report`) and `jira` (`projects`, `board`, `columns`). Sent to Qualio (`POST /v1/config/sync`) in every job with a checkout; the settings it sets are read-only in Qualio. On a pull request, stricter changes apply to its branch at once and looser ones when it merges. An invalid config fails the job. See [Configuration](#configuration). |
| `config-file` | `''` | A YAML file in the repository with the same config (e.g. `.qualio/config.yml`), instead of `config`. Needs `actions/checkout`. |
| `commit-sha` | PR head SHA, else `github.sha` | The commit the results belong to. |
| `setup-wait-minutes` | `25` | How long mapping the application may take when Qualio asks a job to map it (the first job, or after **Map again**), exploration (`mapping.explore`) included. The tests run after it either way. |
| `heal-wait-minutes` | `10` | How long to wait for Qualio's heal of a failed run before giving up on the re-run. |
| `live-diagnosis` | `true` | While Qualio diagnoses failed tests, let it look at the running app from this job (see *Live diagnosis* below). `false` turns it off. |
| `look-minutes` | `10` | At the end of a job, how long it may keep the running app open for a test chat in Qualio that asked to look at it (see *Live diagnosis* below). `0` turns it off. |
| `node-version` | `20` | The Node.js version. |
| `upload-report` | `true` | Keep Playwright's HTML report as the `playwright-report` artifact. |
| `report-retention-days` | `14` | Days to keep the report artifact. |
| `command` | `test` | `test` runs the tests. `plan` is for the workflow's `plan` job (see *Auto-sharding* below): it tells Qualio about the pull request and the config, lists the tests with Playwright and asks Qualio how many jobs run them (outputs `run`, `shards`, `plan-id`). `comment` is for the workflow's `comment` job (on `issue_comment`): it only tells Qualio about a new pull request comment (`POST /v1/pr/comment`), then posts Qualio's answer. |
| `shard` | | In a sharded workflow's `e2e` job: this job's shard (`${{ matrix.shard }}`). Empty runs every test. |
| `shard-plan` | | In a sharded workflow's `e2e` job: the plan job's `plan-id` output. |
| `reply-wait-minutes` | `3` | With `command: comment`, how long to wait for Qualio's answer before leaving it for the next job. |
| `github-token` | `${{ github.token }}` | Sends Qualio's pull request report (one comment, edited in place), its suggestions and its pull request into your branch, reactions, statuses, labels and re-runs (when Qualio's GitHub App isn't installed or lacks the permission). The workflow needs `permissions` `contents: write` (only Qualio's `qualio/*` branches are pushed), `pull-requests: write`, `issues: write`, `statuses: write` and `actions: write`. Empty sends nothing. |

### Outputs

| Output | Description |
| --- | --- |
| `playwright-version` | The `@playwright/test` version installed in the tests folder. |
| `qualio-run-url` | The run's page in Qualio (the re-run's, after a heal). Empty when the results were not reported. |
| `config-scope` | Where this job's config applied: `project`, `branch` or `none`. Empty without `config`/`config-file`. |
| `map-state` | `mapped` (this job mapped the app), `skipped` (Qualio didn't ask) or `failed` (mapping failed; the job goes on). Empty without an `api-key`. |
| `setup-state` | Deprecated (the first-suite setup is gone): always empty. |
| `run`, `shards`, `plan-id` | With `command: plan`: whether the `e2e` jobs have tests to run, the shards for their matrix as a JSON list (e.g. `[1,2,3]`), and the plan they pass as `shard-plan` (also for a plan of one job; empty only when there is no plan). |
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
            mapping:
              exclude: [/billing]
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
5. **Maps the application** when Qualio asks (`POST /v1/map/start`: the project's first job, or after **Map again**): runs the mapper Qualio sends, then polls `/v1/map/:crawlId/status`, hosting a write-guarded browser while Qualio explores (`mapping.explore`). Never fails the job; up to `setup-wait-minutes` (default 25). Output `map-state`.
6. **Prepares the tests** (`POST /v1/tests/prepare`, `/v1/tests/snapshot`): finds the tests folder (`tests.path`), sends Qualio a snapshot of it (hashes, then the contents Qualio doesn't have; never `node_modules` or Playwright's output; a binary file such as a committed `.xlsx` or PDF only as a short description: its type, size, hash and, for a workbook, its sheets and first rows), and writes the changes Qualio offers on this branch on top of the checkout (never text over a binary file; a test file a person attached in Qualio is written as its bytes) (new tests and verified fixes: they run here before they're committed, and while they wait to be). Nothing is committed. A project whose tests Qualio still kept gets the whole folder until its move pull request is merged.
7. Installs the tests folder's dependencies (`npm ci` with a lockfile, `npm install` otherwise) and Chromium, caching the browser per Playwright version.
8. Runs `npx playwright test` with `QUALIO_API_URL`, `QUALIO_API_KEY`, `QUALIO_BASE_URL`, `QUALIO_COMMIT_SHA`, `QUALIO_RUN_MANIFEST` (the changes it applied) and `QUALIO_REPORTER` (Qualio's reporter, which this action brings: the generated `playwright.config.ts` adds it).
9. If tests fail, waits up to `heal-wait-minutes` for Qualio's verdict (`POST /v1/tests/heal/status`). When Qualio patched the tests, writes the fix on top (`/v1/tests/changes`) and runs them again; the job's result is the re-run's. Real application bugs are never healed, so the job fails. When the verdict is `proposed` (a test problem, or Qualio is less than 85% sure), the job fails with a link: accept the fix in Qualio (it is then checked by the next run and suggested), or mark it as a bug.

**Live diagnosis.** While step 9 waits, Qualio may ask to see pages of your running app, for example to check whether a button was renamed or removed. Qualio never reaches your app; this job does it for Qualio. It starts Playwright MCP (`@playwright/mcp`, pinned, run with `npx`) on the Chromium your tests' Playwright already installed. It opens only the paths Qualio asks for on `base-url`'s origin, signed out or signed in as a role with that role's `E2E_<ROLE>_USERNAME`/`_PASSWORD` secrets. The secrets stay in the job and are passed only to the browser. Each page's accessibility snapshot is sent back, and a page that redirects to another site is not. Before Qualio applies a fix, the job also checks the fix's locators (for example `getByRole('button', { name: 'Log in' })`) on the page they belong on and reports how many elements each finds. A fix whose locators don't find exactly one element is proposed instead of applied. Nothing is clicked or filled in beyond the sign-in, and the browser process gets no other secrets (not `api-key` or `GITHUB_TOKEN`). The job log lists every page shown. Set `live-diagnosis: false` to turn it off.

**Test chat looks.** The chat on a test's page in Qualio can also ask to see the running app, usually after the failed run's job has finished. Qualio then starts this workflow on the test's branch (with the GitHub App; otherwise the next push or `/qualio run` does). At the end of that job, the step *Let Qualio's test chat look at the app* asks Qualio whether a chat is waiting for this branch. If one is, the job hosts the same look-only browser (opens and checks locators, never clicks or types) while the chat uses it, and stops once the chat has been idle for 10 minutes, or after `look-minutes`. When no chat is waiting it makes one request and ends. `live-diagnosis: false` or `look-minutes: 0` turns it off.

**Exploring beyond links** (with `mapping.explore: true` in the config). On the first run, after the map, Qualio may ask this job to click buttons, tabs and menus on mapped pages to find what links can't reach, such as dialogs and tab panels. This happens in a separate browser where every request that could change data is blocked before it leaves the page: non-GET `fetch` and XHR (GraphQL queries are allowed), beacons, and POST form submits. Nothing is saved, deleted or sent. Sign-out, links off `base-url`'s origin and `mapping.exclude` URLs are never clicked. The job log lists every click and every write it blocked. `live-diagnosis: false` turns this off too.
**Auto-sharding.** Workflows Qualio generates since `v1.7.0` have a `plan` job, then an `e2e` job per shard. The plan job lists the tests with `npx playwright test --list` (your config decides testDir, testMatch and projects; Qualio's changes on the branch included) and asks Qualio (`POST /v1/tests/plan`) how to split them. Qualio packs whole files onto jobs by how long they took before, choosing the fewest jobs past which another would save less than a minute (and less than half a job's setup), at most `tests.shards.max` in the config (default 4; `1` keeps one job). Each `e2e` job asks for its files (`POST /v1/tests/plan/shard`) and passes each one to Playwright as its whole absolute path, so no other file matches. Every shard reports into the same run in Qualio, which records it and heals it once every shard has reported; a shard whose tests failed waits for that heal and re-runs its own files with the fix. The first shard maps the app when Qualio asks, and hosts the test chat's look. When Playwright can't list the tests or Qualio can't plan, one job runs every test. A job that can't read its own files fails rather than run another shard's. Older single-job workflows keep working unchanged.
10. Uploads Playwright's HTML report as the `playwright-report` artifact (`playwright-report-shard-<n>` for a shard) and writes a job summary with the result and a link to the run in Qualio. A job that fails before the reporter sent results tells Qualio (`POST /v1/runs/errored`).

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

This repository lives at **[`github.com/Qualio-AI/qualio-action`](https://github.com/Qualio-AI/qualio-action)**. GitHub owner names are case-insensitive, so the `qualio-ai/qualio-action@v1` reference in customers' `qualio.yml` (the default `QUALIO_ACTION_REF` in `qualio-webapp/packages/agents/src/coder/scaffold.ts`) resolves to it. Released so far: `v1.0.0` to `v1.6.0`, with `v1` on `v1.6.0` (mapping instead of a first suite, a team's own tests, the test chat's looks at the app). Since `v1.5.0` the tests live in the repository; releases before it call `/v1/tests/bundle`, which qualio-webapp answers with 410 from phase 49 on.

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
- `scripts/qualio.mjs`: the Qualio API calls: `map` (maps the app when Qualio asks; `setup` is its old name), `prepare` (the tests folder: snapshot, Qualio's changes on top), `apply` (the fix, after a heal), `wait`, `sync`, `config`, `outbox` (the report, suggestions and Qualio's pull request with the Git data API), `comment`, `errored`. Node 20, no dependencies.
- `scripts/diff.mjs`: line diffs, the lines a pull request's diff shows, and the suggestion comments for a fix.
- `runtime/qualio-reporter.ts`: Qualio's Playwright reporter, a copy of `qualio-webapp/packages/reporter` (`pnpm reporter:sync` there).
- `test/fixture`: a stand-in for a tests folder (`@playwright/test` pinned to the same version as qualio-webapp). `test/heal-fixture`: one whose test fails until Qualio's fix is written on top.
- `test/stub-qualio.mjs`: a stub of Qualio's CI API and of GitHub's REST API (modes: `propose`, `map`, `empty`, `outbox`, `report-lost`, `changes`, `move`, `healed`).
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
