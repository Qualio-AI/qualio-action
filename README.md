# Qualio Basher action

Runs Qualio on your pull requests from your own GitHub Actions job. Your job starts your app; Qualio:

- links the pull request to the features it names (`SCH-9`, `F-3` in its title, description or branch);
- maps your app and walks the new features' test cases, then writes the Playwright tests their specs describe;
- runs every test (your own and Qualio's) and self-heals the flaky and drifted ones;
- posts one report comment and the `qualio/tests` status on the pull request.

Qualio's agents run at Qualio; **their browsers run in your job**, next to your app, through an outbound WebSocket
(`scripts/host.mjs`). Nothing about your app is public. Test users' passwords stay in your repository's secrets:
Qualio types placeholders such as `{{E2E_ADMIN_PASSWORD}}`, and this job fills them in before they reach the browser.

```yaml
- uses: qualio-ai/qualio-basher-action@v1
  with:
    api-key: ${{ secrets.QUALIO_API_KEY }}
    api-url: https://basher.qualio-ai.com
    base-url: http://localhost:3000
```

Qualio serves the whole workflow under **Settings → How the tests run**. Inputs are in `action.yml`.

## Development

```sh
npm ci
npm test
```

The contract with Qualio (`/v1/pr/sync`, `/v1/runs/start`, `/v1/runs/:id/status`, `/v1/pr/outbox`, the relay) is in
`../qualio-v2/specs/tickets-pull-requests-and-tests.md`; change both together.
