# Day 13: hardening

Plan reference: docs/PLAN.md Section 20, Day 13, and the "Day 13 detail" table (PR #68). Done when: no high-severity findings open; all suites green; `docs/AUDIT.md` written; a test alert reaches Telegram.

## Done

| # | Workstream | PR | Result |
|---|---|---|---|
| 1 | Invariant tests | [#70](https://github.com/ddboy19912/bonded/pull/70) | 16 handler-based invariants and an inflation fuzz test over CoverPool, CoverManager, ClaimsEngine, OperatorBond, MandateVault (ERC-4626) and BountyBoard. Pass at the CI profile and a 1,000-run stress run. A mutation script plants 11 known bugs: all 11 caught |
| 2–3 | Static analysis, security review, audit note | [#72](https://github.com/ddboy19912/bonded/pull/72) | Slither: 0 high, 12 medium, all triaged. Clippy: 0 warnings. `docs/AUDIT.md`: 9 findings, **none high**. Two fixed in the PR (rate limit on the public bounty reveal, leaderboard cache) |
| 4 | Bounty self-accept | [#71](https://github.com/ddboy19912/bonded/pull/71) | The worker rejects submissions from attesters without running them; tested both ways. Contract check batched for the next deployment |
| 5 | Web polish and error states | [#73](https://github.com/ddboy19912/bonded/pull/73) | Bug bash on the hosted site: console 404s on non-TEE agents, unknown agents shown as unrated, wrong messages when the RPC is down, pages stuck on "…". All fixed, with web tests. Phone width was already fine |
| 6 | Uptime check and Telegram alerts | [#74](https://github.com/ddboy19912/bonded/pull/74) | Crash, failing-loop, keeper-lag, stuck-claim and failed-job alerts, rate-limited and redacted; UptimeRobot setup documented |

Every PR has the full fresh-clone pipeline in its description.

## Findings worth knowing

- **The fuzz tests found one real edge case** (audit F-07): after a 10M donation to an empty vault, a 1 tUSDG deposit rounds to 0 shares. The attacker loses about half the donation, so the attack never pays, but the small depositor loses their deposit.
- **A claim paid during an agent's own call reduces the loss recorded for that call** (F-03). Unlikely (needs a compromised agent, an unclaimed earlier breach and a guardian unfreeze before the keeper files), so it is accepted for testnet.
- **One EOA owns every contract** (F-02). The plan's Section 17 says multisig; that is the mainnet target, listed in #67.
- **Redeploy decision:** no finding forced one. The open contract fixes (F-01's check, F-03, F-06, F-07) are batched for the mainnet deployment and listed on [issue #67](https://github.com/ddboy19912/bonded/issues/67).

## Not done (founder steps)

- **Telegram bot and secrets** (plan items 13 and 14): create the bot, find the chat id with `apps/api/scripts/telegram-chat-id.mjs`, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` on `api` and `keeper`, then run `test-alerts.mjs` on the keeper. Steps in docs/SERVICES.md and PR #74. The "test alert reaches Telegram" check is met after this.
- **UptimeRobot monitor** on `/health` (docs/SERVICES.md, "Uptime check").
- **Web deploy:** after #73 merges, `vercel --prod` from a clean clone of `main` (issue #65).

## Review asks

- Merge order: #70, #71, #72, #73, #74 are independent and can merge in any order.
- Agree with batching the contract fixes for mainnet rather than redeploying the testnets two days before submission.

## Next (Day 14)

Demo seeding script, pitch deck, README and docs, opening the bounty board to outside hunters.
