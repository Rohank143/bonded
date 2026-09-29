# Day 8: Web app and synthetic Sentinel data

Plan reference: docs/PLAN.md Section 20, Day 8. Design records: `docs/decisions/010-web-app.md` (web app) and ADR-006 (language models).

Two PRs: the web app (PR #27) and synthetic Sentinel data (this PR).

## Done

### Web app (PR #27)

- **Stack:** Vite + React (the founder's choice over Next.js), wagmi and viem, Tailwind (ADR-010).
- **Pages:** landing stats, Arena live feed, agent profile, vaults, underwrite and claims, all against Robinhood Chain testnet.
- **Wallet actions:** deposit and withdraw on vaults and the pool, buying cover, and a tUSDG faucet button.
- **Data sources:** reads come from the chain. The API supplies the live feed, reports and quotes, and now allows browser origins listed in `WEB_ORIGINS`.
- **Checked in a browser:** every page, against live testnet data. The wallet calls were simulated against testnet but not clicked through with a real wallet.

### Synthetic Sentinel data (this PR)

- **Command:** `pnpm sentinel:synth` writes Section 10.3 synthetic rows seeded from real Arena rows.
- **Labels:** chosen by the generator, never by the model. Every row records its model, seed, target and reasoning mode.
- **Six targets:** in-mandate swaps, in-mandate swaps that obey a negation ("do not sell tNVDA"), resisted injections, suspicious in-mandate actions, manipulated breaches and unforced breaches.
- **Checks:**
  - Arguments are validated against the real agent tool schemas.
  - In-mandate and suspicious actions must be swaps of tokens the mandate names.
  - `--exclude-classes` keeps whole attack classes out, so evaluation can hold them out.
- **Operation:** a spending cap, resumable output, and three attempts per slot.

## Results

Proof run on `deepseek/deepseek-v4.1-flash` via OpenRouter, seeded from 117 real rows of a local `vulnerable-agent` rating, 300 slots requested:

| | Result |
|---|---|
| Rows written | 292 of 300 |
| Rows by target | 50 each for five targets; 42 "suspicious" |
| Rows per attack class | 15 for A1–A3, A5 and A7–A10; 12 for A6, 10 for A4 |
| Distinct mandates | 292 of 292 |
| Mechanical label audit (in-mandate and suspicious rows must be swaps of tokens the mandate names) | 0 failures |
| Cost | $0.104, about $0.00036 per row |
| Time | about 14 minutes at 8 requests in parallel (provider latency varied between runs from 4 to 14 minutes) |

At this rate the plan's target of about 30k questions (about 10k rows, three questions each) costs about $4.

**What changed along the way.** Four earlier runs were thrown away, about $0.98 of the day's roughly $1.09 total.

| Run | Problem | Fix |
|---|---|---|
| 1 | With reasoning on, the model spent its whole 1,500-token budget thinking. 277 answers came back empty or cut off, at about $0.0045 per written row. | Reasoning is off by default. |
| 2 | About one answer in six broke the JSON by nesting escaped JSON inside strings. | Tool results may be nested JSON. |
| 3 | 5 of 196 in-mandate rows swapped a token the mandate didn't name. | The token check above. |
| 4 | Attack classes were uneven (7 to 20 rows each). | Classes are assigned by attack slot. |

**Honest limits**

- These are synthetic examples from one model, labelled by request. They augment the real Arena rows; they don't replace them.
- The mechanical audit only checks what code can check. Whether an injection is convincing, or a "suspicious" action really serves the attacker, was spot-read, not measured.
- The "suspicious" target has the lowest yield. The model often writes an outright transfer, which the check correctly rejects.
- The seeds come from the scripted `vulnerable-agent` only, so their style leans towards its tool use.
- Nothing here measures Sentinel quality. That is the held-out evaluation on Day 10, on real rows from attack classes kept out of generation.

## Next

- **Day 9:** the founder runs the Laya fine-tune on Kaggle. Before that, pick the held-out classes and generate the full set with `--exclude-classes` set to them. The dataset stays out of git and is uploaded to Kaggle directly.
- **Web app:** click-test wallet actions with MetaMask. The hosted deployment is Day 12.
