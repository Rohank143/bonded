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
- PR descriptions say what changed, why, how it was tested, and what the founder should check.

## Writing style

- Say "Section 20", never "§20".
- Plain language in docs, commit messages and PR descriptions.

## Engineering

- Payouts and pass/fail are decided by deterministic, on-chain logic. AI output (Claude, Laya) is advisory only.
- Tests go in the same commit as the code they test.
- Keep metrics honest: report held-out numbers and list the assumptions next to them.
