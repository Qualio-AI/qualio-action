# qualio: your features' E2E tests, from the terminal

`@qualio-ai/cli` asks [Qualio AI](https://qualio-ai.com) for a feature's Playwright tests while you work on
it. Qualio writes them into your checkout, runs them against your app on your machine, and heals what
drifted. The tests are left uncommitted, for you to review and commit.

```sh
npm install -g @qualio-ai/cli
qualio login --key qk_…          # your project's API key (Qualio → Settings → API keys)

qualio generate SCH-42           # a feature, ticket or Jira issue key
qualio generate --describe "Teachers can archive a class"
qualio run                       # run the tests folder here, report to Qualio, heal failures
```

Run it inside your repository, with your app running at qualio.yml's `app.url` (or pass `--base-url`).
The Analyst's questions are asked in your terminal (`--yes` takes its recommended answers).

**What leaves your machine:** your tests folder (only the files Qualio doesn't have yet), your answers,
your branch's name and commit, and the test results. Never your application's code, and never a password:
the `${ADMIN_PASSWORD}` variables of qualio.yml's users are read from your shell or `.qualio/.env` (add it to
`.gitignore`). Qualio never connects to your app; while it diagnoses a failure it may look at pages through
a browser the CLI runs here (`QUALIO_LIVE_DIAGNOSIS=false` turns that off).

Your local work never shows on pull requests or the baseline, sets no status on GitHub and notifies
nobody. Once you commit and push the tests, your pull request runs them in CI like any other.

Full guide: <https://app.qualio-ai.com/docs/cli>. `qualio --help` lists every option.
