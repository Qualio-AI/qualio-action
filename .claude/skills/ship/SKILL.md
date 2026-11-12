---
name: ship
description: Put the current change up for review - make sure it is on its own branch (never main), commit it, run the checks, push the branch and open a GitHub pull request. Use when the user says ship it, open a PR, put this up for review, or a phase is finished.
---

# Ship: branch → commit → checks → push → pull request

Changes may go straight to `main`: committing, merging and pushing to `main` are allowed. Use a branch and a pull request when the user wants a review. Never force-push a shared branch or delete a remote branch without asking.

Do these in order, in each repository the change touched (`git -C <repo>` or `cd <repo>`):

1. **Branch.** When the user wants a review, work on a branch: if `git branch --show-current` is `main`, create one from the work in progress: `git switch -c <type>/<short-desc>` (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`; a roadmap phase is `feat/phase-<n>-<slug>`). Uncommitted changes come along. If the branch already has a pull request (`gh pr view --json url,state`), keep using it.
2. **Review what goes in.** `git status` and `git diff`. Stage only files that belong to this change, by name (no `git add -A` of unrelated work; never `.env*` or secrets). If the working tree mixes several unrelated changes, ask the user how to split them.
3. **Checks.** Run the repository's checks and fix failures before going on. For `qualio-webapp`: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:e2e` when the change touches UI, routes or flows (check ports 3000/3001/3100 first: a running `pnpm dev` invalidates the E2E run). For the other repositories, what their `package.json`/README says. Report honestly what ran and what failed.
4. **Commit.** Small logical commits with a clear message (`<type>: <what and why>`; a phase: `Phase N: ...`), ending with the attribution lines the session asks for.
5. **Push.** `git push -u origin <branch>`.
6. **Pull request.** `gh pr create --base main --title "<title>" --body "<body>"` with: Summary (what and why, a few bullets), Changes by area, Test plan (the checks that ran and their result, what to try by hand), and, for a change across repositories, links to the sibling pull requests. End the body with the attribution line the session asks for.
7. **Review and merge.** Offer to run `/code-review` on the pull request (`--comment` posts findings on it). Merge it (`gh pr merge`) when the user asks, or commit and push straight to `main` when they want no pull request.
