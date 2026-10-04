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

## Founder steps

- **Done:** the Telegram bot exists, and `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set on `api` and `keeper` (checked by name on Railway). The UptimeRobot monitor on the public API is live: HTTP check every 5 minutes, up 100% since it started. It alerts by email, because Telegram is a paid UptimeRobot feature; the services' own alerts cover the Telegram chat.
- **Alerts verified (2026-10-03):** after #74 merged, `api` and `keeper` each posted "Started" to Telegram, and `test-alerts.mjs` on the hosted keeper delivered one sample of every alert. Issue #24 is closed.
- **Vercel deploys from GitHub:** merging #70 to #75 deployed production automatically. Issue #65 is closed.
- **Issue #23** (uptime check) is closed on the founder's call: the monitor is live with email alerts; no forced test alert was sent.

## Review asks

- All Day 13 PRs (#70 to #75) are merged.
- Agree with batching the contract fixes for mainnet rather than redeploying the testnets now, which would change every address and the recorded evidence.

## Next (Day 14)

Demo seeding script, pitch deck, README and docs, opening the bounty board to outside hunters.
