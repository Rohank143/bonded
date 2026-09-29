# Business model and running costs

How Bonded makes money, what it costs to run, and how to keep costs down without weakening ratings. Written on Day 9 (September 29, 2026).

Every figure is labelled as **measured** or **assumed**. Assumptions get replaced with measurements as they arrive: token use per rating after the first model-driven leaderboard ratings (Day 12), and Sentinel escalation rates after the held-out evaluation (Day 10). Prices below are starting points to test with customers, not research.

## 1. What the language models cost

**Measured price.** On Day 8 and 9, synthetic training data on `deepseek/deepseek-v4.1-flash` through OpenRouter cost $1.69 for 3.99M input and 2.26M output tokens. That's about **$0.11 per million input tokens and $0.56 per million output tokens**, from billed usage, not list prices. Figures below use this rate, without prompt caching.

| Job | Usage | Cost | Basis |
|---|---|---|---|
| Synthetic training row | measured | $0.00036 a row | measured (292-row and 4,728-row runs) |
| Agent's model during a rating | 40k input and 5k output tokens per episode | $0.008 an episode: $0.33 for a 42-episode rating, $1.89 for 240 | assumed (ADR-006) |
| Adaptive attacker | 40 follow-ups × 3k input and 1k output tokens | about $0.04 a rating | assumed (ADR-006) |
| Grey-area judge | ~4k input and 0.3k output tokens per episode | about $0.15 per 240 episodes | assumed |
| Sentinel on an LLM (instead of Laya) | 2 questions × ~2.5k input tokens per agent action | $0.0006 an action | assumed |
| Hosted services today | scripted agents only | $0 | measured |

### Hackathon budget (Days 9 to 15)

| Item | Estimate |
|---|---|
| Finish the Sentinel training set (5,272 more rows) | $1.90 |
| Leaderboard: about 12 ratings of real agents on a model | $4 (42 episodes each) to $25 (240 each) |
| Day 10 comparison, Sentinel on an LLM against Laya | about $0.50 |
| Retries and demo runs | about $5 |
| **Total** | **about $12 to $35** |

Keep development and production on separate OpenRouter keys, each with a credit limit. The Day 9 generation stopped when the account ran out of credit (HTTP 402).

### At scale

Assumptions:
- each insured agent is re-rated monthly (240 episodes), because scores expire after 30 days;
- two new bounty attacks a month are re-run across all insured agents;
- each agent takes 200 actions a day, every one checked by Sentinel.

| Monthly model cost | 100 agents | 1,000 agents | 10,000 agents |
|---|---|---|---|
| A. Operators' agents run on their own model; Bonded pays for the attacker and judge | ~$20 | ~$200 | ~$2,000 |
| B. Bonded also runs the agent's model during ratings | ~$220 | ~$2,200 | ~$22,000 |
| C. Sentinel on an LLM instead of Laya (adds to A or B) | +$370 | +$3,700 | +$37,000 |

Ratings are cheap per agent. Sentinel on an LLM is the cost that grows with use, so Sentinel runs on Laya (Section 2, lever 1).

## 2. Cutting cost without weakening ratings

**Rule:** spend where it changes the score, never where a cheaper path gives the same answer.

**How a lever is adopted:** it has to pass a fixed benchmark first. The benchmark is the held-out Sentinel set (real A7 and A10 episodes plus controls) and a few reference agents rated before and after. A lever is adopted only if scores and detection rates stay within a tolerance set before the test.

| # | Lever | Expected saving | Why ratings don't get worse | Status |
|---|---|---|---|---|
| 1 | **Sentinel cascade:** Laya answers every check; only checks in a low-confidence band go to an LLM | ~95% of line C, if about 5% of checks escalate (assumed) | Laya is trained for calibrated confidence, which decides escalation; the Day 10 evaluation measures it | [Issue #32](https://github.com/ddboy19912/bonded/issues/32), Day 10 |
| 2 | **Black-box ratings:** the operator's agent runs on its own model; Bonded supplies attacks and judging (plan Section 4.2, step 3) | Line B becomes line A, about 10× | Same test. A hosted brain is billed at cost plus margin. | Plan design; SDK and adapters on Day 12 |
| 3 | **On-chain verdict first:** the grey-area judge runs only where the chain can't see, e.g. no breach but injected content in the inputs | ~60–70% of judge calls (assumed) | Payouts never depend on the LLM judge | [Issue #33](https://github.com/ddboy19912/bonded/issues/33), when the judge is built |
| 4 | **Stop when the result is decided:** stop a class once its upper credible bound can't change the tier | ~30–50% of episodes (assumed) | Fewer episodes widen the bound, which is conservative. Stop only when the tier can't change. | [Issue #34](https://github.com/ddboy19912/bonded/issues/34), Day 13 |
| 5 | **Re-rate what changed:** new attacks re-run alone across the book; the monthly refresh samples; a full re-rate on any code or model change | Most re-rating cost | The attestation ties a score to the code hash | [Issue #35](https://github.com/ddboy19912/bonded/issues/35), after Gate 2 |
| 6 | **Prompt caching and tight token limits** | Most of the input cost (to be measured) | Same prompts, same answers | [Issue #36](https://github.com/ddboy19912/bonded/issues/36), with the first model-driven ratings |
| 7 | **Choose the model per job by measurement:** cheapest for synthetic data and typical-agent play; stronger only for the attacker | Spend goes where it matters | A stronger attacker is kept only if it finds more breaches on the benchmark | Ongoing (ADR-006) |
| 8 | **Spending controls:** per-key credit limits, per-run caps, per-customer quotas | Prevents surprise bills | No effect on ratings | Per-run caps built (Day 6); key limits are a founder setting; quotas with billing |

With levers 1 to 3, the 1,000-agent cost falls from about $5,900 a month (lines B and C) to roughly **$250–400**.

## 3. How Bonded makes money

Plan Section 4.1 names who pays; Section 18.5 sets the legal shape: a rating service plus parametric protection first, and regulated cover later through a licensed carrier.

| Revenue | Who pays | How it works | Status |
|---|---|---|---|
| **1. Share of premiums** | Vault depositors, through premiums | 15% of every premium goes to the treasury; 80% to underwriters, 5% to bounties. It grows with cover written. | In the contracts (`CoverManager` fee split) |
| **2. Rating subscriptions** | Operators | Free public scores for open-source agents (the leaderboard). Paid: private ratings, the monthly refresh, the "Bonded-Rated" badge and breach alerts; start around $49–499 a month by agent size (to test). | Pricing to test after the hackathon |
| **3. Score and risk-data API** | Platforms: exchanges, DeFi protocols, x402 merchants, Robinhood | On-chain score reads stay free. Paid: API volume, score-change webhooks, history. | Plan Section 19, month 6+ |
| **4. Sentinel guard** | Operators | Per agent or per thousand checks. Sentinel lowers the breach rate and so the premium (plan Section 10.3), so customers can pay from the saving. Laya's cost is close to fixed, so margin grows with use. | Service on Day 10 |
| Later: enterprise Arena, reinsurance | Funds, exchanges, carriers | Private red-teaming engagements; larger limits through reinsurers (plan Section 19) | Month 6+ |

**The loop:** free leaderboard scores bring operators in. Ratings earn subscriptions, cover earns the premium share, and Sentinel lowers premiums and earns its own fee. Platforms that require ratings bring in more operators.

**Bounties are a cost, not revenue.** They are funded from the 5% bounty share and keep the attack library fresh, which is what keeps ratings honest.

### Unit economics of one insured agent (assumed)

Uses the Gate 1 testnet policy as the example: $20,000 cover at 4.34% a year.

| Line | Per month |
|---|---|
| Premium | $72.33 |
| Protocol share (15%) | $10.85 |
| Rating subscription (example tier) | $99 |
| Model cost with levers 1 to 3 | about $0.25–0.40 |
| Hosting share (Railway today: about $3 a month in total, estimated from live resource use on Day 7) | cents |

The protocol keeps fees; underwriting losses fall on the operator's bond and the pool. Rating quality is therefore the business: scores that underprice risk become pool losses, and underwriters leave. None of the cost levers may make ratings less conservative.

## 4. Before charging real money

- **Legal:** follow Section 18.5 (rating service plus parametric protection; regulated cover through a licensed carrier later). Get legal advice in each market before selling cover or protection for real money, even though payouts are parametric and decided on chain.
- **Audits:** the EVM contracts and the Solana programs are unaudited. Plan Section 25 and Day 13 hardening come first.
- **Honest metrics:** Sentinel's quality claims come only from held-out evaluation (Day 10), and rating accuracy needs the held-out attack source in issue #11 before real cover is priced.
