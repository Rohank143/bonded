# Bonded: working rules

Read `docs/PLAN.md` for the product and the 16-day build plan.

## Git workflow

- `main` is the stable branch. Never push work directly to `main`.
- Every piece of work goes on its own branch, then into `main` through a pull request. The founder reviews and merges every PR. Never merge your own PR.
- Open the PR as soon as the work on a branch is pushed. Don't wait to be asked.
- Branch names are short and descriptive: `day-01-scaffold`, `mandate-vault`, `fix-claims-waterfall`.
  - Never prefix a branch with `claude/`.
  - Never use random or auto-generated names (e.g. `inspiring-mayer-qognwt`).
- Don't delete branches unless the founder asks.
- Commit authorship: the founder is the only author. Author and committer are both `ddboy19912 <ddboy19912@gmail.com>` (set with `git config user.name` / `user.email` in the repo). No `Co-Authored-By` or `Claude-Session` trailers in commit messages. Existing commits are not re-authored.
- PR descriptions say what changed, why, how it was tested, and what the founder should check.
- GitHub Actions is currently blocked by an account billing issue. Until that's fixed, run the full pipeline on a fresh clone before opening a PR (format check, typecheck, lint, tests, `forge fmt --check`, `forge test`) and paste the results in the PR description.
- Treat review-bot findings (e.g. CodeRabbit) as bug reports: verify each one, fix what's real, and reply on the thread.

## Writing style

- Say "Section 20", never "§20".
- Plain language in docs, commit messages and PR descriptions.

## Engineering

- Payouts and pass/fail are decided by deterministic, on-chain logic. AI output (Claude, Laya) is advisory only.
- Tests go in the same commit as the code they test.
- Keep metrics honest: report held-out numbers and list the assumptions next to them.
