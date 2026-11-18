# Qualio action

Runs Qualio on your pull requests from your own GitHub Actions job. Your job starts your app; Qualio:

- links the pull request to the features it names (`SCH-9`, `F-3` in its title, description or branch);
- maps your app and walks the new features' test cases, then writes the Playwright tests their specs describe;
- runs every test in this job, next to your app: Qualio's (downloaded for the run into a temporary folder, never your
  checkout, and deleted after) and your own; every test runs in parallel, and with `shard` a matrix of jobs splits them;
- self-heals the flaky and drifted ones;
- posts one report comment and the `qualio/tests` status on the pull request.

Qualio's agents run at Qualio; **their browsers run in your job**, next to your app, through an outbound WebSocket
(`scripts/host.mjs`). Nothing about your app is public. Test users' passwords stay in your repository's secrets:
Qualio types placeholders such as `{{E2E_ADMIN_PASSWORD}}`, and this job fills them in before they reach the browser.

```yaml
- uses: qualio-ai/qualio-action@v2
  with:
    api-key: ${{ secrets.QUALIO_API_KEY }}
    api-url: https://app.qualio-ai.com
    base-url: http://localhost:3000
```

Qualio serves the whole workflow under **Settings → How the tests run**. Inputs are in `action.yml`. To split the
tests across jobs, choose how many there (*Split the tests across*): the served workflow gets a matrix and passes
`shard: ${{ matrix.shard }}/<n>`. Shard 1 leads the run (it tells Qualio about the pull request, lends the browsers
and posts the report); the others only run their part of the tests.

## Development

```sh
npm ci
npm test
```

The contract with Qualio (`/v1/pr/sync`, `/v1/runs/start`, `/v1/runs/:id/status`, `/tests`, `/results`, `/evidence`,
`/v1/pr/outbox`, the relay) is in `../qualio-v2/specs/tickets-pull-requests-and-tests.md` and
`../qualio-v2/specs/regression-exploratory-and-bug-bash.md` (Tests run in the job); change both together.
