# Day 9: Laya fine-tuning data and Solana programs

Plan reference: docs/PLAN.md Section 20, Day 9. Design records: ADR-011 (Solana programs); `services/sentinel/kaggle/README.md` (fine-tuning).

## Done

### Laya fine-tuning (PR #30)

- **`pnpm sentinel:dataset`:** turns real Arena rows and synthetic rows into the format of Laya's reference dataset, which Laya's own Kaggle notebook reads.
- **Held out:** the test split holds only real rows from A7 and A10 (`SENTINEL_HELD_OUT_CLASSES`), plus control episodes.
- **Kaggle guide:** the four edits to Laya's notebook, each checked against its source: pinned `laya==0.3.21` and base revision `55cf4c4`, our data files, and a private Hugging Face repo.
- **Synthetic set, stopped early:** generation reached **4,728 rows** (about 14,200 questions) with A7 and A10 excluded, for **$1.69**. It stopped because the OpenRouter account ran out of credits (HTTP 402), not because of a problem with the data. The plan's target is about 30k questions; the rest resumes when credits are added.

### Solana programs (this PR)

An Anchor 1.x workspace in `contracts/solana`, mirroring the EVM design (ADR-011):

| Program | What it does |
|---|---|
| `bonded_registry` | Agents owned by their operator. Scores are accepted only with the attester's Ed25519 signature over exactly their bytes, checked through the instructions sysvar. Versions must increase. |
| `bonded_vault` | Checks every agent call before running it: T1 target allowlist, T1 SPL transfers only to vault-owned accounts, T1 no approvals, T2 per-call outflow limit. Keeps a breach log and freezes on a breach. Enforce mode blocks the call. |
| `bonded_cover` | Pool with a share mint, operator bonds tied to registry ownership, cover bound with an attester-signed quote by the guardian, and permissionless claims paid bond first, then pool, less a 10% deductible. |

- **Builds:** all three build for the Solana VM, with IDLs.
- **Tests:** 8 pass, LiteSVM with the Ed25519 precompile against the built programs.
  - 4 end-to-end tests, including every refusal listed in ADR-011.
  - 4 unit tests of the signature checks.
- **Simplifications for Day 9,** listed in ADR-011 section 5: upfront premium, no withdrawal cooldown, pool-wide cap only, no T3.

## Done when

- **"Anchor programs compile":** met.
- **"Fine-tuned checkpoint pushed (private)":** not yet. It's the founder's Kaggle run, waiting on the dataset: either add about $3 of OpenRouter credit to finish the synthetic set, or start with the 4,728 rows.

## Next (Day 10)

- **Solana:** devnet deploy, streamed premiums and the other ADR-011 simplifications, and keeper and SDK support.
- **Sentinel:** the service, Laya adapter (issue #12), held-out evaluation and the Arena re-run with Sentinel on. The evaluation first needs more real A7 and A10 episodes; local scripted ratings are free.
