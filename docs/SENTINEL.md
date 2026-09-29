# Sentinel: how it works, end to end

Sentinel is Bonded's real-time guard: a fine-tuned Laya model that checks each trade an agent proposes before it runs. This is the short version. Details are in plan Section 10, the Kaggle guide (`services/sentinel/kaggle/README.md`) and `docs/BUSINESS.md`.

## The flow

**1. Make training data.** Arena attacks and synthetic examples become labelled questions, such as "is this action manipulated?". `pnpm sentinel:synth` writes the synthetic examples and `pnpm sentinel:dataset` builds the training files. Attack classes A7 and A10 are kept out, so they can test it later.

**2. Train (on Kaggle, free).** Upload the files, run Laya's own notebook for about 4 to 5 hours on Kaggle's free GPUs, and save the result to a private Hugging Face repo.

**3. Host it on Railway.** It runs as one more small service next to the API, keeper and worker. On startup it downloads the private model with a Hugging Face read token stored in Railway. It answers over Railway's private network, so agent data never leaves our infrastructure. It starts on CPU; plan Section 10.4 says CPU is fine for the demo.

**4. Check every trade.** Before an agent's trade goes through:

```
agent wants to trade → Sentinel checks it (about 0.3 s on CPU, to be measured)
   ├─ looks fine        → trade goes ahead
   ├─ looks manipulated → trade blocked, vault owner alerted
   └─ unsure            → a cheap LLM double-checks (issue #32)
```

**5. Prove it works.** Test it on real episodes from attack classes it never saw (A7, A10), then re-rate agents with Sentinel on. If breaches drop, premiums drop: the discount is earned, not asserted.

**6. Keep it fresh.** When new attacks appear, add them to the data and retrain. The new model goes live only if it scores at least as well as the old one.

**Safety rule.** Sentinel only advises and blocks suspicious trades. Payouts are decided by the vault's on-chain breach log, so a wrong Sentinel answer can never cause a wrongful payout.

## When to retrain

A retrain costs almost nothing: a free Kaggle run plus about $4 of synthetic data. The limit is evaluation, not money, so retrain on triggers:

| Trigger | Why |
|---|---|
| A new attack class, or several new variants (bounties, incidents) | Sentinel only knows attacks it has seen |
| Misses: a breach Sentinel let through, or false alarms | Direct evidence it is out of date |
| Calibration drifts on recent labelled rows | Its confidence decides what goes to the LLM (issue #32) |
| A new Laya base release | Only if it measures better on our held-out set |

Expect one retrain now, perhaps one after Day 10, then about monthly in early production.

Every retrain must:
- pass the held-out evaluation;
- keep the previous model for rollback;
- trigger an Arena re-run, because Sentinel changes premiums.

When a held-out class has to join training, choose new held-out classes first (issue #11), or the evaluation stops being honest.

## Where to host it

| Option | Per month, always on | Verdict |
|---|---|---|
| Railway, CPU | roughly $5–15 at demo traffic, $50–150 for two replicas later (estimates) | **Now.** Same private network and bill as the other services |
| Hugging Face endpoint, CPU | from about $22 (1 vCPU / 2 GB, likely too small for a 421M-parameter model) | Similar cost; agent data goes to a third party |
| Hugging Face endpoint, T4 GPU | about $365 | Only when latency or volume need it; keep one replica always on |
| Scale to zero | $0 idle | Not for the live guard: after idling, a replica needs time to start and returns errors meanwhile. Fine for batch evaluation. |
| LLM for every check (no Laya) | about $3,700 at 1,000 agents | What Laya replaces |

Prices are from Hugging Face's pricing page on September 29, 2026. Laya's CPU latency on these sizes hasn't been measured yet; Day 10 measures it before hosting is final.
